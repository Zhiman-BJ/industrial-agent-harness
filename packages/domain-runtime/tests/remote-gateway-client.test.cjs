const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const {
  RemoteGatewayClient,
  RemoteGatewayError,
  safeDownload,
  parseToolPayload,
} = require('../src/remote-gateway-client.cjs');
const { hash } = require('../src/remote-client.cjs');

async function fixture(t, handler = () => ({ ok: true })) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const record = { method: request.method, url: request.url, headers: request.headers, body };
    requests.push(record);
    const send = (value, status = 200, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/v1/mcp/test' && request.method === 'GET') return send({}, 405);
    if (body?.method === 'initialize')
      return send({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'gateway-fixture', version: '1.1' },
        },
      });
    if (body?.method?.startsWith('notifications/')) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = await handler(record);
    if (result.http) return send(result.http.body, result.http.status, result.http.headers);
    if (result.binary) {
      response.end(result.binary);
      return;
    }
    if (body?.method === 'tools/call')
      return send({
        jsonrpc: '2.0',
        id: body.id,
        ...(result.rpcError
          ? { error: result.rpcError }
          : {
              result: {
                content: [{ type: 'text', text: JSON.stringify(result.payload || result) }],
                ...(result.isError ? { isError: true } : {}),
              },
            }),
      });
    return send(result);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new RemoteGatewayClient({
    url: `http://127.0.0.1:${server.address().port}`,
    credential: 'private-gateway-token',
    remoteProjectId: 'project-1',
    clientSessionId: 'chat-1',
    domain: 'test',
  });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { client, requests };
}

test('official SDK initializes with host-bound headers and preserves invocation envelope', async t => {
  const f = await fixture(t, record => ({
    payload: { name: record.body?.params?.name, arguments: record.body?.params?.arguments },
  }));
  await f.client.listTools();
  await f.client.describeTool('test.execute');
  const invocation = {
    invocationId: 'invoke-1',
    snapshotId: 'snapshot-1',
    action: { inputs: { count: 3 } },
  };
  const result = await f.client.callTool('test.execute', { count: 3 }, { invocation });
  assert.deepEqual(result.arguments, {
    toolId: 'test.execute',
    arguments: { count: 3 },
    invocation,
  });
  assert.equal(f.requests.filter(item => item.body?.method === 'initialize').length, 1);
  for (const request of f.requests) {
    assert.equal(request.headers.authorization, 'Bearer private-gateway-token');
    assert.equal(request.headers['x-remote-project-id'], 'project-1');
    assert.equal(request.headers['x-client-session-id'], 'chat-1');
  }
  const calls = f.requests.filter(item => item.body?.method === 'tools/call');
  assert.deepEqual(
    calls.map(item => item.body.params.name),
    ['domain_tool_list', 'domain_tool_describe', 'domain_tool_call'],
  );
  await f.client.close();
  assert.ok(!f.requests.some(item => item.url.includes('/terminate') || item.method === 'DELETE'));
});

test('HTTP, JSON-RPC and tool errors retain retry outcomes without exposing diagnostics', async t => {
  for (const layer of ['http', 'jsonrpc', 'tool'])
    await t.test(layer, async t => {
      const envelope = {
        code: 'SESSION_BUSY',
        outcome: 'not_submitted',
        retryable: false,
        message: 'private-gateway-token',
      };
      const f = await fixture(t, () =>
        layer === 'http'
          ? { http: { status: 409, body: envelope } }
          : layer === 'jsonrpc'
            ? { rpcError: { code: -32000, message: 'private-gateway-token', data: envelope } }
            : { isError: true, payload: { error: envelope } },
      );
      await assert.rejects(f.client.callTool('test.execute', {}), error => {
        assert.ok(error instanceof RemoteGatewayError);
        assert.equal(error.layer, layer);
        assert.equal(error.code, 'SESSION_BUSY');
        assert.equal(error.outcome, 'not_submitted');
        assert.ok(!String(error).includes('private-gateway-token'));
        return true;
      });
      assert.equal(f.requests.filter(item => item.body?.method === 'tools/call').length, 1);
    });
});

test('only explicitly retryable not_submitted failures are replayed with a bounded limit', async t => {
  let count = 0;
  const f = await fixture(t, () =>
    ++count === 1
      ? {
          isError: true,
          payload: {
            code: 'RATE_LIMITED',
            outcome: 'not_submitted',
            retryable: true,
            retryAfterSeconds: 0,
          },
        }
      : { payload: { accepted: true } },
  );
  assert.deepEqual(await f.client.callTool('test.execute', {}), { accepted: true });
  assert.equal(count, 2);
  for (const outcome of ['unknown', undefined])
    await t.test(String(outcome), async t => {
      let attempts = 0;
      const f = await fixture(t, () => {
        attempts++;
        return { isError: true, payload: { code: 'OUTCOME_UNKNOWN', outcome, retryable: true } };
      });
      await assert.rejects(
        f.client.callTool('test.execute', {}, { retries: 3 }),
        error => error.outcome === 'unknown',
      );
      assert.equal(attempts, 1);
    });
  await t.test('limit and Retry-After', async t => {
    let attempts = 0;
    const f = await fixture(t, () => {
      attempts++;
      return {
        http: {
          status: 429,
          headers: { 'retry-after': '61' },
          body: { code: 'RATE_LIMITED', outcome: 'not_submitted', retryable: true },
        },
      };
    });
    await assert.rejects(
      f.client.callTool('test.execute', {}),
      error => error.retryAfterMs === 61000,
    );
    assert.equal(attempts, 1);
  });
});

test('same application binding serializes clients; queued cancellation is never submitted', async t => {
  let active = 0;
  let maximum = 0;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const f = await fixture(t, async () => {
    active++;
    maximum = Math.max(maximum, active);
    started();
    await gate;
    active--;
    return { payload: { complete: true } };
  });
  const second = f.client.withBinding(f.client.binding);
  t.after(() => second.close());
  const firstCall = f.client.callTool('test.execute', {});
  await ready;
  const abort = new AbortController();
  const cancelled = second.callTool('test.never', {}, { signal: abort.signal });
  const rejected = assert.rejects(
    cancelled,
    error => error.code === 'REQUEST_ABORTED' && error.notSubmitted,
  );
  abort.abort();
  const secondCall = second.callTool('test.execute', {});
  release();
  await Promise.all([firstCall, rejected, secondCall]);
  assert.equal(maximum, 1);
  assert.equal(f.requests.filter(item => item.body?.method === 'tools/call').length, 2);
});

test('file upload verifies selected bytes and artifact download verifies metadata', async t => {
  const bytes = Buffer.from('selected engineering input');
  const ref = { id: 'artifact-1', sha256: hash(bytes), sizeBytes: bytes.length };
  const f = await fixture(t, record => {
    if (record.url.endsWith('/content')) return { binary: bytes };
    if (record.url.endsWith('/artifacts')) return { artifacts: [ref] };
    return { id: 'snapshot-1', received: record.body };
  });
  const snapshot = {
    manifest: {
      schemaVersion: '0.1',
      files: [{ path: 'src/input.txt', sha256: hash(bytes), sizeBytes: bytes.length }],
    },
    blobs: new Map([[hash(bytes), bytes]]),
  };
  const result = await f.client.sync(snapshot);
  assert.deepEqual(result.received.files, [
    { path: 'src/input.txt', contentBase64: bytes.toString('base64') },
  ]);
  assert.equal(result.received.baseSnapshotId, null);
  const downloaded = await f.client.artifact(ref.id);
  assert.deepEqual(downloaded.content, bytes);
  await assert.rejects(f.client.artifact(ref.id, { ...ref, sha256: 'a'.repeat(64) }), /digest/);
  const before = f.requests.length;
  await assert.rejects(
    f.client.sync({ ...snapshot, blobs: new Map([[hash(bytes), Buffer.from('modified')]]) }),
    /size|digest/,
  );
  await assert.rejects(
    f.client.sync({
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        files: [{ ...snapshot.manifest.files[0], path: '../escape' }],
      },
    }),
    /Unsafe/,
  );
  assert.equal(f.requests.length, before);
});

test('unbound project creation and explicit application termination use separate routes', async t => {
  const f = await fixture(t, record => ({ id: 'observed-application-1', received: record.body }));
  const unbound = new RemoteGatewayClient(f.client.options);
  t.after(() => unbound.close());
  await unbound.createProject({ domain: 'test' });
  assert.equal(f.requests[0].headers['x-client-session-id'], undefined);
  assert.equal(f.requests[0].headers['x-remote-project-id'], undefined);
  const current = await f.client.currentSession();
  await f.client.terminateSession(current.id);
  assert.deepEqual(
    f.requests.slice(-2).map(item => [item.method, item.url]),
    [
      ['GET', '/v1/sessions/current/test'],
      ['POST', '/v1/sessions/observed-application-1/terminate'],
    ],
  );
});

test('safe download rejects traversal, symlinks, overwrites and changed bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-download-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const bytes = Buffer.from('verified result');
  const expected = { sha256: hash(bytes), sizeBytes: bytes.length };
  for (const relative of ['../escape', '/absolute', 'C:/escape', 'a\\escape', 'a//escape'])
    assert.throws(() => safeDownload(root, relative, bytes, expected), /Unsafe/);
  fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
  assert.throws(() => safeDownload(root, 'linked/escape', bytes, expected), /symlink/);
  assert.throws(
    () => safeDownload(root, 'changed', bytes, { ...expected, sha256: 'a'.repeat(64) }),
    /digest/,
  );
  const file = safeDownload(root, 'downloads/result.txt', bytes, expected);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => safeDownload(root, 'downloads/result.txt', bytes, expected), /EEXIST/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('unbounded HTTP error streams and oversized structured tool results fail before full buffering', async t => {
  let chunks = 0,
    cancelled = false;
  const client = new RemoteGatewayClient({
    url: 'https://gateway.example',
    credential: 'bounded-token',
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            chunks++;
            controller.enqueue(Buffer.alloc(512 * 1024, 'x'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      ),
  });
  t.after(() => client.close());
  await assert.rejects(
    client.info(),
    error => error.layer === 'http' && error.status === 503 && error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(cancelled, true);
  assert.ok(chunks <= 18);
  assert.throws(
    () => parseToolPayload({ structuredContent: { oversized: 'x'.repeat(8 * 1048576) } }),
    error => error.code === 'INVALID_TOOL_RESULT',
  );
});
