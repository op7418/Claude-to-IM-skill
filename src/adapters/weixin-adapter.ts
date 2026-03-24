import type {
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import {
  getWeixinAccount,
  getWeixinContextToken,
  listWeixinAccounts,
  upsertWeixinContextToken,
} from '../weixin-store.js';
import { getConfig, getUpdates, sendTextMessage, sendTyping } from './weixin/weixin-api.js';
import { decodeWeixinChatId, encodeWeixinChatId } from './weixin/weixin-ids.js';
import { downloadMediaFromItem } from './weixin/weixin-media.js';
import { clearAllPauses, isPaused, setPaused } from './weixin/weixin-session-guard.js';
import type {
  GetUpdatesResponse,
  WeixinCredentials,
  WeixinMessage,
} from './weixin/weixin-types.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  ERRCODE_SESSION_EXPIRED,
  MessageItemType,
  TypingStatus,
} from './weixin/weixin-types.js';

const DEDUP_MAX = 500;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export class WeixinAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'weixin';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private pollAborts = new Map<string, AbortController>();
  private seenMessageIds = new Map<string, Set<string>>();
  private consecutiveFailures = new Map<string, number>();
  private typingTickets = new Map<string, string>();
  private pendingCursors = new Map<number, {
    offsetKey: string;
    cursor: string;
    remaining: number;
    sealed: boolean;
  }>();
  private nextBatchId = 1;

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    clearAllPauses();

    const linkedAccounts = listWeixinAccounts().filter((account) => account.enabled && account.token);
    if (linkedAccounts.length === 0) {
      console.log('[weixin-adapter] No linked WeChat account is enabled, adapter started but idle');
    }

    for (const account of linkedAccounts) {
      this.startAccountWorker(account.accountId, this.accountToCreds(account));
    }

    if (linkedAccounts.length > 0) {
      console.log(`[weixin-adapter] Started in single-account mode with ${linkedAccounts[0].accountId}`);
    }
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    for (const controller of this.pollAborts.values()) {
      controller.abort();
    }

    this.pollAborts.clear();
    this.pendingCursors.clear();
    this.seenMessageIds.clear();
    this.consecutiveFailures.clear();
    this.typingTickets.clear();
    this.queue = [];

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    console.log('[weixin-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (!this._running) {
      return null;
    }
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const decoded = decodeWeixinChatId(message.address.chatId);
      if (!decoded) {
        return { ok: false, error: 'Invalid WeChat chatId format' };
      }

      const { accountId, peerUserId } = decoded;
      const account = getWeixinAccount(accountId);
      if (!account) {
        return { ok: false, error: `Linked WeChat account ${accountId} not found` };
      }

      const contextToken = getWeixinContextToken(accountId, peerUserId);
      if (!contextToken) {
        return { ok: false, error: `No context token for peer ${peerUserId} on account ${accountId}` };
      }

      const content = stripFormatting(message.text, message.parseMode);
      const { clientId } = await sendTextMessage(
        this.accountToCreds(account),
        peerUserId,
        content,
        contextToken,
      );

      return { ok: true, messageId: clientId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  validateConfig(): string | null {
    const linkedAccounts = listWeixinAccounts().filter((account) => account.enabled && account.token);
    if (linkedAccounts.length === 0) {
      return 'No linked WeChat account. Run the WeChat QR login helper first.';
    }
    return null;
  }

  isAuthorized(_userId: string, _chatId: string): boolean {
    return true;
  }

  acknowledgeUpdate(updateId: number): void {
    const batch = this.pendingCursors.get(updateId);
    if (!batch) return;
    batch.remaining = Math.max(0, batch.remaining - 1);
    this.maybeCommitPendingCursor(updateId);
  }

  onMessageStart(chatId: string): void {
    this.sendTypingIndicator(chatId, TypingStatus.TYPING).catch(() => {});
  }

  onMessageEnd(chatId: string): void {
    this.sendTypingIndicator(chatId, TypingStatus.CANCEL).catch(() => {});
  }

  private enqueue(message: InboundMessage): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  private startAccountWorker(accountId: string, creds: WeixinCredentials): void {
    const controller = new AbortController();
    this.pollAborts.set(accountId, controller);
    this.seenMessageIds.set(accountId, new Set());
    this.consecutiveFailures.set(accountId, 0);
    void this.runPollLoop(accountId, creds, controller.signal);
  }

  private async runPollLoop(accountId: string, creds: WeixinCredentials, signal: AbortSignal): Promise<void> {
    console.log(`[weixin-adapter] Poll loop started for account ${accountId}`);

    while (this._running && !signal.aborted) {
      if (isPaused(accountId)) {
        await this.sleep(10_000, signal);
        continue;
      }

      try {
        const { store } = getBridgeContext();
        const offsetKey = `weixin:${accountId}`;
        const rawOffset = store.getChannelOffset(offsetKey);
        const cursor = rawOffset === '0' ? '' : rawOffset;
        const response: GetUpdatesResponse = await getUpdates(creds, cursor);

        if (response.errcode === ERRCODE_SESSION_EXPIRED) {
          setPaused(accountId, 'Session expired (errcode -14)');
          console.warn(`[weixin-adapter] Account ${accountId} session expired, pausing`);
          continue;
        }
        if (response.errcode && response.errcode !== 0) {
          throw new Error(`API error: ${response.errcode} ${response.errmsg || ''}`.trim());
        }

        let batchId: number | undefined;
        let batchCompleted = false;

        if (response.msgs && response.msgs.length > 0 && response.get_updates_buf) {
          batchId = this.nextBatchId++;
          this.pendingCursors.set(batchId, {
            offsetKey,
            cursor: response.get_updates_buf,
            remaining: 0,
            sealed: false,
          });

          for (const message of response.msgs) {
            await this.processMessage(accountId, message, batchId);
          }
          batchCompleted = true;
        } else if (response.msgs && response.msgs.length > 0) {
          for (const message of response.msgs) {
            await this.processMessage(accountId, message);
          }
        }

        if (batchId !== undefined && response.get_updates_buf) {
          const batch = this.pendingCursors.get(batchId);
          if (batchCompleted && batch) {
            batch.sealed = true;
            this.maybeCommitPendingCursor(batchId);
          } else if (!batchCompleted) {
            this.pendingCursors.delete(batchId);
          }
        }

        this.consecutiveFailures.set(accountId, 0);
      } catch (err) {
        if (signal.aborted) break;

        const failures = (this.consecutiveFailures.get(accountId) || 0) + 1;
        this.consecutiveFailures.set(accountId, failures);
        const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);

        console.error(
          `[weixin-adapter] Poll error for ${accountId} (failure ${failures}):`,
          err instanceof Error ? err.message : err,
        );
        await this.sleep(backoff, signal);
      }
    }

    console.log(`[weixin-adapter] Poll loop ended for account ${accountId}`);
  }

  private async processMessage(accountId: string, message: WeixinMessage, batchId?: number): Promise<void> {
    if (!message.from_user_id) return;

    const messageKey = message.message_id || `seq_${message.seq}`;
    const seenIds = this.seenMessageIds.get(accountId);
    if (seenIds?.has(messageKey)) {
      return;
    }

    seenIds?.add(messageKey);
    if (seenIds && seenIds.size > DEDUP_MAX) {
      const overflow = Array.from(seenIds).slice(0, seenIds.size - DEDUP_MAX);
      for (const staleKey of overflow) {
        seenIds.delete(staleKey);
      }
    }

    if (message.context_token) {
      upsertWeixinContextToken(accountId, message.from_user_id, message.context_token);
    }

    let text = '';
    const attachments: FileAttachment[] = [];
    let failedCount = 0;
    let missingVoiceTranscriptCount = 0;
    const mediaEnabled = getBridgeContext().store.getSetting('bridge_weixin_media_enabled') === 'true';
    const account = mediaEnabled ? getWeixinAccount(accountId) : undefined;
    const creds = account ? this.accountToCreds(account) : undefined;

    for (const item of message.item_list || []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        text += item.text_item.text;
        continue;
      }

      if (item.type === MessageItemType.VOICE) {
        const transcript = item.voice_item?.text?.trim();
        if (transcript) {
          text = text.trim() ? `${text}\n${transcript}` : transcript;
        } else {
          missingVoiceTranscriptCount++;
        }
        continue;
      }

      if (!mediaEnabled || !creds) {
        continue;
      }

      try {
        const attachment = await downloadMediaFromItem(item, creds.cdnBaseUrl);
        if (attachment) {
          attachments.push(attachment);
        }
      } catch (err) {
        failedCount++;
        console.warn(
          `[weixin-adapter] Failed to download media for ${accountId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (message.ref_message) {
      const quoted: string[] = [];
      if (message.ref_message.title) quoted.push(message.ref_message.title);
      if (message.ref_message.content) quoted.push(message.ref_message.content);
      if (quoted.length > 0) {
        text = `[引用: ${quoted.join(' | ')}]\n${text}`;
      }
    }

    if (failedCount > 0) {
      const failureNote = `[${failedCount} attachment(s) failed to download]`;
      text = text.trim() ? `${text}\n${failureNote}` : (attachments.length > 0 ? failureNote : text);
    }

    const chatId = encodeWeixinChatId(accountId, message.from_user_id);
    const inbound: InboundMessage = {
      messageId: message.message_id || `weixin_${accountId}_${message.seq || Date.now()}`,
      address: {
        channelType: 'weixin',
        chatId,
        userId: message.from_user_id,
        displayName: message.from_user_id.slice(0, 12),
      },
      text: text.trim(),
      timestamp: message.create_time ? message.create_time * 1000 : Date.now(),
      raw: failedCount > 0 && attachments.length === 0 && !text.trim()
        ? {
            accountId,
            originalMessage: message,
            attachmentDownloadFailed: true,
            failedCount,
            failedLabel: 'attachment(s)',
          }
        : missingVoiceTranscriptCount > 0 && attachments.length === 0 && !text.trim()
          ? {
              accountId,
              originalMessage: message,
              userVisibleError: 'WeChat did not provide speech-to-text for this voice message. Please enable WeChat voice transcription and send it again.',
            }
          : { accountId, originalMessage: message },
      updateId: batchId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    if (!inbound.text && attachments.length === 0 && failedCount === 0 && missingVoiceTranscriptCount === 0) {
      return;
    }

    if (batchId !== undefined) {
      const batch = this.pendingCursors.get(batchId);
      if (batch) batch.remaining++;
    }
    this.enqueue(inbound);

    const summary = attachments.length > 0
      ? `[${attachments.length} attachment(s)] ${inbound.text.slice(0, 150)}`
      : missingVoiceTranscriptCount > 0 && !inbound.text
        ? '[voice transcription unavailable]'
      : failedCount > 0 && !inbound.text
        ? `[${failedCount} attachment(s) failed]`
        : inbound.text.slice(0, 200);
    getBridgeContext().store.insertAuditLog({
      channelType: 'weixin',
      chatId,
      direction: 'inbound',
      messageId: inbound.messageId,
      summary,
    });
  }

  private async sendTypingIndicator(chatId: string, status: number): Promise<void> {
    const decoded = decodeWeixinChatId(chatId);
    if (!decoded) return;

    const { accountId, peerUserId } = decoded;
    const account = getWeixinAccount(accountId);
    if (!account) return;

    const contextToken = getWeixinContextToken(accountId, peerUserId);
    if (!contextToken) return;

    const creds = this.accountToCreds(account);
    const ticketKey = `${accountId}:${peerUserId}`;
    let typingTicket = this.typingTickets.get(ticketKey);
    if (!typingTicket) {
      const config = await getConfig(creds, peerUserId, contextToken);
      if (!config.typing_ticket) return;
      typingTicket = config.typing_ticket;
      this.typingTickets.set(ticketKey, typingTicket);
    }

    await sendTyping(creds, peerUserId, typingTicket, status);
  }

  private accountToCreds(account: {
    accountId: string;
    token: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
  }): WeixinCredentials {
    return {
      botToken: account.token,
      ilinkBotId: account.accountId,
      baseUrl: account.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
    };
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private maybeCommitPendingCursor(updateId: number): void {
    const batch = this.pendingCursors.get(updateId);
    if (!batch || !batch.sealed || batch.remaining > 0) {
      return;
    }
    getBridgeContext().store.setChannelOffset(batch.offsetKey, batch.cursor);
    this.pendingCursors.delete(updateId);
  }
}

function stripFormatting(text: string, parseMode?: 'HTML' | 'Markdown' | 'plain'): string {
  if (parseMode === 'HTML') {
    return text.replace(/<[^>]+>/g, '');
  }
  if (parseMode === 'Markdown') {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`{3}[\s\S]*?`{3}/g, (match) => match.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }
  return text;
}

registerAdapterFactory('weixin', () => new WeixinAdapter());
