import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from '../config.js';
import {
  deleteWeixinAccount,
  getWeixinAccount,
  getWeixinContextToken,
  listWeixinAccounts,
  setWeixinAccountEnabled,
  upsertWeixinAccount,
  upsertWeixinContextToken,
} from '../weixin-store.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const ACCOUNTS_PATH = path.join(DATA_DIR, 'weixin-accounts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'weixin-context-tokens.json');

describe('weixin-store', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.rmSync(ACCOUNTS_PATH, { force: true });
    fs.rmSync(TOKENS_PATH, { force: true });
  });

  it('upserts and lists accounts', () => {
    const created = upsertWeixinAccount({
      accountId: 'wx-bot-1',
      userId: 'user-1',
      token: 'token-1',
      name: 'Bot One',
    });

    assert.equal(created.accountId, 'wx-bot-1');
    assert.equal(listWeixinAccounts().length, 1);
    assert.equal(getWeixinAccount('wx-bot-1')?.name, 'Bot One');

    upsertWeixinAccount({
      accountId: 'wx-bot-1',
      token: 'token-2',
      enabled: false,
    });

    const updated = getWeixinAccount('wx-bot-1');
    assert.equal(updated?.token, 'token-2');
    assert.equal(updated?.enabled, false);
  });

  it('replaces the previous account when a different account logs in later', () => {
    upsertWeixinAccount({
      accountId: 'wx-bot-old',
      token: 'token-old',
    });
    upsertWeixinContextToken('wx-bot-old', 'peer-a', 'ctx-a');

    upsertWeixinAccount({
      accountId: 'wx-bot-new',
      token: 'token-new',
    });

    const accounts = listWeixinAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.accountId, 'wx-bot-new');
    assert.equal(getWeixinAccount('wx-bot-old'), undefined);
    assert.equal(getWeixinContextToken('wx-bot-old', 'peer-a'), undefined);
  });

  it('stores per-peer context tokens and clears them on delete', () => {
    upsertWeixinAccount({
      accountId: 'wx-bot-2',
      token: 'token-2',
    });

    upsertWeixinContextToken('wx-bot-2', 'peer-a', 'ctx-a');
    upsertWeixinContextToken('wx-bot-2', 'peer-b', 'ctx-b');

    assert.equal(getWeixinContextToken('wx-bot-2', 'peer-a'), 'ctx-a');
    assert.equal(getWeixinContextToken('wx-bot-2', 'peer-b'), 'ctx-b');

    assert.equal(deleteWeixinAccount('wx-bot-2'), true);
    assert.equal(getWeixinContextToken('wx-bot-2', 'peer-a'), undefined);
    assert.equal(getWeixinAccount('wx-bot-2'), undefined);
  });

  it('toggles account enabled state', () => {
    upsertWeixinAccount({
      accountId: 'wx-bot-3',
      token: 'token-3',
      enabled: true,
    });

    assert.equal(setWeixinAccountEnabled('wx-bot-3', false), true);
    assert.equal(getWeixinAccount('wx-bot-3')?.enabled, false);
  });

  it('prefers the most recent account without mutating legacy storage on read', () => {
    fs.writeFileSync(
      ACCOUNTS_PATH,
      JSON.stringify([
        {
          accountId: 'wx-bot-old',
          userId: 'user-old',
          baseUrl: 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          token: 'token-old',
          name: 'Old Bot',
          enabled: true,
          lastLoginAt: '2026-03-23T13:37:22.711Z',
          createdAt: '2026-03-23T13:37:22.711Z',
          updatedAt: '2026-03-23T13:37:22.711Z',
        },
        {
          accountId: 'wx-bot-new',
          userId: 'user-new',
          baseUrl: 'https://ilinkai.weixin.qq.com',
          cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
          token: 'token-new',
          name: 'New Bot',
          enabled: true,
          lastLoginAt: '2026-03-23T13:44:35.286Z',
          createdAt: '2026-03-23T13:44:35.286Z',
          updatedAt: '2026-03-23T13:44:35.286Z',
        },
      ], null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      TOKENS_PATH,
      JSON.stringify({
        'wx-bot-old::peer-a': 'ctx-old',
        'wx-bot-new::peer-b': 'ctx-new',
      }, null, 2),
      'utf-8',
    );

    const accounts = listWeixinAccounts();
    const storedAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
    const storedTokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));

    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.accountId, 'wx-bot-new');
    assert.equal(storedAccounts.length, 2);
    assert.equal(storedAccounts[0]?.accountId, 'wx-bot-old');
    assert.equal(storedAccounts[1]?.accountId, 'wx-bot-new');
    assert.deepEqual(storedTokens, {
      'wx-bot-old::peer-a': 'ctx-old',
      'wx-bot-new::peer-b': 'ctx-new',
    });
  });
});
