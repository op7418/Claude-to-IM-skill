import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQrHtml } from '../weixin-login.js';

describe('weixin-login HTML', () => {
  it('embeds inline QR markup without remote CDN scripts', () => {
    const html = buildQrHtml(
      {
        qrcode: 'qr-token',
        qrImageUrl: 'weixin://qr-content',
        status: 'waiting',
        startedAt: Date.now(),
        refreshCount: 0,
      },
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>',
    );

    assert.match(html, /<svg viewBox="0 0 10 10">/);
    assert.ok(!html.includes('cdn.jsdelivr.net'));
    assert.ok(!html.includes('<script'));
  });
});
