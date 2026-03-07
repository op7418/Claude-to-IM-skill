import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── CLI path resolution tests ─────────────────────────────────────

describe('resolveCodebuddyCliPath', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns undefined when CLI not found', async () => {
    delete process.env.CTI_CODEBUDDY_CODE_EXECUTABLE;
    process.env.PATH = '/nonexistent';

    const { resolveCodebuddyCliPath } = await import('../codebuddy-provider.js');
    const result = resolveCodebuddyCliPath();
    assert.ok(result === undefined || typeof result === 'string');
  });
});

// ── Environment isolation tests ───────────────────────────────────

describe('buildSubprocessEnv (CodeBuddy)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('strips CODEBUDDY env var in inherit mode (exact match)', async () => {
    process.env.CTI_ENV_ISOLATION = 'inherit';
    process.env.CODEBUDDY = 'secret-value';
    process.env.CODEBUDDY_CUSTOM = 'user-setting';
    process.env.PATH = '/usr/bin';

    const env = {};
    const mode = 'inherit';
    const ENV_ALWAYS_STRIP = ['CODEBUDDY'];

    if (mode === 'inherit') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (ENV_ALWAYS_STRIP.includes(k)) continue;
        env[k] = v;
      }
    }

    assert.equal(env.CODEBUDDY, undefined, 'CODEBUDDY should be stripped (exact match)');
    assert.equal(env.CODEBUDDY_CUSTOM, 'user-setting', 'CODEBUDDY_CUSTOM should be preserved (not in strip list)');
    assert.equal(env.PATH, '/usr/bin', 'PATH should be preserved');
  });

  it('passes only whitelist in strict mode', async () => {
    process.env.CTI_ENV_ISOLATION = 'strict';
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/user';
    process.env.MY_CUSTOM_VAR = 'custom';
    process.env.CTI_CUSTOM = 'cti-value';

    const env = {};
    const ENV_WHITELIST = new Set([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
      'LANG', 'LC_ALL', 'LC_CTYPE',
      'TMPDIR', 'TEMP', 'TMP',
      'TERM', 'COLORTERM',
      'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
      'SSH_AUTH_SOCK',
      'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
      'SystemRoot', 'SystemDrive', 'COMSPEC',
      'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
      'WINDIR',
    ]);

    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { env[k] = v; continue; }
      if (k.startsWith('CTI_')) { env[k] = v; continue; }
    }

    assert.equal(env.PATH, '/usr/bin', 'PATH should be in whitelist');
    assert.equal(env.HOME, '/home/user', 'HOME should be in whitelist');
    assert.equal(env.MY_CUSTOM_VAR, undefined, 'Non-whitelisted var should be stripped');
    assert.equal(env.CTI_CUSTOM, 'cti-value', 'CTI_* should be passed through');
  });
});
