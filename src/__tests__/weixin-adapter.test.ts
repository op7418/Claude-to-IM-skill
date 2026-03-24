import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { WeixinAdapter } from '../adapters/weixin-adapter.js';
import { MessageItemType } from '../adapters/weixin/weixin-types.js';

function createMockStore(settings: Record<string, string> = {}) {
  const auditLogs: Array<{ summary: string }> = [];
  return {
    auditLogs,
    getSetting: (key: string) => settings[key] ?? null,
    insertAuditLog: (entry: { summary: string }) => { auditLogs.push(entry); },
  };
}

function setupContext(store: ReturnType<typeof createMockStore>) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

describe('weixin-adapter voice handling', () => {
  beforeEach(() => {
    setupContext(createMockStore({ bridge_weixin_media_enabled: 'false' }));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('uses WeChat speech-to-text directly for voice messages', async () => {
    const adapter = new WeixinAdapter();

    await (adapter as any).processMessage('acct-1', {
      message_id: 'voice-text-msg',
      from_user_id: 'wx-user-1',
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: '这是微信自带的语音转文字' },
        },
      ],
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '这是微信自带的语音转文字');
    assert.equal(inbound?.attachments, undefined);
  });

  it('surfaces a clear error when voice transcription is unavailable', async () => {
    const adapter = new WeixinAdapter();

    await (adapter as any).processMessage('acct-1', {
      message_id: 'voice-no-text-msg',
      from_user_id: 'wx-user-2',
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: {},
        },
      ],
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '');
    assert.deepEqual(inbound?.attachments, undefined);
    assert.equal(
      (inbound?.raw as { userVisibleError?: string } | undefined)?.userVisibleError,
      'WeChat did not provide speech-to-text for this voice message. Please enable WeChat voice transcription and send it again.',
    );
  });
});
