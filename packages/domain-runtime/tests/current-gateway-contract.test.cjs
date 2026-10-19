const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { RemoteGatewayClient } = require('../src/remote-gateway-client.cjs');
const digest = b => createHash('sha256').update(b).digest('hex');
const json = value =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('current snapshot protocol uploads exact bytes, then completes; rejects foreign targets before upload', async () => {
  for (const foreign of [false, true]) {
    const id = randomUUID();
    const bytes = Buffer.from([0, 255, 1, 2]);
    const sha256 = digest(bytes);
    const file = { path: 'input.bin', sha256, sizeBytes: bytes.length };
    const requests = [];
    const client = new RemoteGatewayClient({
      url: 'https://gateway.example',
      credential: 'test',
      remoteProjectId: 'p',
      fetch: async (url, init) => {
        requests.push({ url, ...init });
        if (url.endsWith('/snapshots')) {
          assert.deepEqual(JSON.parse(init.body), {
            manifest: { schemaVersion: '0.1', files: [file] },
            baseSnapshotId: null,
          });
          const objectKey = `snapshots/${sha256.slice(0, 2)}/${sha256}`;
          return json({
            snapshotId: id,
            projectId: 'p',
            status: 'uploading',
            files: [
              {
                ...file,
                upload: {
                  method: 'PUT',
                  objectKey,
                  url: `${foreign ? 'https://foreign.example' : ''}/v1/projects/p/snapshots/${id}/objects/${objectKey}`,
                },
              },
            ],
          });
        }
        if (init.method === 'PUT') {
          assert.deepEqual(init.body, bytes);
          assert.equal(init.headers['Content-Type'], 'application/octet-stream');
          return json({ sha256 });
        }
        assert.ok(url.endsWith('/complete'));
        return json({ snapshotId: id, projectId: 'p', status: 'ready' });
      },
    });
    const op = client.uploadSnapshot({
      manifest: { schemaVersion: '0.1', files: [file] },
      blobs: new Map([[sha256, bytes]]),
    });
    if (foreign) {
      await assert.rejects(op, /Untrusted/);
      assert.equal(requests.length, 1);
    } else {
      assert.equal((await op).status, 'ready');
      assert.deepEqual(
        requests.map(r => r.method),
        ['POST', 'PUT', 'POST'],
      );
    }
  }
});

test('official MCP transport refreshes headers on an existing connection and uses protected call contract', async t => {
  let token = 'first';
  const calls = [];
  const client = new RemoteGatewayClient({
    url: 'https://gateway.example',
    credentialKey: digest('test-account'),
    credentialProvider: async () => token,
    remoteProjectId: 'p',
    clientSessionId: 'c',
    domain: 'test',
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (!body) return new Response(null, { status: 405 });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const headers = new Headers(init.headers);
      calls.push({ body, token: headers.get('Authorization') });
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'test', version: '1' },
            }
          : {
              content: [
                { type: 'text', text: JSON.stringify({ status: 'completed', state: null }) },
              ],
            };
      return json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  t.after(() => client.close());
  await client.listTools();
  token = 'second';
  const requestId = randomUUID(),
    snapshotId = randomUUID();
  await client.callProtectedTool('test.run', {}, { requestId, snapshotId });
  assert.equal(calls.at(-1).token, 'Bearer second');
  assert.deepEqual(calls.at(-1).body.params.arguments, {
    requestId,
    snapshotId,
    expectedStateId: null,
    toolId: 'test.run',
    arguments: {},
  });
  assert.equal(calls.filter(c => c.body.method === 'initialize').length, 1);
});

test('current artifact download checks the recorded digest and rejects corruption', async () => {
  const bytes = Buffer.from('real result');
  let corrupt = false;
  const ref = { id: randomUUID(), sizeBytes: bytes.length, sha256: digest(bytes) };
  const client = new RemoteGatewayClient({
    url: 'https://gateway.example',
    credential: 'test',
    fetch: async url => {
      assert.equal(url, `https://gateway.example/v1/artifacts/${ref.id}/download`);
      return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes);
    },
  });
  assert.deepEqual((await client.downloadProducedArtifact(ref)).content, bytes);
  corrupt = true;
  await assert.rejects(client.downloadProducedArtifact(ref), /digest/);
});
