/**
 * Codex Provider — LLMProvider implementation backed by the Codex CLI JSONL
 * stream. We keep the old SDK-backed path only for injected test doubles.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import { CTI_HOME } from './config.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 120_000;
const SHARED_CODEX_HOME_NAME = '.codex';
const BRIDGE_CODEX_HOME_NAME = 'codex-home';
const DEFAULT_CODEX_EXECUTABLE = 'codex';
const CLI_WATCHDOG_INTERVAL_MS = 1_000;
const FORWARDED_CODEX_ENV_KEYS = [
  'HOME',
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'TERM',
  'TERMINFO',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

class CodexStreamAbortedError extends Error {
  constructor() {
    super('Codex stream aborted');
    this.name = 'CodexStreamAbortedError';
  }
}

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldUseSharedCodexHome(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CTI_CODEX_USE_SHARED_HOME === 'true';
}

export function toUserVisibleCodexErrorMessage(message: string): string {
  const stalled = message.match(/^Codex stream stalled after (.+) for (\d+)ms$/i);
  if (stalled) {
    const [, context, timeoutMs] = stalled;
    const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000));
    if (context === 'thread.started') {
      return `Codex 已开始处理，但在 ${seconds} 秒内没有继续返回内容。请稍后重试。`;
    }
    return `Codex 在 ${context} 之后卡住了，${seconds} 秒内没有继续返回内容。请稍后重试。`;
  }

  return message;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function getCodexStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.CTI_CODEX_STREAM_IDLE_TIMEOUT_MS, DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS);
}

function ensureDirectory(dirPath: string, mode: number): void {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch {
    // Ignore chmod failures on filesystems that do not support it
  }
}

function syncFileIfPresent(sourcePath: string, targetPath: string, mode: number): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Ignore chmod failures on filesystems that do not support it
  }
}

export function prepareBridgeCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  options: { ctiHome?: string } = {},
): string {
  const userHome = env.HOME || os.homedir();
  const ctiHome = options.ctiHome || CTI_HOME;
  const bridgeCodexHome = path.join(ctiHome, BRIDGE_CODEX_HOME_NAME);
  const sharedCodexHome = path.join(userHome, SHARED_CODEX_HOME_NAME);

  ensureDirectory(bridgeCodexHome, 0o700);
  syncFileIfPresent(
    path.join(sharedCodexHome, 'auth.json'),
    path.join(bridgeCodexHome, 'auth.json'),
    0o600,
  );

  return bridgeCodexHome;
}

export function buildCodexCliEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { ctiHome?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of FORWARDED_CODEX_ENV_KEYS) {
    const value = baseEnv[key];
    if (value) {
      env[key] = value;
    }
  }

  if (!env.HOME) {
    env.HOME = baseEnv.HOME || os.homedir();
  }

  if (shouldUseSharedCodexHome(baseEnv)) {
    if (baseEnv.CODEX_HOME) {
      env.CODEX_HOME = baseEnv.CODEX_HOME;
    }
    return env;
  }

  env.CODEX_HOME = prepareBridgeCodexHome({ ...baseEnv, HOME: env.HOME }, options);
  return env;
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.CTI_CODEX_EXECUTABLE || DEFAULT_CODEX_EXECUTABLE;
}

function getCliWatchdogIntervalMs(timeoutMs: number): number {
  return Math.max(10, Math.min(CLI_WATCHDOG_INTERVAL_MS, Math.floor(timeoutMs / 2) || 10));
}

function toSandboxMode(permissionMode?: string): 'workspace-write' | 'read-only' {
  return permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
}

export function buildCodexExecArgs(
  params: Pick<StreamChatParams, 'permissionMode' | 'workingDirectory' | 'model'>,
  options: {
    resumeThreadId?: string;
    imagePaths?: string[];
  } = {},
): string[] {
  const args: string[] = ['exec'];

  if (options.resumeThreadId) {
    args.push('resume');
  }

  args.push('--json');
  args.push('-c', `approval_policy=${JSON.stringify('never')}`);
  args.push('-c', `sandbox_mode=${JSON.stringify(toSandboxMode(params.permissionMode))}`);

  if (shouldSkipGitRepoCheck()) {
    args.push('--skip-git-repo-check');
  }

  if (params.workingDirectory) {
    args.push('-C', params.workingDirectory);
  }

  if (shouldPassModelToCodex() && params.model) {
    args.push('-m', params.model);
  }

  for (const imagePath of options.imagePaths ?? []) {
    args.push('-i', imagePath);
  }

  if (options.resumeThreadId) {
    args.push(options.resumeThreadId);
  }
  args.push('-');

  return args;
}

function isTransientCodexCliMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.startsWith('reconnecting...') ||
    lower.includes('falling back from websockets to https transport') ||
    lower.includes('falling back to http')
  );
}

function isCodexCliStatusItem(item: Record<string, unknown>): boolean {
  return item.type === 'error' && typeof item.message === 'string' && isTransientCodexCliMessage(item.message);
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;
  private loggedCliEnv = false;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  private spawnCodexProcess(
    args: string[],
    options: {
      cwd?: string;
      env: Record<string, string>;
    },
  ): ChildProcessWithoutNullStreams {
    return spawn(resolveCodexExecutable(), args, {
      cwd: options.cwd || process.cwd(),
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;
    const cliEnv = buildCodexCliEnv();

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      env: cliEnv,
    });

    if (cliEnv.CODEX_HOME) {
      console.log(`[codex-provider] Using isolated Codex home: ${cliEnv.CODEX_HOME}`);
    }

    return { sdk: this.sdk, codex: this.codex };
  }

  private async readNextEvent(
    iterator: AsyncIterator<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal,
    context?: string,
  ): Promise<IteratorResult<Record<string, unknown>>> {
    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const nextPromise = iterator.next();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const message = context
          ? `Codex stream stalled after ${context} for ${timeoutMs}ms`
          : `Codex stream stalled for ${timeoutMs}ms`;
        reject(new Error(message));
      }, timeoutMs);
    });

    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new CodexStreamAbortedError());
          return;
        }
        abortHandler = () => reject(new CodexStreamAbortedError());
        signal.addEventListener('abort', abortHandler, { once: true });
      })
      : undefined;

    try {
      const waiters: Array<Promise<IteratorResult<Record<string, unknown>> | never>> = [nextPromise, timeoutPromise];
      if (abortPromise) {
        waiters.push(abortPromise);
      }
      return await Promise.race(waiters);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  private async streamChatViaCli(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    imagePaths: string[],
  ): Promise<void> {
    const cliEnv = buildCodexCliEnv();
    if (cliEnv.CODEX_HOME && !this.loggedCliEnv) {
      console.log(`[codex-provider] Using isolated Codex home: ${cliEnv.CODEX_HOME}`);
      this.loggedCliEnv = true;
    }

    let savedThreadId = this.threadIds.get(params.sessionId) || params.sdkSessionId || undefined;
    let retriedFresh = false;

    while (true) {
      const args = buildCodexExecArgs(params, {
        resumeThreadId: savedThreadId,
        imagePaths,
      });
      const child = this.spawnCodexProcess(args, {
        cwd: params.workingDirectory || process.cwd(),
        env: cliEnv,
      });

      const outcome = await new Promise<{
        kind: 'success' | 'abort' | 'retry-fresh' | 'error';
        error?: Error;
      }>((resolve) => {
        const timeoutMs = getCodexStreamIdleTimeoutMs();
        let stdoutLines: ReturnType<typeof createInterface> | null = null;
        let settled = false;
        let lastActivityAt = Date.now();
        let lastContext = savedThreadId ? 'resume start' : 'turn start';
        let sawMeaningfulEvent = false;
        let sawResult = false;
        let pendingErrorMessage = '';
        let stalledError: Error | null = null;
        let stderrBuf = '';
        let aborted = false;

        const settle = (next: { kind: 'success' | 'abort' | 'retry-fresh' | 'error'; error?: Error }) => {
          if (settled) {
            return;
          }
          settled = true;
          clearInterval(watchdog);
          params.abortController?.signal.removeEventListener('abort', onAbort);
          stdoutLines?.close();
          resolve(next);
        };

        const touch = (context?: string) => {
          lastActivityAt = Date.now();
          if (context) {
            lastContext = context;
          }
        };

        const onAbort = () => {
          aborted = true;
          child.kill('SIGTERM');
        };

        const watchdog = setInterval(() => {
          if (Date.now() - lastActivityAt <= timeoutMs) {
            return;
          }
          stalledError = new Error(`Codex stream stalled after ${lastContext} for ${timeoutMs}ms`);
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
        }, getCliWatchdogIntervalMs(timeoutMs));

        if (params.abortController?.signal.aborted) {
          onAbort();
        } else {
          params.abortController?.signal.addEventListener('abort', onAbort, { once: true });
        }

        stdoutLines = createInterface({ input: child.stdout });
        stdoutLines.on('line', (line) => {
          touch(lastContext);

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return;
          }

          const type = String(event.type || 'unknown event');
          lastContext = type;

          switch (type) {
            case 'thread.started': {
              const threadId = event.thread_id as string | undefined;
              if (threadId) {
                this.threadIds.set(params.sessionId, threadId);
                controller.enqueue(sseEvent('status', { session_id: threadId }));
              }
              sawMeaningfulEvent = true;
              break;
            }

            case 'turn.started':
              sawMeaningfulEvent = true;
              break;

            case 'item.completed': {
              const item = event.item as Record<string, unknown> | undefined;
              if (!item) {
                break;
              }
              if (isCodexCliStatusItem(item)) {
                console.warn('[codex-provider] CLI transport status:', item.message);
                break;
              }
              if (item.type === 'error') {
                pendingErrorMessage = String(item.message || 'Thread error');
                break;
              }
              sawMeaningfulEvent = true;
              this.handleCompletedItem(controller, item);
              break;
            }

            case 'turn.completed': {
              sawMeaningfulEvent = true;
              sawResult = true;
              const usage = event.usage as Record<string, unknown> | undefined;
              const threadId = this.threadIds.get(params.sessionId);

              controller.enqueue(sseEvent('result', {
                usage: usage ? {
                  input_tokens: usage.input_tokens ?? 0,
                  output_tokens: usage.output_tokens ?? 0,
                  cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                } : undefined,
                ...(threadId ? { session_id: threadId } : {}),
              }));
              break;
            }

            case 'turn.failed':
              pendingErrorMessage = String((event as { message?: string }).message || 'Turn failed');
              break;

            case 'error': {
              const message = String((event as { message?: string }).message || 'Thread error');
              if (isTransientCodexCliMessage(message)) {
                console.warn('[codex-provider] CLI transport status:', message);
                break;
              }
              pendingErrorMessage = message;
              break;
            }

            default:
              break;
          }
        });

        child.stderr.on('data', (chunk) => {
          touch(lastContext);
          stderrBuf += chunk.toString();
          if (stderrBuf.length > 4096) {
            stderrBuf = stderrBuf.slice(-4096);
          }
        });

        child.on('error', (err) => {
          settle({ kind: 'error', error: err });
        });

        child.on('close', (code, signal) => {
          if (aborted || signal === 'SIGTERM' || signal === 'SIGKILL') {
            if (stalledError) {
              settle({ kind: 'error', error: stalledError });
              return;
            }
            settle({ kind: 'abort' });
            return;
          }

          if (savedThreadId && !retriedFresh && !sawMeaningfulEvent && shouldRetryFreshThread(pendingErrorMessage || stderrBuf)) {
            console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', pendingErrorMessage || stderrBuf);
            settle({ kind: 'retry-fresh' });
            return;
          }

          if (!sawResult && pendingErrorMessage) {
            settle({ kind: 'error', error: new Error(pendingErrorMessage) });
            return;
          }

          if ((code ?? 0) !== 0) {
            const suffix = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
            settle({ kind: 'error', error: new Error(`Codex CLI exited with code ${code}${suffix}`) });
            return;
          }

          settle({ kind: 'success' });
        });

        child.stdin.write(params.prompt);
        child.stdin.end();
      });

      if (outcome.kind === 'retry-fresh') {
        savedThreadId = undefined;
        retriedFresh = true;
        continue;
      }

      if (outcome.kind === 'abort') {
        return;
      }

      if (outcome.kind === 'error') {
        throw outcome.error;
      }

      return;
    }
  }

  private async streamChatViaInjectedSdk(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    input: string | Array<Record<string, string>>,
  ): Promise<void> {
    const { codex } = await this.ensureSDK();

    const inMemoryThreadId = this.threadIds.get(params.sessionId);
    let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;
    const approvalPolicy = toApprovalPolicy(params.permissionMode);
    const passModel = shouldPassModelToCodex();

    const threadOptions: Record<string, unknown> = {
      ...(passModel && params.model ? { model: params.model } : {}),
      ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
      ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
      approvalPolicy,
    };

    let retryFresh = false;

    while (true) {
      let thread: ThreadInstance;
      if (savedThreadId) {
        try {
          thread = codex.resumeThread(savedThreadId, threadOptions);
        } catch {
          thread = codex.startThread(threadOptions);
        }
      } else {
        thread = codex.startThread(threadOptions);
      }

      let sawAnyEvent = false;
      let lastEventType = 'turn start';
      try {
        const { events } = await thread.runStreamed(input);
        const iterator = events[Symbol.asyncIterator]();

        while (true) {
          let nextEvent: IteratorResult<Record<string, unknown>>;
          try {
            nextEvent = await this.readNextEvent(
              iterator,
              getCodexStreamIdleTimeoutMs(),
              params.abortController?.signal,
              sawAnyEvent ? lastEventType : 'turn start',
            );
          } catch (err) {
            if (err instanceof CodexStreamAbortedError) {
              break;
            }
            const iteratorReturn = iterator.return;
            if (iteratorReturn) {
              try {
                void iteratorReturn.call(iterator);
              } catch {
                // Ignore iterator teardown failures
              }
            }
            throw err;
          }

          if (nextEvent.done) {
            break;
          }

          const event = nextEvent.value;
          sawAnyEvent = true;
          lastEventType = String(event.type || 'unknown event');

          switch (event.type) {
            case 'thread.started': {
              const threadId = event.thread_id as string;
              this.threadIds.set(params.sessionId, threadId);

              controller.enqueue(sseEvent('status', {
                session_id: threadId,
              }));
              break;
            }

            case 'item.completed': {
              const item = event.item as Record<string, unknown>;
              this.handleCompletedItem(controller, item);
              break;
            }

            case 'turn.completed': {
              const usage = event.usage as Record<string, unknown> | undefined;
              const threadId = this.threadIds.get(params.sessionId);

              controller.enqueue(sseEvent('result', {
                usage: usage ? {
                  input_tokens: usage.input_tokens ?? 0,
                  output_tokens: usage.output_tokens ?? 0,
                  cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                } : undefined,
                ...(threadId ? { session_id: threadId } : {}),
              }));
              break;
            }

            case 'turn.failed': {
              const error = (event as { message?: string }).message;
              controller.enqueue(sseEvent('error', error || 'Turn failed'));
              break;
            }

            case 'error': {
              const error = (event as { message?: string }).message;
              controller.enqueue(sseEvent('error', error || 'Thread error'));
              break;
            }

            default:
              break;
          }
        }
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
          console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
          savedThreadId = undefined;
          retryFresh = true;
          continue;
        }
        throw err;
      }
    }
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let sdkInput: string | Array<Record<string, string>> = params.prompt;
            for (const file of imageFiles) {
              const ext = MIME_EXT[file.type] || '.png';
              const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
              fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
              tempFiles.push(tmpPath);
            }

            if (this.codex) {
              if (tempFiles.length > 0) {
                sdkInput = [
                  { type: 'text', text: params.prompt },
                  ...tempFiles.map((tmpPath) => ({ type: 'local_image', path: tmpPath })),
                ];
              }
              await this.streamChatViaInjectedSdk(controller, params, sdkInput);
            } else {
              await this.streamChatViaCli(controller, params, tempFiles);
            }

            controller.close();
          } catch (err) {
            const rawMessage = err instanceof Error ? err.message : String(err);
            const userVisibleMessage = toUserVisibleCodexErrorMessage(rawMessage);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', userVisibleMessage));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
