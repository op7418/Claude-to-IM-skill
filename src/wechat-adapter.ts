/**
 * WeChat Bot Adapter — implements BaseChannelAdapter for Tencent ClawBot API.
 *
 * Uses long polling (getupdates) to consume messages and sendmessage for replies.
 * Requires QR code login to obtain bot_token (persisted to disk).
 */

import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import {
  getUpdates,
  sendMessage,
  sendTyping,
  getConfig,
  extractText,
  loadToken,
} from './wechat-api.js';

// Max text length per WeChat message
const MAX_MSG_LENGTH = 2000;

export class WeChatAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wechat';

  private running = false;
  private abortController: AbortController | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private typingTicket: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Map from chatId to latest context_token (needed for replies)
  private contextTokens = new Map<string, string>();
  // Dedup: track last sent text per chatId to avoid duplicate sends
  private lastSentText = new Map<string, string>();

  private get botToken(): string {
    // First check store setting (from config.env), then fall back to persisted token file
    return getBridgeContext().store.getSetting('wechat_bot_token') || loadToken() || '';
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wechat-adapter] Cannot start:', configError);
      return;
    }

    this.running = true;
    this.abortController = new AbortController();

    // Fetch typing ticket
    const config = await getConfig(this.botToken);
    this.typingTicket = config.typing_ticket || null;

    // Start polling loop
    this.pollLoop();

    console.log('[wechat-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;

    // Drain waiters
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clear typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    console.log('[wechat-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Config validation ──

  validateConfig(): string | null {
    const token = this.botToken;
    if (!token) return 'wechat_bot_token not configured (run QR login first)';

    const enabled = getBridgeContext().store.getSetting('bridge_wechat_enabled');
    if (enabled !== 'true') return 'bridge_wechat_enabled is not true';

    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('wechat_bridge_allowed_users') || '';
    if (allowedUsers) {
      const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0) {
        return allowed.includes(userId);
      }
    }
    // No allowlist configured — allow all (WeChat QR login is already a form of auth)
    return true;
  }

  // ── Message queue ──

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Polling loop ──

  private async pollLoop(): Promise<void> {
    const store = getBridgeContext().store;
    const key = 'wechat_poll_cursor';
    let rawCursor = store.getChannelOffset(key);
    // WeChat API expects empty string for first poll, not '0'
    let cursor = (!rawCursor || rawCursor === '0') ? '' : rawCursor;

    console.log('[wechat-adapter] Poll loop started, cursor:', cursor ? cursor.slice(0, 20) + '...' : '(empty)');

    while (this.running) {
      try {
        const result = await getUpdates(
          this.botToken,
          cursor,
          this.abortController?.signal,
        );

        if (!this.running) break;

        console.log(`[wechat-adapter] getupdates: ${result.messages.length} message(s)`);

        // Update cursor
        if (result.get_updates_buf) {
          cursor = result.get_updates_buf;
          store.setChannelOffset(key, cursor);
        }

        // If no messages, brief pause to avoid tight loop
        // (API should hold connection for ~30s but may not)
        if (result.messages.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
        }

        for (const msg of result.messages) {
          const userId = msg.from_user_id;
          const chatId = msg.from_user_id; // WeChat C2C: chatId = userId
          const text = extractText(msg.item_list);

          console.log(`[wechat-adapter] Message from ${userId.slice(0, 10)}...: "${text.slice(0, 50)}" (type=${msg.message_type})`);

          if (!text && msg.message_type === 1) continue; // empty text message

          if (!this.isAuthorized(userId, chatId)) {
            console.warn('[wechat-adapter] Unauthorized message from:', userId);
            continue;
          }

          // Store context_token for replies
          if (msg.context_token) {
            this.contextTokens.set(chatId, msg.context_token);
          }

          const inbound: InboundMessage = {
            messageId: msg.msg_id || `wechat-${Date.now()}`,
            address: {
              channelType: 'wechat',
              chatId,
              userId,
              displayName: userId.split('@')[0] || userId,
            },
            text,
            timestamp: Date.now(),
            raw: msg,
          };

          this.enqueue(inbound);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') break;
        console.warn('[wechat-adapter] Polling error:', err?.message || err);
        // Back off on error
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // ── Sending ──

  async send(message: OutboundMessage): Promise<SendResult> {
    const token = this.botToken;
    if (!token) return { success: false, error: 'No bot token' };

    const chatId = message.address?.chatId || (message as any).chatId || '';
    const contextToken = this.contextTokens.get(chatId);

    console.log(`[wechat-adapter] send() chatId=${chatId.slice(0, 15)}... context*****=${contextToken ? 'yes' : 'NO'} textLen=${(message.text || '').length} parseMode=${message.parseMode || 'none'} text="${(message.text || '').slice(0, 80)}"`);

    if (!contextToken) {
      console.error('[wechat-adapter] No context_token for chat:', chatId);
      return { success: false, error: 'No context_token for this chat (user must send a message first)' };
    }

    const text = message.text || '';
    if (!text) return { success: false, error: 'Empty message' };

    // Dedup: skip if same text was just sent to this chat
    if (this.lastSentText.get(chatId) === text) {
      console.log('[wechat-adapter] Skipping duplicate send');
      return { success: true };
    }

    try {
      // Split long messages
      const chunks = this.splitText(text, MAX_MSG_LENGTH);
      for (const chunk of chunks) {
        const result = await sendMessage(token, chatId, chunk, contextToken);
        console.log(`[wechat-adapter] sendMessage result:`, JSON.stringify(result).slice(0, 200));
      }
      this.lastSentText.set(chatId, text);
      return { success: true };
    } catch (err: any) {
      console.error('[wechat-adapter] Send error:', err?.message || err);
      return { success: false, error: err?.message || 'Send failed' };
    }
  }

  // ── Typing indicator ──

  onMessageStart(chatId: string): void {
    this.stopTyping(chatId);
    const token = this.botToken;
    if (!token || !this.typingTicket) return;

    sendTyping(token, chatId, this.typingTicket);

    const interval = setInterval(() => {
      sendTyping(token, chatId, this.typingTicket!);
    }, 5000);
    this.typingIntervals.set(chatId, interval);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  // ── Helpers ──

  private splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }
}

// ── Self-registration ──
registerAdapterFactory('wechat', () => new WeChatAdapter());
