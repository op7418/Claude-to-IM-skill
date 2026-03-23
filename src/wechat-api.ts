/**
 * WeChat Bot API client — wraps Tencent ClawBot HTTP endpoints.
 *
 * Base URL: https://ilinkai.weixin.qq.com
 * Auth: Bearer bot_token + custom headers
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const TOKEN_FILE = path.join(CTI_HOME, 'data', 'wechat-token.json');

// ── Auth helpers ──

function randomUin(): string {
  const buf = crypto.randomBytes(4);
  return Buffer.from(String(buf.readUInt32BE(0))).toString('base64');
}

export function authHeaders(botToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${botToken}`,
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
    'Content-Type': 'application/json',
  };
}

// ── Token persistence ──

interface WeChatToken {
  bot_token: string;
  baseurl?: string;
  saved_at: string;
}

export function loadToken(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as WeChatToken;
    return data.bot_token || null;
  } catch {
    return null;
  }
}

export function saveToken(botToken: string, baseurl?: string): void {
  const data: WeChatToken = {
    bot_token: botToken,
    baseurl,
    saved_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ── QR Login ──

export interface QRCodeResult {
  qrcode_url: string;
  qrcode: string; // qrcode identifier for polling
}

export async function getLoginQRCode(): Promise<QRCodeResult> {
  const res = await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  const data: any = await res.json();
  if (!data.qrcode_url) throw new Error('Failed to get QR code: ' + JSON.stringify(data));
  return { qrcode_url: data.qrcode_url, qrcode: data.qrcode || '' };
}

export interface QRCodeStatus {
  status: string; // 'waiting', 'scanned', 'confirmed', 'expired'
  bot_token?: string;
  baseurl?: string;
}

export async function pollQRCodeStatus(qrcode: string): Promise<QRCodeStatus> {
  const res = await fetch(`${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
  const data: any = await res.json();
  return {
    status: data.status || 'waiting',
    bot_token: data.bot_token,
    baseurl: data.baseurl,
  };
}

// ── Messaging ──

export interface WeChatMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number; // 1=text, 2=image, 3=voice, 4=file, 5=video
  context_token: string;
  item_list: WeChatMessageItem[];
  msg_id?: string;
}

export interface WeChatMessageItem {
  type: number; // 1=text, 2=image, 3=voice, 4=file, 5=video
  text_item?: { text: string };
  image_item?: { media_url: string };
}

export interface GetUpdatesResult {
  messages: WeChatMessage[];
  get_updates_buf: string;
}

export async function getUpdates(
  botToken: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<GetUpdatesResult> {
  const res = await fetch(`${BASE_URL}/ilink/bot/getupdates`, {
    method: 'POST',
    headers: authHeaders(botToken),
    body: JSON.stringify({
      get_updates_buf: cursor,
      timeout: 30,
      base_info: { channel_version: '1.0.2' },
    }),
    signal,
  });

  const data: any = await res.json();
  const messages: WeChatMessage[] = [];

  // API returns "msgs" not "msg_list"
  const rawMsgs = data.msgs || data.msg_list || [];
  if (Array.isArray(rawMsgs)) {
    for (const msg of rawMsgs) {
      messages.push({
        from_user_id: msg.from_user_id || '',
        to_user_id: msg.to_user_id || '',
        message_type: msg.message_type || 1,
        context_token: msg.context_token || '',
        item_list: msg.item_list || [],
        msg_id: msg.message_id ? String(msg.message_id) : (msg.msg_id || ''),
      });
    }
  }

  return {
    messages,
    get_updates_buf: data.get_updates_buf || cursor,
  };
}

export async function sendMessage(
  botToken: string,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<any> {
  const clientId = `claude-to-im-${crypto.randomUUID()}`;
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,  // BOT
      message_state: 2, // FINISH
      context_token: contextToken,
      item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
    },
    base_info: { channel_version: '1.0.2' },
  };
  const res = await fetch(`${BASE_URL}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: authHeaders(botToken),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function sendTyping(botToken: string, toUserId: string, typingTicket: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: authHeaders(botToken),
      body: JSON.stringify({
        to_user_id: toUserId,
        typing_ticket: typingTicket,
      }),
    });
  } catch {
    // best-effort
  }
}

export async function getConfig(botToken: string): Promise<{ typing_ticket?: string }> {
  try {
    const res = await fetch(`${BASE_URL}/ilink/bot/getconfig`, {
      method: 'POST',
      headers: authHeaders(botToken),
      body: JSON.stringify({}),
    });
    const data: any = await res.json();
    return { typing_ticket: data.typing_ticket };
  } catch {
    return {};
  }
}

// ── Text extraction helper ──

export function extractText(items: WeChatMessageItem[]): string {
  return items
    .filter(i => i.type === 1 && i.text_item?.text)
    .map(i => i.text_item!.text)
    .join('\n');
}
