import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQrHtml, isWeixinLoginCliEntry } from '../weixin-login.js';

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

  it('includes a real auto-refresh hint for expired QR codes', () => {
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

    assert.match(html, /http-equiv="refresh"/i);
  });
});

describe('weixin-login CLI entry detection', () => {
  it('treats symlinked entry paths as the same module', () => {
    assert.equal(
      isWeixinLoginCliEntry(
        '/Users/jitian/.codex/skills/claude-to-im/dist/weixin-login.mjs',
        'file:///Users/jitian/Documents/TiDB%20Cloud%20Zero/Claude-to-IM-skill-work/dist/weixin-login.mjs',
      ),
      true,
    );
  });
});
