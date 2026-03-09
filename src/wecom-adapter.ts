import path from 'node:path';
import {
  WSClient,
  type BaseMessage,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type MixedMsgItem,
  type VoiceMessage,
  type WsFrame,
} from '@wecom/aibot-node-sdk';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import type { FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type {
  ChannelType,
  InboundMessage,
  InlineButton,
  OutboundMessage,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';

const AUTH_TIMEOUT_MS = 15_000;
const DEDUP_MAX = 1000;

type WeComGroupPolicy = 'open' | 'allowlist' | 'disabled';

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const FILE_EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

function splitCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getGroupPolicy(value: string | null | undefined): WeComGroupPolicy {
  if (value === 'open' || value === 'allowlist' || value === 'disabled') {
    return value;
  }
  return 'allowlist';
}

function decodeHtmlEntity(entity: string): string {
  switch (entity) {
    case '&lt;':
      return '<';
    case '&gt;':
      return '>';
    case '&amp;':
      return '&';
    case '&quot;':
      return '"';
    case '&#39;':
      return '\'';
    case '<br>':
    case '<br/>':
    case '<br />':
      return '\n';
    default:
      return '';
  }
}

export function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|pre|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<(code|pre|b|strong|i|em|u)>/gi, '')
    .replace(/<\/(code|pre|b|strong|i|em|u)>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;|&gt;|&amp;|&quot;|&#39;/g, decodeHtmlEntity)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buttonsToPermCommands(buttons?: InlineButton[][]): string[] {
  if (!buttons) return [];
  return buttons
    .flat()
    .map((button) => {
      if (!button.callbackData.startsWith('perm:')) return null;
      const [, action, ...rest] = button.callbackData.split(':');
      if (!action || rest.length === 0) return null;
      return `/perm ${action} ${rest.join(':')}`;
    })
    .filter((command): command is string => Boolean(command));
}

export function buildWeComOutboundText(message: OutboundMessage): string {
  if (message.inlineButtons?.length) {
    const prompt = stripHtml(message.text);
    const commands = buttonsToPermCommands(message.inlineButtons);
    return [
      prompt,
      '',
      'Reply with one of:',
      ...commands,
    ].join('\n').trim();
  }

  if (message.parseMode === 'HTML') {
    return stripHtml(message.text);
  }

  return message.text.trim();
}

export function isWeComGroupAllowed(
  groupPolicy: WeComGroupPolicy,
  allowedGroups: string[],
  chatId: string,
): boolean {
  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;

  if (allowedGroups.includes('*')) return true;
  return allowedGroups.some((entry) => entry === chatId);
}

function normalizeQuotedText(body: BaseMessage): string | undefined {
  const quote = body.quote;
  if (!quote) return undefined;

  if (quote.msgtype === 'text' && quote.text?.content) return quote.text.content;
  if (quote.msgtype === 'voice' && quote.voice?.content) return quote.voice.content;

  return undefined;
}

function collectTextParts(body: BaseMessage): string[] {
  const textParts: string[] = [];

  if (body.msgtype === 'mixed') {
    for (const item of ((body as MixedMessage).mixed?.msg_item ?? []) as MixedMsgItem[]) {
      if (item.msgtype === 'text' && item.text?.content) {
        textParts.push(item.text.content);
      }
    }
  } else if (body.msgtype === 'text' && body.text?.content) {
    textParts.push(body.text.content);
  } else if (body.msgtype === 'voice' && (body as VoiceMessage).voice?.content) {
    textParts.push((body as VoiceMessage).voice.content);
  }

  const quoted = normalizeQuotedText(body);
  if (quoted) {
    textParts.push(`Quoted message:\n${quoted}`);
  }

  return textParts;
}

function collectDownloadTargets(body: BaseMessage): Array<{
  kind: 'image' | 'file';
  url: string;
  aesKey?: string;
}> {
  const targets: Array<{ kind: 'image' | 'file'; url: string; aesKey?: string }> = [];

  const pushImage = (url?: string, aesKey?: string) => {
    if (url) targets.push({ kind: 'image', url, aesKey });
  };
  const pushFile = (url?: string, aesKey?: string) => {
    if (url) targets.push({ kind: 'file', url, aesKey });
  };

  if (body.msgtype === 'mixed') {
    for (const item of ((body as MixedMessage).mixed?.msg_item ?? []) as MixedMsgItem[]) {
      if (item.msgtype === 'image') {
        pushImage(item.image?.url, item.image?.aeskey);
      }
    }
  } else if (body.msgtype === 'image') {
    pushImage((body as ImageMessage).image?.url, (body as ImageMessage).image?.aeskey);
  } else if (body.msgtype === 'file') {
    pushFile((body as FileMessage).file?.url, (body as FileMessage).file?.aeskey);
  }

  if (body.quote?.msgtype === 'image') {
    pushImage(body.quote.image?.url, body.quote.image?.aeskey);
  } else if (body.quote?.msgtype === 'file') {
    pushFile(body.quote.file?.url, body.quote.file?.aeskey);
  }

  return targets;
}

function guessMimeType(kind: 'image' | 'file', filename?: string): string {
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  if (kind === 'image') {
    return IMAGE_EXT_TO_MIME[ext] || 'image/png';
  }
  return FILE_EXT_TO_MIME[ext] || 'application/octet-stream';
}

function buildAttachmentName(kind: 'image' | 'file', index: number, filename?: string): string {
  if (filename) return filename;
  return kind === 'image' ? `image-${index + 1}.png` : `file-${index + 1}`;
}

export class WeComAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wecom';

  private running = false;
  private client: WSClient | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMessageIds = new Map<string, true>();

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wecom-adapter] Cannot start:', configError);
      return;
    }

    const { store } = getBridgeContext();
    const botId = store.getSetting('bridge_wecom_bot_id') || '';
    const secret = store.getSetting('bridge_wecom_secret') || '';
    const wsUrl = store.getSetting('bridge_wecom_ws_url') || undefined;

    const client = new WSClient({
      botId,
      secret,
      wsUrl,
      logger: {
        debug: (...args: unknown[]) => console.log('[wecom-sdk]', ...args),
        info: (...args: unknown[]) => console.log('[wecom-sdk]', ...args),
        warn: (...args: unknown[]) => console.warn('[wecom-sdk]', ...args),
        error: (...args: unknown[]) => console.error('[wecom-sdk]', ...args),
      },
    });

    client.on('message', (frame: WsFrame<BaseMessage>) => {
      void this.handleIncomingFrame(frame);
    });
    client.on('disconnected', (reason: string) => {
      console.warn('[wecom-adapter] Disconnected:', reason);
    });
    client.on('reconnecting', (attempt: number) => {
      console.warn(`[wecom-adapter] Reconnecting attempt ${attempt}`);
    });
    client.on('error', (error: Error) => {
      console.error('[wecom-adapter] Client error:', error.message);
    });

    this.client = client;
    client.connect();

    await this.waitForAuthentication(client);
    this.running = true;
    console.log('[wecom-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.client && !this.running) return;

    this.running = false;

    if (this.client) {
      this.client.removeAllListeners();
      this.client.disconnect();
      this.client = null;
    }

    for (const waiter of this.waiters) {
      waiter(null);
    }

    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();
    console.log('[wecom-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client || !this.client.isConnected) {
      return { ok: false, error: 'WeCom client not connected' };
    }

    const content = buildWeComOutboundText(message);
    if (!content) {
      return { ok: true };
    }

    try {
      const receipt = await this.client.sendMessage(message.address.chatId, {
        msgtype: 'markdown',
        markdown: { content },
      });

      return {
        ok: true,
        messageId: receipt.headers?.req_id || `${Date.now()}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  validateConfig(): string | null {
    const { store } = getBridgeContext();

    const botId = store.getSetting('bridge_wecom_bot_id');
    if (!botId) return 'bridge_wecom_bot_id not configured';

    const secret = store.getSetting('bridge_wecom_secret');
    if (!secret) return 'bridge_wecom_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = splitCsv(getBridgeContext().store.getSetting('bridge_wecom_allowed_users'));
    if (allowedUsers.length === 0) return true;
    return allowedUsers.includes(userId) || allowedUsers.includes(chatId);
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
      return;
    }
    this.queue.push(msg);
  }

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    if (this.seenMessageIds.size <= DEDUP_MAX) return;

    const oldestKey = this.seenMessageIds.keys().next().value;
    if (oldestKey) {
      this.seenMessageIds.delete(oldestKey);
    }
  }

  private async waitForAuthentication(client: WSClient): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('WeCom authentication timed out'));
      }, AUTH_TIMEOUT_MS);

      const onAuthenticated = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        client.off('authenticated', onAuthenticated);
        client.off('error', onError);
      };

      client.on('authenticated', onAuthenticated);
      client.on('error', onError);
    });
  }

  private async handleIncomingFrame(frame: WsFrame<BaseMessage>): Promise<void> {
    const body = frame.body;
    if (!body?.msgid) return;

    if (this.seenMessageIds.has(body.msgid)) return;
    this.addToDedup(body.msgid);

    const chatId = body.chatid || body.from?.userid;
    const userId = body.from?.userid || '';
    if (!chatId || !userId) return;
    if (!this.isAuthorized(userId, chatId)) return;

    if (body.chattype === 'group') {
      const groupPolicy = getGroupPolicy(
        getBridgeContext().store.getSetting('bridge_wecom_group_policy'),
      );
      const allowedGroups = splitCsv(
        getBridgeContext().store.getSetting('bridge_wecom_group_allow_from'),
      );
      if (!isWeComGroupAllowed(groupPolicy, allowedGroups, chatId)) {
        return;
      }
    }

    const textParts = collectTextParts(body);
    const attachments = await this.downloadAttachments(body);
    const text = textParts.join('\n\n').trim();

    if (!text && attachments.length === 0) return;

    this.enqueue({
      messageId: body.msgid,
      address: {
        channelType: this.channelType,
        chatId,
        userId,
        displayName: userId,
      },
      text,
      timestamp: body.create_time || Date.now(),
      raw: frame,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  private async downloadAttachments(body: BaseMessage): Promise<FileAttachment[]> {
    if (!this.client) return [];

    const targets = collectDownloadTargets(body);
    const attachments: FileAttachment[] = [];

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      try {
        const { buffer, filename } = await this.client.downloadFile(target.url, target.aesKey);
        const name = buildAttachmentName(target.kind, index, filename);
        attachments.push({
          id: `${body.msgid}:${index}`,
          name,
          type: guessMimeType(target.kind, name),
          size: buffer.length,
          data: buffer.toString('base64'),
        });
      } catch (err) {
        console.warn(
          '[wecom-adapter] Failed to download attachment:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return attachments;
  }
}

registerAdapterFactory('wecom', () => new WeComAdapter());
