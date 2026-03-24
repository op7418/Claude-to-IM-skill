import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pollLoginQrStatus, startLoginQr } from '../adapters/weixin/weixin-api.js';

describe('weixin-api QR login endpoints', () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the configured base URL for QR start', async () => {
    await startLoginQr('https://weixin-proxy.example.com/');

    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0]?.url,
      'https://weixin-proxy.example.com/ilink/bot/get_bot_qrcode?bot_type=3',
    );
  });

  it('uses the configured base URL for QR status polling', async () => {
    await pollLoginQrStatus('qr-code-value', 'https://weixin-proxy.example.com');

    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0]?.url,
      'https://weixin-proxy.example.com/ilink/bot/get_qrcode_status?qrcode=qr-code-value',
    );
  });
});
