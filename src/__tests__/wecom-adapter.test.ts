import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboundMessage } from 'claude-to-im/src/lib/bridge/types.js';
import {
  buildWeComOutboundText,
  isWeComGroupAllowed,
  stripHtml,
} from '../wecom-adapter.js';

describe('stripHtml', () => {
  it('removes tags and decodes basic entities', () => {
    assert.equal(
      stripHtml('<b>Hello</b><br><code>&lt;world&gt;</code>'),
      'Hello\n<world>',
    );
  });
});

describe('buildWeComOutboundText', () => {
  it('converts HTML permission prompts into /perm command text', () => {
    const message: OutboundMessage = {
      address: { channelType: 'wecom', chatId: 'user-1' },
      text: '<b>Permission Required</b>\nTool: <code>Edit</code>',
      parseMode: 'HTML',
      inlineButtons: [[
        { text: 'Allow', callbackData: 'perm:allow:req-1' },
        { text: 'Deny', callbackData: 'perm:deny:req-1' },
      ]],
    };

    const result = buildWeComOutboundText(message);
    assert.match(result, /Permission Required/);
    assert.match(result, /\/perm allow req-1/);
    assert.match(result, /\/perm deny req-1/);
  });

  it('passes through markdown/plain content when there are no buttons', () => {
    const message: OutboundMessage = {
      address: { channelType: 'wecom', chatId: 'user-1' },
      text: 'Hello **world**',
      parseMode: 'Markdown',
    };

    assert.equal(buildWeComOutboundText(message), 'Hello **world**');
  });
});

describe('isWeComGroupAllowed', () => {
  it('honors disabled policy', () => {
    assert.equal(isWeComGroupAllowed('disabled', [], 'group-1'), false);
  });

  it('honors open policy', () => {
    assert.equal(isWeComGroupAllowed('open', [], 'group-1'), true);
  });

  it('honors allowlist entries and wildcard', () => {
    assert.equal(isWeComGroupAllowed('allowlist', ['group-1'], 'group-1'), true);
    assert.equal(isWeComGroupAllowed('allowlist', ['*'], 'group-2'), true);
    assert.equal(isWeComGroupAllowed('allowlist', ['group-1'], 'group-2'), false);
  });
});
