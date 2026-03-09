/**
 * Kimi Provider — LLMProvider implementation backed by kimi CLI.
 *
 * Spawns kimi CLI in --print mode with --output-format stream-json,
 * parses JSON output, and converts to bridge SSE format.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

/** Kimi CLI JSON output message */
interface KimiMessage {
  role: 'assistant' | 'tool' | string;
  content?: Array<{
    type: 'think' | 'text' | 'function' | string;
    text?: string;
    think?: string;
    encrypted?: string | null;
  }>;
  tool_calls?: Array<{
    type: 'function';
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

function resolveKimiCliPath(): string | undefined {
  // Check env var first
  const fromEnv = process.env.CTI_KIMI_EXECUTABLE || process.env.KIMI_CLI_PATH;
  if (fromEnv) return fromEnv;

  // Try common locations
  const candidates = [
    '/usr/local/bin/kimi',
    '/opt/homebrew/bin/kimi',
    `${process.env.HOME}/.local/bin/kimi`,
    `${process.env.HOME}/.cargo/bin/kimi`,
    'kimi', // Try PATH
  ];
  
  for (const p of candidates) {
    try {
      if (p === 'kimi') return p; // Will rely on PATH
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      continue;
    }
  }
  
  return 'kimi'; // Fallback to PATH
}

export class KimiProvider implements LLMProvider {
  private cliPath: string;
  private sessions = new Map<string, string>(); // sessionId -> kimi session ID

  constructor(private pendingPerms: PendingPermissions) {
    this.cliPath = resolveKimiCliPath() || 'kimi';
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    const pendingPerms = this.pendingPerms;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          let killed = false;

          try {
            // Build kimi arguments
            const args: string[] = [
              '--print',
              '--output-format', 'stream-json',
            ];

            // Working directory
            if (params.workingDirectory) {
              args.push('--work-dir', params.workingDirectory);
            }

            // Session/resume
            const savedSessionId = params.sdkSessionId 
              ? self.sessions.get(params.sessionId) || params.sdkSessionId
              : undefined;
            
            if (savedSessionId) {
              args.push('--session', savedSessionId);
            } else {
              args.push('--continue'); // Continue or create new
            }

            // Model (if provided and looks like a kimi model)
            if (params.model && !params.model.startsWith('claude')) {
              args.push('--model', params.model);
            }

            // Build input
            // Note: kimi CLI print mode doesn't support inline images via stdin
            const inputText = params.prompt;

            const child = spawn(self.cliPath, args, {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: {
                ...process.env,
                // Ensure kimi uses proper output
                FORCE_COLOR: '0',
                NO_COLOR: '1',
              },
            });

            // Handle abort
            if (params.abortController) {
              params.abortController.signal.addEventListener('abort', () => {
                killed = true;
                child.kill('SIGTERM');
              });
            }

            // Send input
            child.stdin.write(inputText);
            child.stdin.end();

            // Buffer for incomplete lines
            let buffer = '';
            let sessionId: string | undefined;

            child.stdout.on('data', (data: Buffer) => {
              if (killed) return;

              buffer += data.toString('utf-8');
              const lines = buffer.split('\n');
              buffer = lines.pop() || ''; // Keep incomplete line in buffer

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                  const msg: KimiMessage = JSON.parse(trimmed);
                  self.handleMessage(msg, controller, pendingPerms, (id) => {
                    if (!sessionId) {
                      sessionId = id;
                      self.sessions.set(params.sessionId, id);
                    }
                  });
                } catch (err) {
                  console.warn('[kimi-provider] Failed to parse JSON:', trimmed.slice(0, 100));
                }
              }
            });

            // Handle stderr
            child.stderr.on('data', (data: Buffer) => {
              const text = data.toString('utf-8');
              console.warn('[kimi-provider] stderr:', text.slice(0, 200));
            });

            // Wait for process to complete
            const exitCode = await new Promise<number>((resolve) => {
              child.on('close', (code) => resolve(code ?? 0));
              child.on('error', () => resolve(1));
            });

            if (exitCode !== 0 && !killed) {
              console.warn(`[kimi-provider] kimi exited with code ${exitCode}`);
            }

            // Send final result
            controller.enqueue(sseEvent('result', {
              session_id: sessionId,
              is_error: exitCode !== 0 && !killed,
            }));

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[kimi-provider] Error:', err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Already closed
            }
          }
        })();
      },
    });
  }

  private handleMessage(
    msg: KimiMessage,
    controller: ReadableStreamDefaultController<string>,
    _pendingPerms: PendingPermissions,
    setSessionId: (id: string) => void,
  ): void {
    // Emit status with session ID on first message
    if (!this.sessionEmitted) {
      this.sessionEmitted = true;
      controller.enqueue(sseEvent('status', {
        session_id: `kimi-${Date.now()}`,
      }));
    }

    if (msg.role === 'assistant' && msg.content) {
      for (const block of msg.content) {
        switch (block.type) {
          case 'think':
            // Thinking block - emit as status
            if (block.think) {
              controller.enqueue(sseEvent('status', { reasoning: block.think }));
            }
            break;
          case 'text':
            if (block.text) {
              controller.enqueue(sseEvent('text', block.text));
            }
            break;
        }
      }

      // Handle tool calls
      if (msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          const toolId = toolCall.id || `tool-${Date.now()}`;
          const toolName = toolCall.function.name;
          let toolInput: Record<string, unknown> = {};
          
          try {
            toolInput = JSON.parse(toolCall.function.arguments);
          } catch {
            toolInput = { raw: toolCall.function.arguments };
          }

          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: toolName,
            input: toolInput,
          }));

          // Note: kimi handles tool execution internally in print mode
          // The result comes back in a tool role message
        }
      }
    } else if (msg.role === 'tool' && msg.content) {
      // Tool result
      const toolCallId = msg.tool_call_id || 'unknown';
      const text = msg.content.find(c => c.type === 'text')?.text || '';
      
      controller.enqueue(sseEvent('tool_result', {
        tool_use_id: toolCallId,
        content: text,
        is_error: false,
      }));
    }
  }

  private sessionEmitted = false;
}
