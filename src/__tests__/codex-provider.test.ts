import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── SSE utils tests ─────────────────────────────────────────

import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });

  it('handles newlines in data', () => {
    const result = sseEvent('text', 'line1\nline2');
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.data, 'line1\nline2');
  });
});

// ── CodexProvider tests ─────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

describe('CodexProvider', () => {
  it('emits error when SDK init fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Force ensureSDK to fail by setting sdk to a broken module
    (provider as any).sdk = { Codex: class { constructor() { throw new Error('Missing API key'); } } };
    (provider as any).codex = null;
    // Reset so ensureSDK re-runs the constructor
    (provider as any).sdk = null;
    // Override ensureSDK directly
    (provider as any).ensureSDK = async () => { throw new Error('SDK init failed: Missing API key'); };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.ok(errorEvent!.data.includes('Missing API key'), 'Error should contain the cause');
  });

  it('maps agent_message item to text SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello from Codex!',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello from Codex!');
  });

  it('maps command_execution item to tool_use + tool_result', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1.txt\nfile2.txt',
      exit_code: 0,
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Bash');
    assert.equal(toolUse.input.command, 'ls -la');

    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'cmd-1');
    assert.equal(toolResult.is_error, false);
  });

  it('marks non-zero exit code as error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-2',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.is_error, true);
  });

  it('maps file_change item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'file_change',
      id: 'fc-1',
      changes: [
        { path: 'src/main.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Edit');
    const toolResult = JSON.parse(events[1].data);
    assert.ok(toolResult.content.includes('update: src/main.ts'));
  });

  it('maps mcp_tool_call item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'myserver',
      tool: 'search',
      arguments: { query: 'test' },
      result: { content: 'found 3 results' },
    });

    const events = parseSSEChunks(chunks);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'mcp__myserver__search');
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, 'found 3 results');
  });

  it('maps mcp_tool_call with structured_content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-2',
      server: 'myserver',
      tool: 'getData',
      arguments: {},
      result: { structured_content: { items: [1, 2, 3] } },
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, JSON.stringify({ items: [1, 2, 3] }));
  });

  it('skips empty agent_message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-2',
      text: '',
    });

    assert.equal(chunks.length, 0);
  });

  it('does not pass model by default and still attempts resume for persisted thread ids', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;
    let capturedResumeOptions: Record<string, unknown> | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string, options: Record<string, unknown>) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        capturedResumeOptions = options;
        return mockThread;
      },
      startThread: (_opts: Record<string, unknown>) => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'model-default-session',
      sdkSessionId: 'old-claude-session-id',
      model: 'claude-sonnet-4-20250514',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should attempt resume for the persisted thread id');
    assert.equal(resumedThreadId, 'old-claude-session-id');
    assert.equal(startCalls, 0, 'Should not eagerly start a fresh thread when resume is available');
    assert.ok(capturedResumeOptions, 'resumeThread options should be captured');
    assert.ok(!Object.prototype.hasOwnProperty.call(capturedResumeOptions!, 'model'), 'Model should not be forwarded by default');
  });

  it('reuses the in-memory Codex thread even when the stored model is Claude-like', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).threadIds.set('sticky-codex-session', 'codex-thread-123');
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        return mockThread;
      },
      startThread: () => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'continue previous thread',
      sessionId: 'sticky-codex-session',
      sdkSessionId: 'old-claude-session-id',
      model: 'claude-sonnet-4-20250514',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should resume the in-memory Codex thread');
    assert.equal(resumedThreadId, 'codex-thread-123');
    assert.equal(startCalls, 0, 'Should not start a fresh thread when an in-memory Codex thread exists');
  });

  it('passes model only when CTI_CODEX_PASS_MODEL=true', async () => {
    const old = process.env.CTI_CODEX_PASS_MODEL;
    process.env.CTI_CODEX_PASS_MODEL = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'model-forward-session',
        model: 'gpt-5-codex',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.model, 'gpt-5-codex');
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_PASS_MODEL;
      } else {
        process.env.CTI_CODEX_PASS_MODEL = old;
      }
    }
  });

  it('passes skipGitRepoCheck only when CTI_CODEX_SKIP_GIT_REPO_CHECK=true', async () => {
    const old = process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
    process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'skip-git-check-session',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.skipGitRepoCheck, true);
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
      } else {
        process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = old;
      }
    }
  });

  it('retries with fresh thread when resume fails before any events', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    const resumeThread = {
      runStreamed: async () => {
        throw new Error('resuming session with different model');
      },
    };
    const freshThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return freshThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'retry test',
      sessionId: 'resume-retry-session',
      sdkSessionId: 'codex-old-thread-id',
      model: 'gpt-5-codex',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    const resultEvent = events.find(e => e.type === 'result');

    assert.equal(resumeCalls, 1, 'Should attempt resume once');
    assert.equal(startCalls, 1, 'Should fall back to a fresh thread');
    assert.ok(!errorEvent, 'Retry success should not emit error');
    assert.ok(resultEvent, 'Retry success should emit result');
  });
});

// ── Image input building tests ──────────────────────────────

import fs from 'node:fs';

/** Helper: build a full FileAttachment object for tests. */
function makeFile(type: string, data: string, name = 'test-file') {
  return { id: `file-${Date.now()}`, name, type, size: data.length, data };
}

describe('CodexProvider image input', () => {
  it('builds local_image input array for text+image', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Mock the SDK so we can capture the input passed to runStreamed
    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    // Use valid base64 (1x1 red PNG pixel)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const stream = provider.streamChat({
      prompt: 'Describe this image',
      sessionId: 'img-session',
      files: [makeFile('image/png', pngBase64, 'test.png')],
    });

    await collectStream(stream);

    assert.ok(Array.isArray(capturedInput), 'Input should be an array for image input');
    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Describe this image');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'), 'Temp file should have .png extension');
  });

  it('passes plain string when no images attached', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Hello',
      sessionId: 'no-img-session',
    });

    await collectStream(stream);

    assert.equal(typeof capturedInput, 'string', 'Input should be a plain string without images');
    assert.equal(capturedInput, 'Hello');
  });

  it('builds local_image input with multiple images, ignoring non-image files', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Compare these',
      sessionId: 'multi-img-session',
      files: [
        makeFile('image/png', 'cG5n', 'a.png'),
        makeFile('image/jpeg', 'anBn', 'b.jpg'),
        makeFile('text/plain', 'dGV4dA==', 'c.txt'),
      ],
    });

    await collectStream(stream);

    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 3, 'Should have 1 text + 2 local_image parts (non-image file excluded)');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'));
    assert.equal(parts[2].type, 'local_image');
    assert.ok(parts[2].path.endsWith('.jpg'));
  });
});

// ── Error event tests ───────────────────────────────────────

describe('CodexProvider error events', () => {
  it('reads message field from turn.failed event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed', message: 'Rate limit exceeded' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-1',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Rate limit exceeded');
  });

  it('reads message field from error event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'error', message: 'Connection lost' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-2',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Connection lost');
  });

  it('falls back to default message when message field is absent', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-3',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent);
    assert.equal(errorEvent!.data, 'Turn failed');
  });
});
