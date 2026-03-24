import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseWeixinCommand } from '../weixin-command-router.js';

describe('weixin-command-router', () => {
  it('parses list command', () => {
    assert.deepEqual(parseWeixinCommand('项目列表'), { type: 'list' });
  });

  it('parses current workspace command', () => {
    assert.deepEqual(parseWeixinCommand('当前项目'), { type: 'current' });
  });

  it('parses switch workspace command', () => {
    assert.deepEqual(parseWeixinCommand('切换项目 zero'), {
      type: 'switch',
      alias: 'zero',
    });
  });

  it('returns null for non-command messages', () => {
    assert.equal(parseWeixinCommand('帮我看看这个报错'), null);
  });
});
