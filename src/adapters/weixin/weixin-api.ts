import crypto from 'node:crypto';
import type {
  GetConfigResponse,
  GetUpdatesResponse,
  MessageItem,
  QrCodeStartResponse,
  QrCodeStatusResponse,
  WeixinCredentials,
} from './weixin-types.js';
import {
  DEFAULT_BASE_URL,
  MessageItemType,
} from './weixin-types.js';

const CHANNEL_VERSION = 'claude-to-im-skill-weixin/1.0';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;

function generateWechatUin(): string {
  return crypto.randomBytes(4).toString('base64');
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function buildHeaders(creds: WeixinCredentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    Authorization: `Bearer ${creds.botToken}`,
    'X-WECHAT-UIN': generateWechatUin(),
  };
}

async function parseJsonResponse<T>(res: Response, label: string): Promise<T> {
  const rawText = await res.text();
  if (!rawText.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(rawText) as T;
  } catch (err) {
    throw new Error(
      `WeChat API returned non-JSON body for ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function weixinRequest<T>(
  creds: WeixinCredentials,
  endpoint: string,
  body: unknown,
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(creds.baseUrl);
  const url = `${baseUrl}/ilink/bot/${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(creds),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`WeChat API error: ${res.status} ${res.statusText}`);
  }

  return parseJsonResponse<T>(res, endpoint);
}

export async function getUpdates(
  creds: WeixinCredentials,
  getUpdatesBuf: string,
  timeoutMs: number = LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResponse> {
  try {
    return await weixinRequest<GetUpdatesResponse>(
      creds,
      'getupdates',
      {
        get_updates_buf: getUpdatesBuf ?? '',
        base_info: { channel_version: CHANNEL_VERSION },
      },
      timeoutMs + 5_000,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `cti-weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function sendMessage(
  creds: WeixinCredentials,
  toUserId: string,
  items: MessageItem[],
  contextToken: string,
): Promise<{ clientId: string }> {
  const clientId = generateClientId();

  await weixinRequest<Record<string, unknown>>(
    creds,
    'sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: items.length > 0 ? items : undefined,
        context_token: contextToken || undefined,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
  );

  return { clientId };
}

export async function sendTextMessage(
  creds: WeixinCredentials,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<{ clientId: string }> {
  return sendMessage(
    creds,
    toUserId,
    [{ type: MessageItemType.TEXT, text_item: { text } }],
    contextToken,
  );
}

export async function getConfig(
  creds: WeixinCredentials,
  ilinkUserId: string,
  contextToken: string,
): Promise<GetConfigResponse> {
  return weixinRequest<GetConfigResponse>(
    creds,
    'getconfig',
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: { channel_version: CHANNEL_VERSION },
    },
    CONFIG_TIMEOUT_MS,
  );
}

export async function sendTyping(
  creds: WeixinCredentials,
  ilinkUserId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  try {
    await weixinRequest<Record<string, unknown>>(
      creds,
      'sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      CONFIG_TIMEOUT_MS,
    );
  } catch {
    // Typing is best-effort only.
  }
}

export async function startLoginQr(baseUrl?: string): Promise<QrCodeStartResponse> {
  const url = `${normalizeBaseUrl(baseUrl)}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`QR login start failed: ${res.status}`);
  }

  return parseJsonResponse<QrCodeStartResponse>(res, 'get_bot_qrcode');
}

export async function pollLoginQrStatus(qrcode: string, baseUrl?: string): Promise<QrCodeStatusResponse> {
  const url = `${normalizeBaseUrl(baseUrl)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(LONG_POLL_TIMEOUT_MS + 5_000),
  });

  if (!res.ok) {
    throw new Error(`QR login poll failed: ${res.status}`);
  }

  return parseJsonResponse<QrCodeStatusResponse>(res, 'get_qrcode_status');
}
