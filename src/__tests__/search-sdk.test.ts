/** Scripted model + local MCP fixtures; exercises the real Agent SDK/CLI. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SDKLLMProvider } from '../llm-provider.js';
import { PendingPermissions } from '../permission-gateway.js';
import { PARALLEL_SEARCH_URL, PARALLEL_SEARCH_AGENT, PARALLEL_SEARCH_SERVER } from '../search-config.js';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function modelResponse(res: http.ServerResponse, block: Record<string, unknown>) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content: [], stop_reason: null,
    usage: { input_tokens: 1, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: block.type === 'text'
    ? { type: 'text', text: '' } : { ...block, input: {} } });
  emit('content_block_delta', { index: 0, delta: block.type === 'text'
    ? { type: 'text_delta', text: block.text }
    : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null }, usage: { output_tokens: 1 } });
  emit('message_stop', {});
  res.end();
}

async function exercise(mode: 'success' | 'denied' | 'error' | 'cancel' | 'timeout' | 'live') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-search-sdk-'));
  const oldEnv = process.env;
  const requests: Array<{ method: string; headers: http.IncomingHttpHeaders; params?: any }> = [];
  const modelRequests: any[] = [];
  const serverStatuses: unknown[] = [];
  const abortController = new AbortController();
  const mcp = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ method: body.method, headers: req.headers, params: body.params });
    const send = (result: object) => res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    if (body.method === 'initialize') {
      send({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'search-fixture', version: '1.0.0' } });
    } else if (body.method === 'tools/list') {
      send({ tools: [
        { name: 'web_search', description: 'Search web sources', inputSchema: {
          type: 'object', properties: { objective: { type: 'string' },
            search_queries: { type: 'array', items: { type: 'string' } } },
          required: ['objective', 'search_queries'],
        } },
        { name: 'web_fetch', description: 'Read pages', inputSchema: {
          type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'],
        } },
      ] });
    } else if (body.method === 'tools/call') {
      if (mode === 'cancel') { abortController.abort(); return; }
      if (mode === 'timeout') return;
      send({ content: [{ type: 'text', text: mode === 'error' ? 'Search service unavailable'
        : body.params.name === 'web_search'
          ? 'Source: https://example.org/docs\nCurrent bridge documentation'
          : 'https://example.org/docs\nBridge setup requires Node.js 20 or newer.' }], isError: mode === 'error' });
    } else { res.writeHead(202).end(); }
  });
  const model = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    if (req.url?.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return;
    }
    const body = JSON.parse(text);
    modelRequests.push(body);
    const results = body.messages.flatMap((m: any) => Array.isArray(m.content)
      ? m.content.filter((c: any) => c.type === 'tool_result') : []);
    const calls = body.messages.flatMap((m: any) => Array.isArray(m.content)
      ? m.content.filter((c: any) => c.type === 'tool_use') : []);
    const tools = body.tools || [];
    const search = tools.find((tool: any) => tool.name.endsWith('__web_search'));
    const fetch = tools.find((tool: any) => tool.name.endsWith('__web_fetch'));
    if (!search) { modelResponse(res, { type: 'text', text: 'No search tool available' }); return; }
    if (calls.length === 0) {
      modelResponse(res, { type: 'tool_use', id: 'tool_search', name: search.name,
        input: { objective: 'Find the bridge documentation', search_queries: ['Claude IM bridge documentation'] } });
    } else if (calls.length === 1 && !results.some((r: any) => r.is_error) && fetch) {
      modelResponse(res, { type: 'tool_use', id: 'tool_fetch', name: fetch.name,
        input: { urls: [mode === 'live' ? 'https://docs.parallel.ai/integrations/mcp/search-mcp'
          : 'https://example.org/docs'] } });
    } else {
      // The scripted model consumes the tool output and returns its content.
      modelResponse(res, { type: 'text', text: JSON.stringify(results) });
    }
  });
  try {
    const mcpUrl = await listen(mcp);
    const modelUrl = await listen(model);
    // Isolate both environment credentials and filesystem settings. The model is a fixture.
    process.env = {
      ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
        'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
        .flatMap(name => oldEnv[name] ? [[name, oldEnv[name]]] : [])),
      PATH: oldEnv.PATH, HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      ANTHROPIC_API_KEY: 'scripted-model-fixture-key', ANTHROPIC_BASE_URL: modelUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      ENABLE_TOOL_SEARCH: 'false', MCP_TOOL_TIMEOUT: mode === 'timeout' ? '500' : '5000',
      CTI_DEFAULT_MODEL: 'claude-sonnet-4-6',
    };
    const permissions = new PendingPermissions();
    permissions.waitFor = async () => ({ behavior: mode === 'denied' ? 'deny' : 'allow' });
    const provider = new SDKLLMProvider(permissions);
    (provider as any).runQuery = (args: Parameters<typeof query>[0]) => {
      const server = args.options!.mcpServers![PARALLEL_SEARCH_SERVER] as { url: string; headers: object };
      assert.equal(server.url, PARALLEL_SEARCH_URL);
      assert.deepEqual(server.headers, { 'User-Agent': PARALLEL_SEARCH_AGENT });
      assert.deepEqual(args.options!.disallowedTools, ['WebSearch', 'WebFetch']);
      // Only substitute the remote MCP server with the local deterministic fixture.
      if (mode !== 'live') server.url = mcpUrl;
      const q = query(args);
      void q.mcpServerStatus().then(status => serverStatuses.push(status)).catch(() => {});
      return q;
    };
    const stream = provider.streamChat({ prompt: 'Find documentation, then read the source page.',
      workingDirectory: root, sessionId: 'scripted-sdk-fixture', model: 'claude-sonnet-4-6',
      abortController });
    const output: string[] = [];
    for await (const chunk of stream) output.push(chunk);
    return { output: output.join(''), requests, modelRequests, serverStatuses };
  } finally {
    abortController.abort();
    process.env = oldEnv;
    mcp.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => mcp.close(() => resolve())),
      new Promise<void>(resolve => model.close(() => resolve()))]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('Claude SDK search caller', () => {
  it('discovers, approves and consumes search + fetch through the real SDK', async () => {
    const { output, requests, modelRequests } = await exercise('success');
    assert.ok(output.includes('Bridge setup requires Node.js 20'), output);
    assert.ok(output.includes('permission_request'), output);
    assert.ok(output.includes('tool_result'), output);
    assert.ok(modelRequests.length >= 3);
    assert.ok(modelRequests.every(body => !body.tools.some((t: any) => ['WebSearch', 'WebFetch'].includes(t.name))));
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const matching = requests.filter(r => r.method === method);
      assert.ok(matching.length > 0, method);
      assert.ok(matching.every(r => r.headers['user-agent'] === PARALLEL_SEARCH_AGENT), method);
      assert.ok(matching.every(r => !r.headers.authorization), method);
    }
    const calls = requests.filter(r => r.method === 'tools/call');
    assert.deepEqual(calls.map(r => r.params.name), ['web_search', 'web_fetch']);
    assert.deepEqual(calls[1].params.arguments.urls, ['https://example.org/docs']);
  });

  it('does not invoke an MCP tool denied by the IM permission flow', async () => {
    const { output, requests } = await exercise('denied');
    assert.equal(requests.filter(r => r.method === 'tools/call').length, 0, output);
    assert.ok(output.includes('permission_request'), output);
    assert.ok(output.includes('Denied by user'), output);
  });

  it('returns a search service error without falling back to native tools', async () => {
    const { output, requests } = await exercise('error');
    assert.ok(output.includes('Search service unavailable'), output);
    assert.equal(requests.filter(r => r.method === 'tools/call').length, 1);
    assert.ok(output.includes('is_error'), output);
  });

  it('cancels an in-flight search through the session abort controller', async () => {
    const { output, requests } = await exercise('cancel');
    assert.equal(requests.filter(r => r.method === 'tools/call').length, 1, output);
    assert.ok(!output.includes('Bridge setup requires'), output);
  });

  it('surfaces the SDK MCP tool timeout without a provider fallback', async () => {
    const { output, requests } = await exercise('timeout');
    assert.equal(requests.filter(r => r.method === 'tools/call').length, 1, output);
    assert.match(output, /timed out|timeout|Request timed out/i);
  });

  it('uses the anonymous live endpoint with a scripted model', {
    skip: process.env.CTI_TEST_LIVE_SEARCH !== 'true',
  }, async (t) => {
    const { output, serverStatuses } = await exercise('live');
    console.log('LIVE_SEARCH_STATUS', JSON.stringify(serverStatuses));
    console.log('LIVE_SEARCH_OUTPUT', output);
    const results = output.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'tool_result')
      .map(event => JSON.parse(event.data));
    assert.ok(results.length > 0, output);
    // Retain an explicit quota without claiming a successful live search.
    if (results.some(result => /free-tier rate limit/i.test(result.content))) {
      t.skip('Anonymous endpoint returned its free-tier quota; deterministic caller coverage is separate.');
      return;
    }
    assert.ok(results.every(result => !result.is_error), output);
    assert.ok(results.some(result => result.content.includes('https://')), output);
  });
});
