/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into the SSE format expected by
 * the claude-to-im bridge conversation engine.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
// Dynamic import - types will be any but actual import works at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any;
import('@anthropic-ai/claude-agent-sdk').then((mod) => {
  query = mod.query;
}).catch(() => {
  // SDK not installed, query will remain undefined
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDKMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PermissionResult = any;
import type { LLMProvider, StreamChatParams, FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import { sseEvent } from './sse-utils.js';

// ── Environment isolation ──

/** Env vars always passed through to the CLI subprocess. */
const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

// ── Auth/credential-error detection ──

/** Patterns indicating the local CLI is not logged in (fixable via `claude auth login`). */
const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

/**
 * Patterns indicating an API-level credential failure (wrong key, expired token, org restriction).
 * Must be specific to API/auth context — avoid matching local file permissions, tool denials,
 * or generic HTTP 403s that may have non-auth causes.
 */
const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

export type AuthErrorKind = 'cli' | 'api' | false;

/**
 * Classify an error message as a CLI login issue, an API credential issue, or neither.
 * Returns 'cli' for local auth problems, 'api' for remote credential problems, false otherwise.
 */
export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

/** Backwards-compatible: returns true for any auth/credential error. */
export function isAuthError(text: string): boolean {
  return classifyAuthError(text) !== false;
}

const CLI_AUTH_USER_MESSAGE =
  'Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, ' +
  'or verify your organization has access to the requested model.';

// ── Cross-runtime model guard ──

const NON_CLAUDE_MODEL_RE = /^(gpt-|o[1-9][-_]|codex[-_]|davinci|text-|openai\/)/i;

/** Return true if a model name clearly belongs to a non-Claude provider. */
export function isNonClaudeModel(model?: string): boolean {
  return !!model && NON_CLAUDE_MODEL_RE.test(model);
}

/**
 * Build a clean env for the CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "inherit"):
 *   "inherit" — full parent env minus CLAUDECODE (recommended; daemon
 *               already runs in a clean launchd/setsid environment)
 *   "strict"  — only whitelist + CTI_* + ANTHROPIC_* from config.env
 */
export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'inherit';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    // Pass everything except always-stripped vars
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    // Strict: whitelist only
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      // Pass through CTI_* so skill config is available
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    // Always pass through ANTHROPIC_* in claude/auto runtime —
    // third-party API providers need these to reach the CLI subprocess.
    const runtime = process.env.CTI_RUNTIME || 'claude';
    if (runtime === 'claude' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('ANTHROPIC_')) out[k] = v;
      }
    }

    // In codex/auto mode, pass through OPENAI_* / CODEX_* env vars
    if (runtime === 'codex' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && (k.startsWith('OPENAI_') || k.startsWith('CODEX_'))) out[k] = v;
      }
    }
  }

  return out;
}

// ── Claude CLI preflight check ──

/** Minimum major version of Claude CLI required by the SDK. */
const MIN_CLI_MAJOR = 2;

/**
 * Parse a version string like "2.3.1" or "claude 2.3.1" into a major number.
 * Returns undefined if parsing fails.
 */
export function parseCliMajorVersion(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Run `claude --version` at a given path and return the version string.
 * Returns undefined on failure.
 */
function getCliVersion(cliPath: string, env?: Record<string, string>): string | undefined {
  try {
    return execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Flags that the SDK passes to the CLI subprocess.
 * If `claude --help` doesn't mention these, the CLI build is incompatible.
 */
const REQUIRED_CLI_FLAGS = ['output-format', 'input-format', 'permission-mode', 'setting-sources'];

/**
 * Check `claude --help` for required flags.
 * Returns the list of missing flags (empty = all present).
 */
function checkRequiredFlags(cliPath: string, env?: Record<string, string>): string[] {
  let helpText: string;
  try {
    helpText = execSync(`"${cliPath}" --help`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Can't run --help; don't block on this — version check is primary
    return [];
  }
  return REQUIRED_CLI_FLAGS.filter(flag => !helpText.includes(flag));
}

/**
 * Check if a CLI path points to a compatible (>= 2.x) Claude CLI
 * with the required flags for SDK integration.
 * Returns { compatible, version, ... } or undefined if the CLI cannot run at all.
 */
export function checkCliCompatibility(cliPath: string, env?: Record<string, string>): {
  compatible: boolean;
  version: string;
  major: number | undefined;
  missingFlags?: string[];
} | undefined {
  const version = getCliVersion(cliPath, env);
  if (!version) return undefined;
  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }
  // Version OK — verify required flags exist
  const missing = checkRequiredFlags(cliPath, env);
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined,
  };
}

/**
 * Run a lightweight preflight check to verify the claude CLI can start
 * and supports the flags required by the SDK.
 * Returns { ok, version?, error? }.
 */
export function preflightCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  const cleanEnv = buildSubprocessEnv();
  const compat = checkCliCompatibility(cliPath, cleanEnv);
  if (!compat) {
    return { ok: false, error: `claude CLI at "${cliPath}" failed to execute` };
  }
  if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x). ` +
        `This is likely an npm-installed 1.x CLI. Install the native CLI: https://docs.anthropic.com/en/docs/claude-code`,
    };
  }
  if (compat.missingFlags) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI ${compat.version} is missing required flags: ${compat.missingFlags.join(', ')}. ` +
        `Update the CLI: npm update -g @anthropic-ai/claude-code`,
    };
  }
  return { ok: true, version: compat.version };
}

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve all `claude` executables found in PATH (Unix only).
 * Returns an array of absolute paths.
 */
function findAllInPath(): string[] {
  if (process.platform === 'win32') {
    try {
      return execSync('where claude', { encoding: 'utf-8', timeout: 3000 })
        .trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }
  try {
    // `which -a` lists all matches, not just the first
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Resolve the path to the `claude` CLI executable.
 *
 * Priority:
 *   1. CTI_CLAUDE_CODE_EXECUTABLE env var (explicit override)
 *   2. All `claude` executables in PATH — pick first compatible (>= 2.x)
 *   3. Common install locations — pick first compatible (>= 2.x)
 *
 * This multi-candidate approach handles the common scenario where
 * nvm/npm puts an old 1.x claude in PATH before the native 2.x CLI.
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Explicit env var — trust the user
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  // 2. Gather all candidates
  const isWindows = process.platform === 'win32';
  const pathCandidates = findAllInPath();
  const wellKnown = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        `${process.env.HOME}/.claude/local/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
      ];

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  // 3. Pick the first compatible candidate
  let firstUnverifiable: string | undefined;
  for (const p of allCandidates) {
    if (!isExecutable(p)) continue;

    const compat = checkCliCompatibility(p);
    if (compat?.compatible) {
      if (p !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(`[llm-provider] Skipping incompatible CLI at "${pathCandidates[0]}", using "${p}" (${compat.version})`);
      }
      return p;
    }
    if (compat) {
      // Version detected but too old — skip it entirely, do NOT fall back
      console.warn(`[llm-provider] CLI at "${p}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`);
    } else if (!firstUnverifiable) {
      // Executable exists but --version failed (timeout, crash, etc.)
      // Keep as last-resort fallback only if NO candidate had a parseable version
      firstUnverifiable = p;
    }
  }

  // Only fall back to an unverifiable executable — never to a known-old one.
  // This avoids silently using a 1.x CLI that will crash on first message.
  return firstUnverifiable;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return (async function* () { yield msg; })();
}

/**
 * Mutable state shared between the streaming loop and catch block.
 *
 * Key distinction:
 *   hasReceivedResult — set when the SDK delivers a `result` message
 *     (success OR structured error). This means the CLI completed its
 *     business logic; any subsequent "process exited with code 1" is
 *     just the transport tearing down and should be suppressed.
 *
 *   hasStreamedText — set when at least one text_delta was emitted.
 *     Used to distinguish "partial output + crash" (real failure, must
 *     emit error) from "business error only in assistant block" (use
 *     lastAssistantText instead of generic error).
 */
export interface StreamState {
  /** True once a `result` message (success or error subtype) has been processed. */
  hasReceivedResult: boolean;
  /** True once any text_delta has been emitted via stream_event. */
  hasStreamedText: boolean;
  /**
   * Full text captured from the final `assistant` message.
   * NOT emitted during normal flow (stream_event deltas handle that).
   * Used by the catch block to surface business errors that arrived
   * as assistant text but were followed by a CLI crash.
   */
  lastAssistantText: string;
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;

  constructor(private pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

    return new ReadableStream({
      start(controller) {
        (async () => {
          // Ring-buffer for recent stderr output (max 4 KB)
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          const state: StreamState = { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };

          try {
            const cleanEnv = buildSubprocessEnv();

            // Cross-runtime migration safety: drop non-Claude model names
            // that may linger in session data from a previous Codex runtime.
            let model = params.model;
            if (isNonClaudeModel(model)) {
              console.warn(`[llm-provider] Ignoring non-Claude model "${model}", using CLI default`);
              model = undefined;
            }

            // Only pass model to CLI if explicitly configured via CTI_DEFAULT_MODEL.
            // Letting the CLI choose its own default avoids exit-code-1 failures
            // when a stored model is inaccessible on the current machine/plan.
            const passModel = !!process.env.CTI_DEFAULT_MODEL;
            if (model && !passModel) {
              console.log(`[llm-provider] Skipping model "${model}", using CLI default (set CTI_DEFAULT_MODEL to override)`);
              model = undefined;
            }

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              includePartialMessages: true,
              env: cleanEnv,
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > MAX_STDERR) {
                  stderrBuf = stderrBuf.slice(-MAX_STDERR);
                }
              },
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<PermissionResult> => {
                  // Auto-approve if configured (useful for channels without
                  // interactive permission UI, e.g. Feishu WebSocket mode)
                  if (autoApprove) {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }

                  // Emit permission_request SSE event for the bridge
                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  // Block until IM user responds
                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const q = query({
              prompt: prompt as any,
              options: queryOptions as any,
            });

            for await (const msg of q) {
              handleMessage(msg, controller, state);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[llm-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            if (stderrBuf) {
              console.error('[llm-provider] stderr from CLI:', stderrBuf.trim());
            }

            const isTransportExit = message.includes('process exited with code');

            // ── Case 1: Result already received ──
            // The SDK delivered a proper result (success or structured error).
            // A trailing "process exited with code 1" is transport teardown noise.
            if (state.hasReceivedResult && isTransportExit) {
              console.log('[llm-provider] Suppressing transport error — result already received');
              controller.close();
              return;
            }

            // ── Case 2: Recognised business error in assistant text ──
            // The CLI returned an assistant message with text that matches
            // a known auth/access error pattern (e.g. "Your organization
            // does not have access to Claude"). Forward it as-is — it's
            // more informative than the generic transport error.
            // Only activate when the text is a recognised error; otherwise
            // a normal response that crashed before result would be silently
            // presented as if it succeeded.
            if (state.lastAssistantText && classifyAuthError(state.lastAssistantText)) {
              controller.enqueue(sseEvent('text', state.lastAssistantText));
              controller.close();
              return;
            }

            // ── Case 3: Partial output + crash ──
            // Text was streamed but no result arrived — the response was
            // truncated by a real crash. Always emit an error so the user
            // knows the output is incomplete.

            // ── Build user-facing error message ──
            const authKind = classifyAuthError(message) || classifyAuthError(stderrBuf);
            let userMessage: string;
            if (authKind === 'cli') {
              userMessage = CLI_AUTH_USER_MESSAGE;
            } else if (authKind === 'api') {
              userMessage = API_AUTH_USER_MESSAGE;
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
              }
              lines.push(
                '',
                'Possible causes:',
                '• Claude CLI not authenticated — run: claude auth login',
                '• Claude CLI version too old (need >= 2.x) — run: claude --version',
                '• Missing ANTHROPIC_* env vars in daemon — check config.env',
                '',
                'Run `/claude-to-im doctor` to diagnose.',
              );
              userMessage = lines.join('\n');
            } else {
              userMessage = message;
            }

            controller.enqueue(sseEvent('error', userMessage));
            controller.close();
          }
        })();
      },
    });
  }
}

/** @internal Exported for testing. */
export function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        // Emit delta text — the bridge accumulates on its side
        controller.enqueue(sseEvent('text', event.delta.text));
        state.hasStreamedText = true;
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      // Full assistant message — capture text but do NOT emit it.
      // Text deltas are already streamed via stream_event above; emitting
      // the full text block here would duplicate the entire response.
      //
      // The captured text is used by the catch block to surface business
      // errors (e.g. "Your organization does not have access") that the
      // CLI returned as assistant text without prior streaming deltas.
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            controller.enqueue(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      // User messages contain tool_result blocks from completed tool calls
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            controller.enqueue(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        // Error result from SDK (distinct from transport errors in catch)
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      // Ignore other message types (auth_status, task_notification, etc.)
      break;
  }
}
