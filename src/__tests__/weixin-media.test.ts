import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadMediaFromItem, encryptMedia } from '../adapters/weixin/weixin-media.js';
import { MessageItemType } from '../adapters/weixin/weixin-types.js';

describe('weixin-media', () => {
  const originalFetch = globalThis.fetch;
  let lastFetchUrl: string | null = null;

  beforeEach(() => {
    lastFetchUrl = null;
    globalThis.fetch = (async () => {
      throw new Error('fetch mock not configured');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads and decrypts image attachments', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const plaintext = Buffer.from('hello-weixin-image');
    const encrypted = encryptMedia(plaintext, key);

    globalThis.fetch = (async () => {
      lastFetchUrl = 'captured-in-mock';
      return new Response(encrypted, { status: 200 });
    }) as typeof fetch;

    const attachment = await downloadMediaFromItem(
      {
        type: MessageItemType.IMAGE,
        image_item: {
          aeskey: key.toString('hex'),
          media: { encrypt_query_param: 'download=1' },
        },
      },
      'https://cdn.weixin.test/c2c',
    );

    assert.ok(attachment);
    assert.equal(attachment?.type, 'image/jpeg');
    assert.equal(attachment?.data, plaintext.toString('base64'));
    assert.equal(
      lastFetchUrl,
      'captured-in-mock',
    );
  });

  it('downloads and decrypts voice attachments when aes_key is base64-encoded hex', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const plaintext = Buffer.from('hello-weixin-voice');
    const encrypted = encryptMedia(plaintext, key);
    const aesKeyBase64 = Buffer.from(key.toString('hex'), 'ascii').toString('base64');

    globalThis.fetch = (async () => {
      lastFetchUrl = 'captured-voice';
      return new Response(encrypted, { status: 200 });
    }) as typeof fetch;

    const attachment = await downloadMediaFromItem(
      {
        type: MessageItemType.VOICE,
        voice_item: {
          media: {
            encrypt_query_param: 'voice=1',
            aes_key: aesKeyBase64,
          },
        },
      },
      'https://cdn.weixin.test/c2c',
    );

    assert.ok(attachment);
    assert.equal(attachment?.type, 'audio/silk');
    assert.equal(attachment?.data, plaintext.toString('base64'));
    assert.equal(lastFetchUrl, 'captured-voice');
  });

  it('returns null when media metadata is missing', async () => {
    const attachment = await downloadMediaFromItem(
      {
        type: MessageItemType.FILE,
        file_item: { file_name: 'report.pdf' },
      },
      'https://cdn.weixin.test/c2c',
    );

    assert.equal(attachment, null);
  });

  it('uses the OpenClaw CDN download URL format', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const plaintext = Buffer.from('url-shape-check');
    const encrypted = encryptMedia(plaintext, key);

    globalThis.fetch = (async (url: string | URL) => {
      lastFetchUrl = String(url);
      return new Response(encrypted, { status: 200 });
    }) as typeof fetch;

    await downloadMediaFromItem(
      {
        type: MessageItemType.IMAGE,
        image_item: {
          aeskey: key.toString('hex'),
          media: { encrypt_query_param: 'foo=bar&x=1' },
        },
      },
      'https://cdn.weixin.test/c2c',
    );

    assert.equal(
      lastFetchUrl,
      'https://cdn.weixin.test/c2c/download?encrypted_query_param=foo%3Dbar%26x%3D1',
    );
  });
});
