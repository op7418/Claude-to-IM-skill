/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';
import './adapters/weixin-adapter.js';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, saveConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Session scanning ──

interface SessionEntry {
  id: string;
  origin: string; // 'cli', 'sdk', 'vscode', 'claude'
  cwd: string;
  mtime: number; // file modification time for sorting
  preview: string; // first user message, truncated
  filePath: string; // absolute path to session file
}

const CODEX_HOME = path.join(process.env.HOME || '~', '.codex');
const CLAUDE_HOME = path.join(process.env.HOME || '~', '.claude', 'projects');

// Messages to skip when building session preview
const SKIP_PATTERNS = [
  /^# AGENTS\.md/i,
  /^<environment_context/,
  /^<INSTRUCTIONS/,
  /^你是什么模型/,
  /^你有哪些技[能术]/,
  /^你当前在[哪那]个/,
  /^codex resume/i,
  /^codex --version/i,
  /^你是谁/,
  /^what model/i,
  /^what are you/i,
];

function shouldSkipPreview(text: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(text.trim()));
}

/** Extract a meaningful user message preview from a Codex JSONL session file. */
function extractCodexPreview(filePath: string): string {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const d = JSON.parse(line);
      if (d.type === 'response_item' && d.payload?.role === 'user') {
        const content = d.payload.content || [];
        for (const c of content) {
          if (c.type === 'input_text' && c.text) {
            const text = c.text.trim();
            if (text.length < 5 || shouldSkipPreview(text)) continue;
            return text.length > 50 ? text.slice(0, 50) + '...' : text;
          }
        }
      }
    }
  } catch { /* skip */ }
  return '';
}

/** Extract a meaningful user message preview from a Claude Code JSONL session file. */
function extractClaudePreview(filePath: string): string {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const d = JSON.parse(line);
      if (d.type === 'user') {
        const content = d.message?.content || d.content || '';
        if (typeof content === 'string') {
          const text = content.trim();
          if (text.length < 5 || shouldSkipPreview(text)) continue;
          return text.length > 50 ? text.slice(0, 50) + '...' : text;
        }
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text) {
              const text = c.text.trim();
              if (text.length < 5 || shouldSkipPreview(text)) continue;
              return text.length > 50 ? text.slice(0, 50) + '...' : text;
            }
          }
        }
      }
    }
  } catch { /* skip */ }
  return '';
}

/** Scan sessions filtered by cwd, sorted by file mtime (newest first). */
function scanAllSessions(limit = 10, runtimeFilter?: 'claude' | 'codex', cwd?: string): SessionEntry[] {
  const sessions: SessionEntry[] = [];

  // Scan Codex sessions (skip if filtering for claude only)
  if (runtimeFilter !== 'claude') {
    const codexDir = path.join(CODEX_HOME, 'sessions');
  try {
    const years = fs.readdirSync(codexDir).filter(d => /^\d{4}$/.test(d)).sort().reverse();
    for (const year of years) {
      const yearDir = path.join(codexDir, year);
      for (const month of fs.readdirSync(yearDir).sort().reverse()) {
        const monthDir = path.join(yearDir, month);
        for (const day of fs.readdirSync(monthDir).sort().reverse()) {
          const dayDir = path.join(monthDir, day);
          for (const file of fs.readdirSync(dayDir).filter(f => f.endsWith('.jsonl')).sort().reverse()) {
            const fp = path.join(dayDir, file);
            try {
              const stat = fs.statSync(fp);
              const meta = JSON.parse(fs.readFileSync(fp, 'utf-8').split('\n')[0]);
              if (meta.type === 'session_meta' && meta.payload?.id) {
                const p = meta.payload;
                // Filter by cwd if provided — skip if cwd is unknown or mismatched
                if (cwd && (!p.cwd || p.cwd !== cwd)) continue;
                const originMap: Record<string, string> = {
                  codex_cli_rs: 'cli',
                  'codex-tui': 'tui',
                  codex_sdk_ts: 'sdk',
                  codex_vscode: 'vscode',
                  codex_exec: 'exec',
                };
                sessions.push({
                  id: p.id,
                  origin: originMap[p.originator] || p.originator,
                  cwd: p.cwd || '?',
                  mtime: stat.mtimeMs,
                  preview: extractCodexPreview(fp),
                  filePath: fp,
                });
              }
            } catch { /* skip */ }
          }
        }
      }
    }
  } catch { /* no codex sessions */ }
  } // end codex filter

  // Scan Claude Code sessions (skip if filtering for codex only)
  if (runtimeFilter !== 'codex') {
  try {
    for (const projectDir of fs.readdirSync(CLAUDE_HOME)) {
      const projectPath = path.join(CLAUDE_HOME, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;
      for (const file of fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(projectPath, file);
        try {
          const stat = fs.statSync(fp);
          const lines = fs.readFileSync(fp, 'utf-8').split('\n');
          let sessionCwd = projectDir.replace(/^-/, '/').replace(/-/g, '/');
          let sessionId = file.replace('.jsonl', '');
          for (const line of lines) {
            if (!line) continue;
            const d = JSON.parse(line);
            if (d.cwd) {
              sessionCwd = d.cwd;
              break;
            }
          }
          // Filter by cwd if provided — skip if cwd is unknown or mismatched
          if (cwd && (!sessionCwd || sessionCwd !== cwd)) continue;
          sessions.push({
            id: sessionId,
            origin: 'claude',
            cwd: sessionCwd,
            mtime: stat.mtimeMs,
            preview: extractClaudePreview(fp),
            filePath: fp,
          });
        } catch { /* skip */ }
      }
    }
  } catch { /* no claude sessions */ }
  } // end claude filter

  // Sort by file mtime, newest first
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, limit);
}

// ── Pending session selection state ──
// Maps chatId → { ids, expiresAt }. Auto-expires after 5 minutes.
interface PendingSelection {
  ids: string[];
  expiresAt: number;
}
const pendingSessionSelections = new Map<string, PendingSelection>();
const SELECTION_TTL_MS = 5 * 60 * 1000;

function getPendingIds(chatId: string): string[] | null {
  const entry = pendingSessionSelections.get(chatId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingSessionSelections.delete(chatId);
    return null;
  }
  return entry.ids;
}

function setPendingIds(chatId: string, ids: string[]): void {
  // Clean up expired entries periodically
  if (pendingSessionSelections.size > 50) {
    const now = Date.now();
    for (const [k, v] of pendingSessionSelections) {
      if (now > v.expiresAt) pendingSessionSelections.delete(k);
    }
  }
  pendingSessionSelections.set(chatId, { ids, expiresAt: Date.now() + SELECTION_TTL_MS });
}

/**
 * Resolve the LLM provider based on the runtime setting.
 * - 'claude' (default): uses Claude Code SDK via SDKLLMProvider
 * - 'codex': uses @openai/codex-sdk via CodexProvider
 * - 'auto': tries Claude first, falls back to Codex
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms);
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      // Auto mode: preflight the resolved CLI before committing to it.
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      }
      // Preflight failed — fall through to Codex instead of silently using a broken CLI
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        `  Falling back to Codex.`,
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms);
  }

  // Default: claude
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or: Set CTI_RUNTIME=codex to use Codex instead',
    );
    process.exit(1);
  }

  // Preflight: verify the CLI can actually run in the daemon environment.
  // In claude runtime this is fatal — starting with a broken CLI would just
  // defer the error to the first user message, which is harder to diagnose.
  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      `  Fix:\n` +
      `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
      `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
      `    3. Or set CTI_RUNTIME=auto to fall back to Codex`,
    );
    process.exit(1);
  }

  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  let currentLLM = llm;

  initBridgeContext({
    store,
    llm: currentLLM,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
    updateLLMProvider(provider: LLMProvider) {
      currentLLM = provider;
      const ctx = (globalThis as Record<string, unknown>)['__bridge_context__'] as Record<string, unknown>;
      if (ctx) ctx.llm = provider;
    },
    async onCommand(command: string, args: string, chatId: string): Promise<string | undefined> {
      // ── /status: show current binding info + Codex thread ID ──
      if (command === '/status') {
        const bindings = store.listChannelBindings();
        const binding = bindings.find(b => b.chatId === chatId);
        const lines = [
          '<b>Bridge Status</b>',
          '',
          `Session: <code>${binding?.codepilotSessionId?.slice(0, 8) || 'none'}...</code>`,
          `CWD: <code>${escapeHtml(binding?.workingDirectory || '~')}</code>`,
          `Mode: <b>${binding?.mode || 'code'}</b>`,
          `Model: <code>${binding?.model || 'default'}</code>`,
          `Runtime: <b>${config.runtime}</b>`,
        ];
        if (binding?.sdkSessionId) {
          const isClaude = config.runtime !== 'codex';
          lines.push('');
          lines.push(`${isClaude ? 'Session' : 'Thread'}: <code>${binding.sdkSessionId}</code>`);
          if (isClaude) {
            lines.push(`电脑端恢复: claude --resume ${binding.sdkSessionId}`);
          } else {
            lines.push(`电脑端恢复: codex resume ${binding.sdkSessionId}`);
          }
        }
        return lines.join('\n');
      }

      // ── /sessions: scan sessions and show numbered list ──
      if (command === '/sessions') {
        const allBindings = store.listChannelBindings();
        const binding = allBindings.find(b => b.chatId === chatId);
        const currentSessionId = binding?.sdkSessionId;
        const isClaude = config.runtime !== 'codex';
        const runtimeFilter = isClaude ? 'claude' : 'codex' as const;
        const currentCwd = binding?.workingDirectory;
        const sessions = scanAllSessions(10, runtimeFilter, currentCwd);

        if (sessions.length === 0) {
          return `No ${isClaude ? 'Claude Code' : 'Codex'} sessions in <code>${escapeHtml(currentCwd || '~')}</code>`;
        }

        const lines = ['<b>Sessions:</b>', ''];
        const sessionIds: string[] = [];

        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          sessionIds.push(s.id);

          const date = new Date(s.mtime).toLocaleDateString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
          });
          const time = new Date(s.mtime).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });

          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ← 当前' : '';
          const preview = s.preview ? `\n   "${s.preview}"` : '';

          lines.push(`[${i + 1}] ${date} ${time} ${s.origin} ${marker}`);
          if (preview) lines.push(preview);
        }

        lines.push('');
        lines.push('回复数字切换到对应 session');

        // Store pending selections for this chat
        setPendingIds(chatId, sessionIds);

        return lines.join('\n');
      }

      // ── /runtime: switch LLM provider ──
      if (command === '/runtime') {
        const validRuntimes = ['claude', 'codex', 'auto'];
        const newRuntime = args.trim().toLowerCase();

        if (!newRuntime) {
          return `Current runtime: <b>${config.runtime}</b>\nUsage: /runtime claude|codex|auto`;
        }

        if (!validRuntimes.includes(newRuntime)) {
          return `Invalid runtime: <b>${escapeHtml(newRuntime)}</b>\nValid options: claude, codex, auto`;
        }

        if (newRuntime === config.runtime) {
          return `Runtime is already <b>${config.runtime}</b>`;
        }

        try {
          config.runtime = newRuntime as Config['runtime'];
          saveConfig(config);
          const newProvider = await resolveProvider(config, pendingPerms);
          const ctx = (globalThis as Record<string, unknown>)['__bridge_context__'] as Record<string, unknown>;
          if (ctx) ctx.llm = newProvider;
          currentLLM = newProvider;
          console.log(`[claude-to-im] Runtime switched to: ${newRuntime}`);
          return `Runtime switched to <b>${newRuntime}</b>.\nNew sessions will use the ${newRuntime === 'codex' ? 'Codex' : newRuntime === 'auto' ? 'auto-detected' : 'Claude Code'} provider.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[claude-to-im] Failed to switch runtime: ${msg}`);
          return `Failed to switch runtime: ${escapeHtml(msg)}`;
        }
      }
      return undefined;
    },
    extraHelpLines(): string[] {
      return [
        '/runtime claude|codex|auto - Switch LLM runtime',
      ];
    },
    async onMessage(text: string, chatId: string): Promise<string | undefined> {
      // Numeric session selection: reply "1", "2", etc. after /sessions
      const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (/^[1-9]$|^10$/.test(normalized)) {
        const pendingIds = getPendingIds(chatId);
        if (pendingIds && pendingIds.length > 0) {
          const idx = parseInt(normalized, 10) - 1;
          if (idx >= 0 && idx < pendingIds.length) {
            const sessionId = pendingIds[idx];

            // Find the binding for this chat
            const allBindings = store.listChannelBindings();
            const binding = allBindings.find(b => b.chatId === chatId);

            if (binding) {
              store.updateSdkSessionId(binding.codepilotSessionId, sessionId);
              pendingSessionSelections.delete(chatId);
              console.log(`[claude-to-im] Bound session ${chatId} to thread ${sessionId}`);

              const rtFilter = config.runtime !== 'codex' ? 'claude' : 'codex' as const;
              const sessions = scanAllSessions(10, rtFilter, binding.workingDirectory);
              const sessionInfo = sessions.find(s => s.id === sessionId);
              const preview = sessionInfo?.preview ? `\n"${sessionInfo.preview}"` : '';

              return `已切换到 session [${normalized}]${preview}\n下次对话将 resume 此 session`;
            }
          }
          // Invalid number, clear pending selections
          pendingSessionSelections.delete(chatId);
          return `无效的选择。请先发 /sessions 查看列表。`;
        }
      }
      return undefined;
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
