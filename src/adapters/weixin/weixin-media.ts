import crypto from 'node:crypto';
import type { FileAttachment } from 'claude-to-im/src/lib/bridge/types.js';
import type { CDNMedia, MessageItem } from './weixin-types.js';
import { MessageItemType } from './weixin-types.js';

const MAX_MEDIA_SIZE = 100 * 1024 * 1024;

export function encryptMedia(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function decryptMedia(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseBase64EncodedAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }

  const ascii = decoded.toString('ascii');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, 'hex');
  }

  throw new Error(`Invalid AES key length: expected 16 raw bytes or 32-char hex, got ${decoded.length} bytes`);
}

function parseAesKey(item: { aeskey?: string; media?: CDNMedia }): Buffer | null {
  if (item.aeskey && item.aeskey.length === 32) {
    return Buffer.from(item.aeskey, 'hex');
  }
  if (item.media?.aes_key) {
    return parseBase64EncodedAesKey(item.media.aes_key);
  }
  return null;
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return 'application/octet-stream';

  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp4: 'video/mp4',
    silk: 'audio/silk',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function buildCdnDownloadUrl(encryptParam: string, cdnBaseUrl: string): string {
  const normalizedBaseUrl = cdnBaseUrl.replace(/\/+$/, '');
  return `${normalizedBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`;
}

async function downloadAndDecryptMedia(cdnUrl: string, aesKey: Buffer, label: string): Promise<Buffer> {
  const res = await fetch(cdnUrl, {
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`CDN download failed for ${label}: ${res.status}`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  if (encrypted.length === 0) {
    throw new Error(`Downloaded ${label} is empty`);
  }
  if (encrypted.length > MAX_MEDIA_SIZE) {
    throw new Error(`Media too large: ${encrypted.length} bytes`);
  }

  return decryptMedia(encrypted, aesKey);
}

export async function downloadMediaFromItem(
  item: MessageItem,
  cdnBaseUrl: string,
): Promise<FileAttachment | null> {
  let encryptParam: string | undefined;
  let aesKey: Buffer | null = null;
  let filename = 'file.bin';
  let mimeType = 'application/octet-stream';

  switch (item.type) {
    case MessageItemType.IMAGE:
      if (item.image_item) {
        encryptParam = item.image_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.image_item);
        filename = `image_${Date.now()}.jpg`;
        mimeType = 'image/jpeg';
      }
      break;
    case MessageItemType.VOICE:
      if (item.voice_item) {
        encryptParam = item.voice_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.voice_item);
        filename = `voice_${Date.now()}.silk`;
        mimeType = 'audio/silk';
      }
      break;
    case MessageItemType.FILE:
      if (item.file_item) {
        encryptParam = item.file_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.file_item);
        filename = item.file_item.file_name || `file_${Date.now()}`;
        mimeType = guessMimeType(filename);
      }
      break;
    case MessageItemType.VIDEO:
      if (item.video_item) {
        encryptParam = item.video_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.video_item);
        filename = `video_${Date.now()}.mp4`;
        mimeType = 'video/mp4';
      }
      break;
    default:
      return null;
  }

  if (!encryptParam || !aesKey) {
    return null;
  }

  const data = await downloadAndDecryptMedia(buildCdnDownloadUrl(encryptParam, cdnBaseUrl), aesKey, filename);
  return {
    id: crypto.randomUUID(),
    name: filename,
    type: mimeType,
    size: data.length,
    data: data.toString('base64'),
  };
}
