const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { RemoteSettings } = require('../src/remote-settings.cjs');
const { createRemoteRuntime, hash } = require('@industrial-agent-harness/domain-runtime');
const json = value =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function setup(
  t,
  { corrupt = false, disconnect = false, metadataOnly = false, staleCatalog = false } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'current-runtime-'));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'input.txt'), 'approved input');
  const projectId = randomUUID(),
    snapshotId = randomUUID(),
    artifactId = randomUUID();
  let files,
    calls = 0;
  const bytes = Buffer.from('actual fixture evidence');
  const urls = [];
  const fetch = async (url, init) => {
    const route = new URL(url).pathname;
    urls.push(route);
    if (route === '/v1/service-info')
      return json({
        version: '1.1.0',
        domains: ['test'],
        domainCatalog: [
          {
            domain: 'test',
            packs: [
              {
                id: 'test-pack',
                domain: 'test',
                profiles: [
                  {
                    id: 'native',
                    descriptor: { id: 'test.run', version: '1' },
                    worker: { toolIds: ['test.run'] },
                  },
                ],
              },
            ],
          },
        ],
        capabilitySnapshotHash: (staleCatalog ? 'c' : 'a').repeat(64),
        sessionModel: 'application-session',
      });
    if (route === '/v1/projects') return json({ id: projectId, domain: 'test' });
    if (route.endsWith('/snapshots')) {
      files = JSON.parse(init.body).manifest.files;
      return json({
        snapshotId,
        projectId,
        status: 'uploading',
        files: files.map(f => {
          const objectKey = `snapshots/${f.sha256.slice(0, 2)}/${f.sha256}`;
          return {
            ...f,
            upload: {
              method: 'PUT',
              objectKey,
              url: `${route}/${snapshotId}/objects/${objectKey}`,
            },
          };
        }),
      });
    }
    if (init.method === 'PUT') return json({});
    if (route.endsWith('/complete')) return json({ snapshotId, projectId, status: 'ready' });
    if (route.endsWith('/download'))
      return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes);
    if (route === '/v1/mcp/test') {
      if (!init.body) return new Response(null, { status: 405 });
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize')
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
        });
      let payload;
      if (body.params.name === 'domain_tool_list')
        payload = {
          domain: 'test',
          protected: true,
          capabilitySnapshotHash: 'a'.repeat(64),
          ...(metadataOnly
            ? { packId: 'test-pack', profileId: 'test-native' }
            : { tools: [{ id: 'test.run', risk: 'mutating' }] }),
        };
      else if (body.params.name === 'domain_tool_describe') {
        assert.equal(body.params.arguments.toolId, 'test.run');
        payload = { tool: { id: 'test.run' }, inputs: { type: 'object' } };
      } else {
        calls++;
        assert.equal(body.params.arguments.snapshotId, snapshotId);
        assert.equal(body.params.arguments.expectedStateId, null);
        assert.equal(body.params.arguments.invocation, undefined);
        if (disconnect) throw Error('socket disconnected');
        payload = {
          status: 'completed',
          persisted: true,
          state: null,
          evidence: { requestId: body.params.arguments.requestId },
          verification: {
            schemaVersion: '1',
            id: randomUUID(),
            status: 'passed',
            verifierId: 'test.check',
            reason: 'Fixture verifier passed.',
            metrics: {},
            evidence: {
              artifactIds: [artifactId],
              inputHashes: { 'invocation.json': 'b'.repeat(64) },
            },
            checks: [],
          },
          artifacts: [
            { artifactId, kind: 'report.result', sha256: hash(bytes), sizeBytes: bytes.length },
          ],
        };
      }
      return json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      });
    }
    throw Error(`Unexpected old route: ${route}`);
  };
  const settings = new RemoteSettings({
    directory: path.join(root, 'settings'),
    environment: {
      INDUSTRIAL_REMOTE_SERVICE_URL: 'https://gateway.example',
      INDUSTRIAL_REMOTE_CREDENTIAL_ENV: 'TOKEN',
      TOKEN: 'fixture',
    },
    fetch,
  });
  const review = await settings.review(projectDir, 'test', ['input.txt']);
  await settings.sync(projectDir, 'test', review.id);
  const options = {
    settings,
    projectDir,
    domain: 'test',
    directory: path.join(root, 'runtime'),
    registry: { capabilities: [] },
  };
  let bundle = createRemoteRuntime(options);
  const chatId = randomUUID();
  let runtime = bundle.runtime.forSession(chatId);
  t.after(async () => {
    await bundle.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    settings,
    projectDir,
    chatId,
    urls,
    get runtime() {
      return runtime;
    },
    get calls() {
      return calls;
    },
    reopen: async () => {
      await bundle.runtime.close();
      bundle = createRemoteRuntime(options);
      runtime = bundle.runtime.forSession(chatId);
    },
  };
}
async function invoke(f, approval = true) {
  const state = await f.runtime.inspect();
  return f.runtime.execute(
    { toolId: 'test.run', inputs: {}, expectedStateId: state.id },
    {
      scope: { projectId: state.projectId, domain: 'test', stateId: state.id, tools: ['test.run'] },
      approval,
    },
  );
}
test('shared runtime persists canonical local records from the current server receipt and restores them', async t => {
  const f = await setup(t);
  const denied = await invoke(f, false);
  assert.equal(denied.action.status, 'failed');
  assert.equal(f.calls, 0);
  const result = await invoke(f);
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
  assert.equal(result.state.stage, null);
  assert.equal(result.state.status, 'verified');
  assert.equal(f.calls, 1);
  assert.equal(
    f.runtime.readArtifact(result.artifacts[0].id).content.toString(),
    'actual fixture evidence',
  );
  assert.equal((await f.settings.artifacts(f.projectDir, 'test')).length, 1);
  await f.reopen();
  assert.equal((await f.runtime.inspect()).id, result.state.id);
  assert.equal(f.runtime.listRuns().length, 2);
  assert.ok(!f.urls.some(url => /\/(state|capabilities|grants|invocations)$/.test(url)));
});
test('metadata-only discovery binds the live Pack/profile to a matching catalog and description', async t => {
  const f = await setup(t, { metadataOnly: true });
  const result = await invoke(f);
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.calls, 1);
});
test('metadata-only discovery rejects a different catalog snapshot before any mutation', async t => {
  const f = await setup(t, { metadataOnly: true, staleCatalog: true });
  await assert.rejects(f.runtime.inspect(), /capability snapshot/);
  assert.equal(f.calls, 0);
});
for (const failure of ['corrupt', 'disconnect'])
  test(`current runtime rejects ${failure} without replaying mutation`, async t => {
    const f = await setup(t, { [failure]: true });
    const result = await invoke(f);
    assert.equal(result.action.status, 'failed');
    assert.notEqual(result.verification.status, 'passed');
    await assert.rejects(f.runtime.inspect(), /unknown/);
    assert.equal(f.calls, 1);
    const pending = await f.settings.refreshTask(f.projectDir, 'test', f.chatId);
    assert.equal(pending.status, 'unknown');
    assert.equal(f.calls, 1);
  });
