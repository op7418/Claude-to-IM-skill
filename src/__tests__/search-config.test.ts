import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SDKLLMProvider } from '../llm-provider.js';
import { PendingPermissions } from '../permission-gateway.js';
import {
  resolveSearchOptions, PARALLEL_SEARCH_URL, PARALLEL_SEARCH_AGENT, PARALLEL_SEARCH_SERVER,
} from '../search-config.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-search-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project', 'nested');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root, home, cwd, env: { HOME: home } as NodeJS.ProcessEnv,
    write(file: string, value: unknown) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    },
    close() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

describe('Claude search configuration', () => {
  it('provides anonymous HTTP MCP search for a fresh configuration', () => {
    const f = fixture();
    try {
      const options = resolveSearchOptions(f.cwd, f.env);
      assert.deepEqual(options, {
        mcpServers: { [PARALLEL_SEARCH_SERVER]: {
          type: 'http', url: PARALLEL_SEARCH_URL,
          headers: { 'User-Agent': PARALLEL_SEARCH_AGENT },
        } },
        disallowedTools: ['WebSearch', 'WebFetch'],
      });
      assert.equal(JSON.stringify(options).includes('Authorization'), false);
      assert.equal(JSON.stringify(options).includes('session_id'), false);
    } finally { f.close(); }
  });

  it('honors native and disabled selections and rejects typos', () => {
    const f = fixture();
    try {
      assert.deepEqual(resolveSearchOptions(f.cwd, { ...f.env, CTI_SEARCH_PROVIDER: 'builtin' }), {});
      assert.deepEqual(resolveSearchOptions(f.cwd, { ...f.env, CTI_SEARCH_PROVIDER: 'off' }), {
        disallowedTools: ['WebSearch', 'WebFetch'],
      });
      assert.throws(() => resolveSearchOptions(f.cwd, { ...f.env, CTI_SEARCH_PROVIDER: 'paralell' }),
        /CTI_SEARCH_PROVIDER must be/);
    } finally { f.close(); }
  });

  for (const [label, relative, value] of [
    ['saved user server', 'home/.claude.json', { mcpServers: { custom: { url: 'https://example.org/mcp' } } }],
    ['ancestor project server', 'project/.mcp.json', { mcpServers: { custom: { command: 'custom-search' } } }],
    ['disabled server', 'home/.claude.json', { projects: { project: { disabledMcpServers: ['cti-parallel-search'] } } }],
    ['denied search', 'project/.claude/settings.json', { permissions: { deny: ['WebSearch'] } }],
    ['domain restrictions', 'project/.claude/settings.local.json', { permissions: { allow: ['WebFetch(domain:example.org)'] } }],
    ['MCP restrictions', 'home/.claude/settings.json', { permissions: { ask: ['mcp__custom__search'] } }],
    ['wildcard restrictions', 'home/.claude/settings.json', { permissions: { deny: ['*'] } }],
    ['saved API key', 'home/.claude/settings.json', { env: { TAVILY_API_KEY: 'configured-test-key' } }],
  ] as const) {
    it(`preserves ${label} without modifying the file`, () => {
      const f = fixture();
      try {
        const file = path.join(f.root, relative);
        f.write(file, value);
        const before = fs.readFileSync(file);
        assert.deepEqual(resolveSearchOptions(f.cwd, f.env), {});
        assert.deepEqual(fs.readFileSync(file), before);
      } finally { f.close(); }
    });
  }

  it('does not mistake login/model preferences for a configured search provider', () => {
    const f = fixture();
    try {
      f.write(path.join(f.home, '.claude.json'), { hasCompletedOnboarding: true, numStartups: 10,
        projects: { [f.cwd]: { mcpServers: {}, mcpContextUris: [],
          enabledMcpjsonServers: [], disabledMcpjsonServers: [] } } });
      f.write(path.join(f.home, '.claude', 'settings.json'), { model: 'claude-sonnet-4-6' });
      assert.ok(resolveSearchOptions(f.cwd, f.env).mcpServers);
    } finally { f.close(); }
  });

  it('honors search credentials and custom Claude configuration directories', () => {
    const f = fixture();
    try {
      assert.deepEqual(resolveSearchOptions(f.cwd, { ...f.env, PARALLEL_API_KEY: 'test-key' }), {});
      const dir = path.join(f.root, 'custom-config');
      f.write(path.join(dir, 'settings.json'), { permissions: { deny: ['WebFetch'] } });
      assert.deepEqual(resolveSearchOptions(f.cwd, { ...f.env, CLAUDE_CONFIG_DIR: dir }), {});
    } finally { f.close(); }
  });

  it('fails closed on malformed, non-object and unreadable config', () => {
    const f = fixture();
    try {
      const file = path.join(f.cwd, '.mcp.json');
      for (const text of ['{broken', 'null', '[]']) {
        fs.writeFileSync(file, text);
        assert.deepEqual(resolveSearchOptions(f.cwd, f.env), {});
      }
      fs.unlinkSync(file);
      fs.mkdirSync(file); // EISDIR, including when tests run as root.
      assert.deepEqual(resolveSearchOptions(f.cwd, f.env), {});
    } finally { f.close(); }
  });

  it('suppresses the automatic provider when managed policy exists', () => {
    const f = fixture();
    const read = fs.readFileSync;
    const replacement = mock.method(fs, 'readFileSync', ((file: any, options: any) => {
      if (String(file).endsWith('managed-settings.json')) return '{}';
      return read(file, options);
    }) as typeof fs.readFileSync);
    try {
      assert.deepEqual(resolveSearchOptions(f.cwd, f.env), {});
    } finally { replacement.mock.restore(); f.close(); }
  });

  it('does not treat a broken config symlink as an unconfigured installation', {
    skip: process.platform === 'win32',
  }, () => {
    const f = fixture();
    try {
      fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.cwd, '.mcp.json'));
      assert.deepEqual(resolveSearchOptions(f.cwd, f.env), {});
    } finally { f.close(); }
  });

  it('passes saved choices, native overrides and disabled search through the provider resolver', async () => {
    const f = fixture();
    const oldEnv = process.env;
    try {
      for (const selection of ['builtin', 'off', 'saved', 'auto']) {
        process.env = { ...f.env, CTI_SEARCH_PROVIDER: selection === 'saved' ? 'auto' : selection };
        const saved = path.join(f.cwd, '.mcp.json');
        if (selection === 'saved') f.write(saved, { mcpServers: { custom: { url: 'https://example.org/mcp' } } });
        else fs.rmSync(saved, { force: true });
        let captured: any;
        const provider = new SDKLLMProvider(new PendingPermissions());
        (provider as any).runQuery = (args: any) => {
          captured = args.options;
          return (async function* () {
            yield { type: 'result', subtype: 'success', session_id: 'fixture', is_error: false };
          })();
        };
        for await (const _ of provider.streamChat({ prompt: 'Find documentation',
          sessionId: 'resolver-test', workingDirectory: f.cwd })) { /* consume */ }
        assert.equal(typeof captured.canUseTool, 'function', selection);
        assert.equal(Boolean(captured.mcpServers), selection === 'auto', selection);
        assert.equal(Boolean(captured.disallowedTools), ['off', 'auto'].includes(selection), selection);
      }
    } finally { process.env = oldEnv; f.close(); }
  });
});
