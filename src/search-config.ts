/** Search defaults for Claude SDK sessions. Never rewrite the user's files. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp';
export const PARALLEL_SEARCH_AGENT = 'claude-to-im-skill/0.1.0';
export const PARALLEL_SEARCH_SERVER = 'cti-parallel-search';

type SearchOptions = Pick<Options, 'mcpServers' | 'disallowedTools'>;
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** These credentials indicate that search was intentionally configured elsewhere. */
const SEARCH_KEYS = [
  'PARALLEL_API_KEY', 'BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY',
  'EXA_API_KEY', 'SERPAPI_API_KEY', 'SERPER_API_KEY', 'PERPLEXITY_API_KEY',
  'BING_SEARCH_API_KEY', 'GOOGLE_SEARCH_API_KEY', 'FIRECRAWL_API_KEY', 'YOU_API_KEY',
  'SEARXNG_BASE_URL',
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Also recognize disabled servers and tool rules, including wildcard rules. */
function hasSearchChoice(value: unknown): boolean {
  if (!record(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    // Claude's onboarding file contains empty MCP maps/lists even before the
    // user configures any tools. Those are not a saved provider choice.
    if (/mcp/i.test(key) && (typeof entry === 'boolean'
      || (typeof entry === 'string' && entry.length > 0)
      || (Array.isArray(entry) && entry.length > 0)
      || (record(entry) && Object.keys(entry).length > 0))) return true;
    if (key === 'permissions' && record(entry)) {
      for (const rules of Object.values(entry)) {
        if (Array.isArray(rules) && rules.some(rule =>
          typeof rule === 'string' && /^(?:WebSearch|WebFetch|ToolSearch|mcp__|\*)/i.test(rule.trim()))) return true;
      }
    }
    if (key === 'env' && record(entry) && SEARCH_KEYS.some(name => entry[name])) return true;
    if (hasSearchChoice(entry)) return true;
  }
  return false;
}

function configFiles(cwd: string, env: NodeJS.ProcessEnv): { user: string[]; managed: string[] } {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const user = [
    path.join(home, '.claude.json'),
    path.join(configDir, '.claude.json'),
    path.join(configDir, 'settings.json'),
    path.join(configDir, 'settings.local.json'),
    path.join(configDir, '.mcp.json'),
  ];
  // Claude can inherit project configuration from a parent of the session cwd.
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    user.push(path.join(dir, '.mcp.json'), path.join(dir, '.claude', 'settings.json'),
      path.join(dir, '.claude', 'settings.local.json'));
    if (path.dirname(dir) === dir) break;
  }
  const managedDir = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
    : process.platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
      : '/etc/claude-code';
  return {
    user: [...new Set(user)],
    managed: ['managed-settings.json', 'managed-mcp.json', 'managed-settings.d']
      .map(name => path.join(managedDir, name)),
  };
}

/** Fail closed on unreadable/malformed configuration and any managed policy. */
function configuredSearch(cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (SEARCH_KEYS.some(name => env[name])) return true;
  const files = configFiles(cwd, env);
  for (const file of [...files.managed, ...files.user]) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (files.managed.includes(file)) return true;
      const value: unknown = JSON.parse(text);
      if (!record(value) || hasSearchChoice(value)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      // A broken config symlink is still an explicit, unusable configuration.
      try { fs.lstatSync(file); return true; } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
  }
  return false;
}

/**
 * auto: keyless Parallel only when no saved search choice/policy exists.
 * builtin: retain the SDK's original behavior.
 * off: remove the built-in web tools and do not register Parallel.
 *
 * No allow-list is added: MCP calls still pass through the bridge's canUseTool.
 * The host/model owns the optional MCP session_id; there is no process-wide ID.
 */
export function resolveSearchOptions(cwd: string, env: NodeJS.ProcessEnv = process.env): SearchOptions {
  const provider = env.CTI_SEARCH_PROVIDER || 'auto';
  if (provider === 'builtin') return {};
  if (provider === 'off') return { disallowedTools: WEB_TOOLS };
  if (provider !== 'auto') {
    throw new Error('CTI_SEARCH_PROVIDER must be auto, builtin, or off');
  }
  if (configuredSearch(cwd, env)) return {};
  return {
    mcpServers: {
      [PARALLEL_SEARCH_SERVER]: {
        type: 'http',
        url: PARALLEL_SEARCH_URL,
        headers: { 'User-Agent': PARALLEL_SEARCH_AGENT },
      },
    },
    disallowedTools: WEB_TOOLS,
  };
}
