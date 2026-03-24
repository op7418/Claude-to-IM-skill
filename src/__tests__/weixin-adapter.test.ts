import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { WeixinAdapter } from '../adapters/weixin-adapter.js';
import { MessageItemType } from '../adapters/weixin/weixin-types.js';
import { CTI_HOME } from '../config.js';
import { getWeixinActiveWorkspaceAlias } from '../weixin-store.js';
import { WORKSPACES_CONFIG_PATH } from '../workspace-config.js';

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

class TestWeixinAdapter extends WeixinAdapter {
  replies: string[] = [];

  protected override async sendDirectTextReply(_accountId: string, _peerUserId: string, text: string): Promise<void> {
    this.replies.push(text);
  }
}

describe('weixin-adapter voice handling', () => {
  beforeEach(() => {
    setupContext(createMockStore({ bridge_weixin_media_enabled: 'false' }));
    fs.rmSync(WORKSPACES_CONFIG_PATH, { force: true });
    fs.rmSync(path.join(CTI_HOME, 'data', 'weixin-active-workspaces.json'), { force: true });
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

  it('uses the default workspace alias in inbound chat ids when whitelist is configured', async () => {
    const workspaceDir = path.join(CTI_HOME, 'workspace-fixtures', 'zero');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      WORKSPACES_CONFIG_PATH,
      JSON.stringify({
        defaultAlias: 'zero',
        workspaces: [{ alias: 'zero', path: workspaceDir }],
      }, null, 2),
      'utf-8',
    );

    const adapter = new TestWeixinAdapter();

    await (adapter as any).processMessage('acct-1', {
      message_id: 'text-msg',
      from_user_id: 'wx-user-3',
      context_token: 'ctx-1',
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: 'hello workspace' },
        },
      ],
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.address.chatId, 'weixin::acct-1::wx-user-3::zero');
  });

  it('handles switch workspace command without forwarding to the model', async () => {
    const zeroDir = path.join(CTI_HOME, 'workspace-fixtures', 'zero');
    const fooDir = path.join(CTI_HOME, 'workspace-fixtures', 'foo');
    fs.mkdirSync(zeroDir, { recursive: true });
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(
      WORKSPACES_CONFIG_PATH,
      JSON.stringify({
        defaultAlias: 'zero',
        workspaces: [
          { alias: 'zero', path: zeroDir },
          { alias: 'foo', path: fooDir },
        ],
      }, null, 2),
      'utf-8',
    );

    const adapter = new TestWeixinAdapter();

    await (adapter as any).processMessage('acct-1', {
      message_id: 'switch-msg',
      from_user_id: 'wx-user-4',
      context_token: 'ctx-2',
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: '切换项目 foo' },
        },
      ],
    });

    const inbound = await adapter.consumeOne();
    assert.equal(inbound, null);
    assert.equal(getWeixinActiveWorkspaceAlias('acct-1', 'wx-user-4'), 'foo');
    assert.match(adapter.replies[0] ?? '', /已切换到项目 foo/);
  });
});
