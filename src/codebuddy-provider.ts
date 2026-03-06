/**
 * CodeBuddy Provider — LLMProvider implementation backed by @tencent-ai/agent-sdk.
 *
 * Maps CodeBuddy SDK stream events to the SSE stream format consumed by
 * the bridge conversation engine, making CodeBuddy a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Key differences from the Claude provider (llm-provider.ts):
 * - SDK import: @tencent-ai/agent-sdk instead of @anthropic-ai/claude-agent-sdk
 * - CLI option key: pathToCodebuddyCode instead of pathToClaudeCodeExecutable
 * - Permission allow response requires { updatedInput } field
 * - CLI path must be symlink-resolved (SDK derives headless entry point
 *   relative to the binary location)
 * - Env isolation strips CODEBUDDY* prefix instead of CLAUDECODE
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { query } from '@tencent-ai/agent-sdk';
import type { Message, PermissionResult } from '@tencent-ai/agent-sdk';
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
  // Windows-specific vars required for CLI subprocess to locate user profile,
  // npm global binaries, system root, and run .cmd/.bat shims correctly.
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
  'SystemRoot', 'SystemDrive', 'COMSPEC',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'WINDIR',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CODEBUDDY'];

/**
 * Build a clean env for the CodeBuddy CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "strict"):
 *   "strict"  — only whitelist + CTI_*
 *   "inherit" — full parent env minus CODEBUDDY*
 */
function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'strict';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.some(prefix => k.startsWith(prefix))) continue;
      out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
  }

  return out;
}

// ── CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * On Windows, npm installs a .cmd shim that wraps the real JS entry point.
 * The SDK's ProcessTransport only recognises paths ending in /bin/codebuddy
 * (or \bin\codebuddy) to derive dist/codebuddy-headless.js.  A .cmd path
 * is neither a .exe nor a recognised bin path, so the SDK ends up running
 * `node codebuddy.cmd` which closes immediately.
 *
 * This helper parses the .cmd shim content to extract the real bin path.
 * npm shims have a fixed format; the final exec line looks like:
 *   "%_prog%"  "%dp0%\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy" %*
 * We extract the quoted token that contains both "bin" and "codebuddy",
 * replace %dp0% with the .cmd directory, and normalise to forward slashes.
 */
function resolveCmdShim(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const dir = cmdPath.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
    for (const line of content.split('\n')) {
      if (!line.includes('dp0') || !line.includes('bin')) continue;
      // Extract all double-quoted tokens from the line
      const tokens = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]);
      const binToken = tokens.find(
        t => t.includes('bin') && t.toLowerCase().includes('codebuddy'),
      );
      if (!binToken) continue;
      const resolved = binToken
        .replace(/%dp0%\\/gi, dir + '/')
        .replace(/\\/g, '/');
      if (isExecutable(resolved)) return resolved;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Resolve the path to the `codebuddy` CLI executable.
 *
 * IMPORTANT: The SDK's ProcessTransport derives the headless entry point
 * relative to the binary location (bin/codebuddy → dist/codebuddy-headless.js).
 * On Unix, symlinks are resolved so the real bin path is returned.
 * On Windows, npm creates a .cmd shim — we parse it to recover the real
 * bin/codebuddy path so the SDK can locate codebuddy-headless.js correctly.
 */
export function resolveCodebuddyCliPath(): string | undefined {
  const isWindows = process.platform === 'win32';

  const resolveUnix = (p: string): string => {
    try { return fs.realpathSync(p); } catch { return p; }
  };

  // 1. Explicit env var
  const fromEnv = process.env.CTI_CODEBUDDY_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) {
    return isWindows ? fromEnv : resolveUnix(fromEnv);
  }

  // 2. Platform-specific PATH lookup
  const whichCmd = isWindows ? 'where codebuddy' : 'which codebuddy';
  try {
    // `where` returns multiple lines on Windows; prefer the .cmd shim line
    const lines = execSync(whichCmd, { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').map(l => l.trim()).filter(Boolean);

    if (isWindows) {
      // Try to unwrap .cmd shim first
      const cmdLine = lines.find(l => l.toLowerCase().endsWith('.cmd'));
      if (cmdLine) {
        const real = resolveCmdShim(cmdLine);
        if (real) return real;
      }
      // Fall back to first executable found
      const first = lines[0];
      if (first && isExecutable(first)) return first;
    } else {
      const first = lines[0];
      if (first && isExecutable(first)) return resolveUnix(first);
    }
  } catch {
    // not found in PATH
  }

  // 3. Common install locations
  const candidates = isWindows
    ? [
        process.env.APPDATA ? `${process.env.APPDATA}\\npm\\codebuddy.cmd` : '',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\codebuddy\\codebuddy.exe` : '',
      ].filter(Boolean)
    : [
        '/usr/local/bin/codebuddy',
        '/opt/homebrew/bin/codebuddy',
        `${process.env.HOME}/.npm-global/bin/codebuddy`,
        `${process.env.HOME}/.local/bin/codebuddy`,
      ];

  for (const p of candidates) {
    if (!p) continue;
    if (isWindows) {
      if (p.endsWith('.cmd')) {
        const real = resolveCmdShim(p);
        if (real) return real;
      } else if (isExecutable(p)) {
        return p;
      }
    } else {
      if (isExecutable(p)) return resolveUnix(p);
    }
  }

  return undefined;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

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

// ── Provider ──

export class CodeBuddyLLMProvider implements LLMProvider {
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
          try {
            const cleanEnv = buildSubprocessEnv();

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model: params.model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              includePartialMessages: true,
              env: cleanEnv,
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: unknown[]; signal: AbortSignal },
                ): Promise<PermissionResult> => {
                  // Auto-approve if configured (useful for channels without
                  // interactive permission UI, e.g. Feishu WebSocket mode)
                  if (autoApprove) {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }

                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    // CodeBuddy SDK requires updatedInput in allow response
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToCodebuddyCode = cliPath;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            for await (const msg of q) {
              handleMessage(msg, controller);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codebuddy-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });
  }
}

// ── SDK message → SSE event mapping ──

function handleMessage(
  msg: Message,
  controller: ReadableStreamDefaultController<string>,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        controller.enqueue(sseEvent('text', event.delta.text));
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
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
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
      break;
  }
}
