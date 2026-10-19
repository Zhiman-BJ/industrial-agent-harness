const { test: nodeTest } = require('node:test');
const test = (name, body) => nodeTest(name, { timeout: 30000 }, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { RemoteSettings, selectedSnapshot } = require('../src/remote-settings.cjs');
const {
  createProjectRuntime,
  runtimeCapabilities,
  resolveProjectTask,
} = require('../src/index.cjs');
const { IndustrialRuntime } = require('../../domain-runtime/src/industrial.cjs');
const { hash } = require('../../domain-runtime/src/remote-client.cjs');
const { RemoteGatewayClient } = require('../../domain-runtime/src/remote-gateway-client.cjs');
const domain = 'test-domain',
  toolId = 'test.verify';
const descriptor = {
  schemaVersion: '1',
  id: toolId,
  version: '1',
  risk: 'mutating',
  verification: ['test.check'],
};
const registry = {
  domains: [{ id: domain }],
  runtimePacks: [{ domain, directory: '/does-not-exist', runtime: { entry: 'must-not-load.cjs' } }],
  capabilities: [
    {
      id: 'test.remote',
      domain,
      title: 'Remote test',
      keywords: [],
      stages: [],
      alwaysAvailable: true,
      priority: 0,
      skills: [],
      tools: [
        { id: toolId, summary: 'test' },
        { id: 'test.local-only', summary: 'local only' },
      ],
      verification: ['test.check'],
    },
  ],
};

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-v1-'));
  const projectDir = path.join(directory, 'local'),
    serverDir = path.join(directory, 'server');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(serverDir);
  fs.writeFileSync(path.join(projectDir, 'input.txt'), 'declared protocol check\n');
  const runtimes = [],
    requests = [],
    handlers = new Set();
  const projectId = crypto.randomUUID(),
    serverId = crypto.randomUUID(),
    capHash = hash('capability');
  const grants = new Map(),
    invocations = new Map(),
    sessions = new Map();
  let hashes = {},
    snapshotId = null,
    corrupt = false,
    loseResponse = false,
    tamperResult = null,
    releaseBlocked,
    gate = null;
  const remote = new IndustrialRuntime(serverDir, domain, {
    directory: path.join(directory, 'server-store'),
    stateProvider: () => ({ stage: snapshotId ? 'test-stage' : null, inputHashes: hashes }),
    tools: [
      {
        descriptor,
        execute: ({ action }) => {
          const file = path.join(serverDir, 'report-' + action.id + '.json');
          fs.writeFileSync(file, '{"protocolFixture":true}\n');
          return {
            executionSucceeded: true,
            artifacts: [{ kind: 'report.test', file }],
            diagnostics: [],
          };
        },
      },
    ],
    verifiers: {
      'test.check': ({ artifacts }) => ({
        status: artifacts.length === 1 ? 'passed' : 'failed',
        reason: 'Protocol fixture evidence (not native engineering qualification).',
        metrics: {},
      }),
    },
  });
  async function handle(req, res) {
    const send = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      assert.equal(req.headers.authorization, 'Bearer private-fixture-token');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks),
        body = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const suffix = req.url.replace('/v1/projects/' + projectId + '/', '');
      if (req.url === '/v1/service-info')
        return send({
          serverId,
          remoteProtocolVersion: '1.1',
          canonicalSchemaVersion: '1',
          sessionModel: 'application-session',
          domains: [domain],
          capabilities: {
            snapshots: true,
            artifacts: true,
            invocationLookup: true,
            protectedExecution: true,
          },
          domainCapabilities: [{ domain, qualification: 'qualified' }],
        });
      if (req.url === '/v1/projects')
        return send({ id: projectId, canonicalProjectId: remote.project.projectId, domain });
      if (suffix === 'snapshots') {
        assert.equal(body.baseSnapshotId, snapshotId);
        for (const file of body.manifest.files) {
          const upload = body.files.find(value => value.path === file.path),
            content = Buffer.from(upload.contentBase64, 'base64');
          assert.equal(hash(content), file.sha256);
          assert.equal(content.length, file.sizeBytes);
        }
        snapshotId = crypto.randomUUID();
        hashes = Object.fromEntries(body.manifest.files.map(file => [file.path, file.sha256]));
        return send({
          id: snapshotId,
          projectId,
          manifest: body.manifest,
          state: await remote.inspect(),
        });
      }
      if (suffix === 'state') return send({ snapshotId, state: await remote.inspect() });
      if (suffix === 'capabilities')
        return send({ domain, capabilitySnapshotHash: capHash, tools: [descriptor] });
      if (suffix === 'grants') {
        assert.equal(req.headers['x-remote-project-id'], projectId);
        assert.ok(req.headers['x-client-session-id']);
        assert.equal(body.approval.decision, 'approved');
        assert.equal(body.approval.source, 'harness-host');
        assert.ok(body.scope.tools.includes(body.action.toolId));
        assert.equal(body.scope.projectId, remote.project.projectId);
        assert.equal(body.snapshotId, snapshotId);
        const id = crypto.randomUUID();
        grants.set(id, { ...body, clientSessionId: req.headers['x-client-session-id'] });
        return send({ invocationGrantId: id });
      }
      if (suffix.startsWith('invocations/')) {
        const id = suffix.split('/')[1];
        return invocations.has(id)
          ? send(invocations.get(id))
          : send({ code: 'INVOCATION_NOT_FOUND', outcome: 'unknown' }, 404);
      }
      if (suffix === 'artifacts')
        return send({
          artifacts: remote
            .listActions()
            .flatMap(action => action.artifactIds.map(id => remote.readArtifact(id).artifact)),
        });
      if (suffix.startsWith('artifacts/') && suffix.endsWith('/content')) {
        const artifact = remote.readArtifact(suffix.split('/')[1]),
          content = corrupt ? Buffer.from('tampered') : artifact.content;
        res.writeHead(200, { 'content-length': content.length });
        res.end(content);
        return;
      }
      if (req.url === '/v1/sessions/current/' + domain) {
        const session = sessions.get(req.headers['x-client-session-id']);
        return session ? send(session) : send({ code: 'SESSION_NOT_FOUND' }, 404);
      }
      if (req.url.startsWith('/v1/sessions/') && req.url.endsWith('/terminate')) {
        const session = [...sessions.values()].find(value => value.id === req.url.split('/')[3]);
        assert.ok(session);
        session.status = 'stopped';
        return send(session);
      }
      if (req.url === '/v1/mcp/' + domain) {
        assert.equal(req.headers['x-remote-project-id'], projectId);
        const clientSessionId = req.headers['x-client-session-id'];
        assert.ok(clientSessionId);
        if (req.method === 'GET') return send({}, 405);
        if (body.method === 'initialize')
          return send({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'remote-fixture', version: '1.1' },
            },
          });
        if (body.method.startsWith('notifications/')) {
          res.writeHead(202);
          res.end();
          return;
        }
        assert.equal(body.method, 'tools/call');
        const name = body.params.name,
          args = body.params.arguments;
        const toolResult = value =>
          send({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
          });
        if (name === 'domain_tool_list') return toolResult({ tools: [descriptor] });
        if (name === 'domain_tool_describe')
          return toolResult({
            tool: { id: args.toolId },
            description: 'Test remote verifier',
            inputs: {},
          });
        assert.equal(name, 'domain_tool_call');
        assert.equal(args.toolId, toolId);
        const invocation = args.invocation,
          grant = grants.get(invocation.invocationGrantId);
        assert.ok(grant);
        assert.equal(grant.clientSessionId, clientSessionId);
        assert.equal(invocation.invocationId, grant.invocationId);
        assert.deepEqual(args.arguments, invocation.action.inputs);
        if (!sessions.has(clientSessionId))
          sessions.set(clientSessionId, { id: crypto.randomUUID(), status: 'running' });
        const record = { id: invocation.invocationId, status: 'running', outcome: 'unknown' };
        invocations.set(record.id, record);
        if (gate) await gate;
        const state = await remote.inspect();
        record.result = await remote.execute(invocation.action, {
          scope: { projectId: state.projectId, domain, stateId: state.id, tools: [toolId] },
          approval: true,
        });
        if (tamperResult) {
          record.result = JSON.parse(JSON.stringify(record.result));
          tamperResult(record.result);
        }
        record.status = 'completed';
        record.outcome = 'completed';
        sessions.get(clientSessionId).status = 'idle';
        if (loseResponse) {
          loseResponse = false;
          res.destroy();
          return;
        }
        return toolResult({
          invocationId: record.id,
          status: record.status,
          result: record.result,
        });
      }
      throw Error('Unexpected fixture route: ' + req.url);
    } catch (error) {
      if (!res.headersSent) send({ code: 'FIXTURE_ERROR', message: String(error) }, 500);
      else res.destroy();
    }
  }
  const server = http.createServer((req, res) => {
    const pending = handle(req, res);
    handlers.add(pending);
    void pending.finally(() => handlers.delete(pending));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const environment = {
    INDUSTRIAL_REMOTE_SERVICE_URL: 'http://127.0.0.1:' + server.address().port,
    INDUSTRIAL_REMOTE_CREDENTIAL_ENV: 'FIXTURE_TOKEN',
    FIXTURE_TOKEN: 'private-fixture-token',
  };
  const settings = new RemoteSettings({ directory: path.join(directory, 'config'), environment });
  t.after(async () => {
    releaseBlocked?.();
    for (const runtime of runtimes) {
      runtime.contexts.forEach(context => runtime.cancel(context));
      await runtime.waitForIdle();
      await runtime.close();
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...handlers]);
    await remote.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    projectDir,
    settings,
    remote,
    environment,
    serverId,
    requests,
    runtimes,
    invocations,
    calls: () =>
      requests.filter(request => request.body?.params?.name === 'domain_tool_call').length,
    uploads: () =>
      requests.filter(request => request.url.endsWith('/snapshots') && request.method === 'POST')
        .length,
    corrupt: value => {
      corrupt = value;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    tamper: callback => {
      tamperResult = callback;
    },
    block: () => {
      gate = new Promise(resolve => {
        releaseBlocked = resolve;
      });
    },
    unblock: () => {
      releaseBlocked?.();
      gate = null;
    },
  };
}
async function prepared(t) {
  const f = await fixture(t),
    review = await f.settings.review(f.projectDir, domain, ['input.txt']);
  await f.settings.sync(f.projectDir, domain, review.id);
  const bundle = createProjectRuntime({
    projectDir: f.projectDir,
    domain,
    registry,
    remoteSettings: f.settings,
    directory: path.join(f.directory, 'local-store'),
  });
  f.runtimes.push(bundle.runtime);
  const chatId = crypto.randomUUID(),
    session = bundle.runtime.forSession(chatId),
    state = await session.inspect();
  const scope = { projectId: state.projectId, domain, stateId: state.id, tools: [toolId] };
  return {
    ...f,
    bundle,
    chatId,
    session,
    state,
    scope,
    action: { toolId, inputs: {}, expectedStateId: state.id },
  };
}
async function eventually(check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Fixture condition did not settle.');
}

test('blank settings remain unconfigured and location changes do not upload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let requests = 0;
  const settings = new RemoteSettings({
    directory: path.join(dir, 'config'),
    environment: {},
    fetch: () => {
      requests++;
    },
  });
  assert.deepEqual(await settings.check(), { status: 'not_configured', domains: [] });
  settings.setLocation(dir, domain, 'remote');
  assert.equal(
    new RemoteSettings({ directory: settings.directory, environment: {} }).project(dir, domain)
      .location,
    'remote',
  );
  assert.equal(requests, 0);
  assert.throws(
    () => createProjectRuntime({ projectDir: dir, domain, registry, remoteSettings: settings }),
    /confirm files.*upload/,
  );
});

test('explicit upload review binds exact bytes; later local modifications never upload implicitly', async t => {
  const f = await fixture(t);
  assert.equal((await f.settings.check()).status, 'connected');
  assert.ok(!JSON.stringify(f.settings.view()).includes('private-fixture-token'));
  fs.writeFileSync(path.join(f.projectDir, '.env'), 'SECRET=value');
  fs.symlinkSync(path.join(f.projectDir, 'input.txt'), path.join(f.projectDir, 'linked.txt'));
  assert.deepEqual(f.settings.candidates(f.projectDir), ['input.txt']);
  for (const file of ['.env', '../outside', 'linked.txt'])
    assert.throws(() => selectedSnapshot(f.projectDir, [file]));
  const review = await f.settings.review(f.projectDir, domain, ['input.txt']);
  assert.equal(f.uploads(), 0);
  fs.appendFileSync(path.join(f.projectDir, 'input.txt'), 'changed\n');
  await assert.rejects(f.settings.sync(f.projectDir, domain, review.id), /changed/);
  assert.equal(f.uploads(), 0);
  const approved = await f.settings.review(f.projectDir, domain, ['input.txt']),
    binding = await f.settings.sync(f.projectDir, domain, approved.id);
  assert.ok(binding.snapshotId);
  assert.equal(binding.protocol, '1.1');
  assert.equal(binding.location, 'remote');
  await assert.rejects(f.settings.sync(f.projectDir, domain, approved.id), /expired/);
  fs.appendFileSync(path.join(f.projectDir, 'input.txt'), 'requires explicit upload\n');
  await assert.rejects(f.settings.ensureSynced(f.projectDir, domain), /changed|upload/);
  assert.equal(f.uploads(), 1);
});

test('shared factory skips local Pack, rejects scope/approval and imports canonical evidence', async t => {
  const f = await prepared(t);
  const broker = resolveProjectTask(
    domain,
    { task: 'verify', state: f.state },
    undefined,
    runtimeCapabilities(registry, f.bundle),
    {},
    [],
    registry.domains,
  );
  assert.ok(broker.scope.tools.includes(toolId));
  assert.ok(!broker.scope.tools.includes('test.local-only'));
  assert.ok(!f.session.descriptors().some(tool => tool.id === 'project.task.run'));
  for (const scope of [
    { ...f.scope, projectId: 'f'.repeat(64) },
    { ...f.scope, tools: [] },
  ]) {
    const result = await f.session.execute(f.action, { scope, approval: true });
    assert.notEqual(result.verification.status, 'passed');
  }
  const denied = await f.session.execute(f.action, { scope: f.scope, approval: false });
  assert.notEqual(denied.verification.status, 'passed');
  assert.equal(f.calls(), 0);
  assert.equal((await f.session.describeTool(toolId, f.scope)).descriptor.id, toolId);
  const result = await f.session.execute(f.action, { scope: f.scope, approval: true });
  assert.equal(result.verification.status, 'passed');
  assert.equal(result.action.id, f.remote.listActions()[0].id);
  assert.equal(result.checkpoint.id, f.remote.latestCheckpoint().id);
  assert.equal(
    f.session.readArtifact(result.artifacts[0].id).content.toString(),
    '{"protocolFixture":true}\n',
  );
  assert.equal(f.session.status().status, 'completed');
  assert.ok(
    !fs
      .readFileSync(f.settings.taskFile(f.projectDir, domain, f.chatId), 'utf8')
      .includes('private-fixture-token'),
  );
  fs.appendFileSync(path.join(f.projectDir, 'input.txt'), 'changed locally\n');
  await assert.rejects(f.session.inspect(), /changed|upload/);
  assert.equal(f.uploads(), 1);
});

test('persistent chat keys isolate chats and reconnects; credential changes invalidate binding', async t => {
  const f = await prepared(t),
    first = f.settings.sessionBinding(f.projectDir, domain, f.chatId);
  const same = new RemoteSettings({
    directory: f.settings.directory,
    environment: f.environment,
  }).sessionBinding(f.projectDir, domain, f.chatId);
  assert.equal(first.clientSessionId, same.clientSessionId);
  const otherId = crypto.randomUUID(),
    other = f.bundle.runtime.forSession(otherId),
    second = f.settings.sessionBinding(f.projectDir, domain, otherId);
  assert.notEqual(first.clientSessionId, second.clientSessionId);
  await f.session.describeTool(toolId, f.scope);
  await other.inspect();
  await other.describeTool(toolId, f.scope);
  const ids = f.requests
    .filter(request => request.body?.method === 'initialize')
    .map(request => request.headers['x-client-session-id']);
  assert.deepEqual(new Set(ids), new Set([first.clientSessionId, second.clientSessionId]));
  f.environment.FIXTURE_TOKEN = 'changed-credential';
  assert.throws(
    () => f.settings.sessionBinding(f.projectDir, domain, f.chatId),
    /current remote service/,
  );
  await assert.rejects(f.session.inspect(), /configuration changed/);
});

test('stop only ends the local wait; invocation recovery and explicit terminate stay separate', async t => {
  const f = await prepared(t);
  f.block();
  const pending = f.session.execute(f.action, { scope: f.scope, approval: true });
  await eventually(() => f.invocations.size === 1);
  f.session.cancel();
  const stopped = await pending;
  assert.notEqual(stopped.verification.status, 'passed');
  assert.equal(f.session.status().status, 'unknown');
  assert.ok(!f.requests.some(request => request.url.endsWith('/terminate')));
  f.unblock();
  await eventually(() => [...f.invocations.values()][0].status === 'completed');
  await f.session.inspect();
  assert.equal(f.session.status().status, 'completed');
  assert.equal(f.calls(), 1);
  const current = await f.settings.session(f.projectDir, domain, f.chatId);
  assert.equal(current.status, 'idle');
  await assert.rejects(
    f.settings.terminateSession(f.projectDir, domain, f.chatId, crypto.randomUUID()),
    /changed/,
  );
  assert.equal(
    (await f.settings.terminateSession(f.projectDir, domain, f.chatId, current.id)).status,
    'stopped',
  );
  assert.equal(f.requests.filter(request => request.url.endsWith('/terminate')).length, 1);
});

test('service identity changes fail closed and credential-bearing endpoints are refused', async t => {
  const f = await fixture(t);
  assert.equal((await f.settings.check()).status, 'connected');
  const saved = f.settings.read();
  saved.service.serverId = crypto.randomUUID();
  f.settings.write(saved);
  assert.equal((await f.settings.check()).status, 'unavailable');
  assert.equal(f.settings.read().service.serverId, saved.service.serverId);
  for (const url of [
    'http://example.com',
    'https://secret@example.com',
    'https://example.com?token=secret',
  ])
    assert.throws(() => new RemoteGatewayClient({ url, credential: 'token' }), /clean HTTPS/);
});

test('artifact corruption cannot import acceptance and recovery never replays the MCP mutation', async t => {
  const f = await prepared(t);
  f.corrupt(true);
  const failed = await f.session.execute(f.action, { scope: f.scope, approval: true });
  assert.notEqual(failed.verification.status, 'passed');
  assert.ok(!f.session.listVerifications().some(item => item.status === 'passed'));
  assert.equal(f.session.status().status, 'unknown');
  f.corrupt(false);
  await f.session.inspect();
  assert.equal(f.session.status().status, 'completed');
  assert.ok(f.session.listVerifications().some(item => item.status === 'passed'));
  assert.equal(f.calls(), 1);
});

test('lost response recovers by invocation ID; missing unknown invocations are never replayed', async t => {
  const f = await prepared(t);
  f.loseResponse();
  const failed = await f.session.execute(f.action, { scope: f.scope, approval: true });
  assert.notEqual(failed.verification.status, 'passed');
  assert.equal(f.session.status().status, 'unknown');
  await f.session.inspect();
  assert.equal(f.session.status().status, 'completed');
  assert.equal(f.calls(), 1);
  f.bundle.runtime.publish(f.bundle.runtime.context(f.chatId), {
    invocationId: crypto.randomUUID(),
    toolId,
    status: 'unknown',
    outcome: 'unknown',
  });
  await assert.rejects(f.session.inspect(), /unknown|replay/);
  assert.equal(f.calls(), 1);
  assert.throws(() => f.settings.setLocation(f.projectDir, domain, 'local'), /active or unknown/);
});

test('releaseOwner and facade close reconnect the same chat using its durable application key', async t => {
  const f = await prepared(t);
  const first = await f.session.execute(f.action, { scope: f.scope, approval: true });
  assert.equal(first.verification.status, 'passed');
  const binding = f.settings.sessionBinding(f.projectDir, domain, f.chatId);
  const original = f.bundle.runtime.context(f.chatId);
  await f.session.releaseOwner('retiring-kimi-resource');
  assert.equal(f.bundle.runtime.contexts.has(f.chatId), false);
  assert.equal(original.client.closed, true);
  const state = await f.session.inspect();
  const replacement = f.bundle.runtime.context(f.chatId);
  assert.notEqual(replacement, original);
  assert.equal(
    f.settings.sessionBinding(f.projectDir, domain, f.chatId).clientSessionId,
    binding.clientSessionId,
  );
  const result = await f.session.execute(
    { ...f.action, expectedStateId: state.id },
    {
      scope: { ...f.scope, stateId: state.id },
      approval: true,
    },
  );
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.calls(), 2);
  const initialize = f.requests.filter(request => request.body?.method === 'initialize');
  assert.equal(initialize.length, 2);
  assert.ok(
    initialize.every(request => request.headers['x-client-session-id'] === binding.clientSessionId),
  );
  await f.session.close();
  assert.equal(f.bundle.runtime.contexts.has(f.chatId), false);
  assert.equal(replacement.client.closed, true);
  const reopened = f.bundle.runtime.forSession(f.chatId);
  assert.equal((await reopened.inspect()).id, result.state.id);
  assert.equal(
    f.settings.sessionBinding(f.projectDir, domain, f.chatId).clientSessionId,
    binding.clientSessionId,
  );
  assert.ok(!f.requests.some(request => request.url.endsWith('/terminate')));
});

test('closing a running chat fails safely and transport retirement blocks racing reconnects', async t => {
  const f = await prepared(t);
  f.block();
  const pending = f.session.execute(f.action, { scope: f.scope, approval: true });
  await eventually(() => f.invocations.size === 1);
  const active = f.bundle.runtime.context(f.chatId);
  await assert.rejects(f.session.close(), /running remote chat/);
  await assert.rejects(f.session.releaseOwner(), /running remote chat/);
  assert.equal(f.bundle.runtime.context(f.chatId), active);
  assert.equal(active.client.closed, undefined);
  f.unblock();
  assert.equal((await pending).verification.status, 'passed');
  let finish;
  const gate = new Promise(resolve => {
    finish = resolve;
  });
  const close = active.client.close.bind(active.client);
  active.client.close = async () => {
    await gate;
    await close();
  };
  const retiring = f.session.releaseOwner();
  assert.throws(() => f.bundle.runtime.context(f.chatId), /closing/);
  assert.equal(f.bundle.runtime.contexts.get(f.chatId), active);
  finish();
  await retiring;
  assert.equal(f.bundle.runtime.contexts.has(f.chatId), false);
  assert.ok(await f.session.inspect());
});

test('recovering chat A historical result after chat B executes never rolls the current head back', async t => {
  const f = await prepared(t);
  f.loseResponse();
  const failed = await f.session.execute(f.action, { scope: f.scope, approval: true });
  assert.notEqual(failed.verification.status, 'passed');
  const historical = [...f.invocations.values()][0].result;
  const other = f.bundle.runtime.forSession(crypto.randomUUID());
  const before = await other.inspect();
  assert.equal(before.id, historical.state.id);
  const latest = await other.execute(
    { ...f.action, expectedStateId: before.id },
    {
      scope: { ...f.scope, stateId: before.id },
      approval: true,
    },
  );
  assert.equal(latest.verification.status, 'passed');
  assert.notEqual(latest.state.id, historical.state.id);
  const recovered = await f.session.inspect();
  assert.equal(recovered.id, latest.state.id);
  assert.equal(f.session.state.id, latest.state.id);
  assert.equal(f.session.latestCheckpoint().state.id, latest.state.id);
  assert.equal(f.session.status().status, 'completed');
  assert.equal(f.calls(), 2);
});

for (const mode of ['approved snapshot hashes', 'artifact input hashes']) {
  test('self-consistent tampered ' + mode + ' cannot create accepted evidence', async t => {
    const f = await prepared(t);
    f.tamper(result => {
      const forged = { 'input.txt': 'b'.repeat(64) };
      if (mode === 'approved snapshot hashes') {
        result.action.inputHashes = forged;
        result.verification.evidence.inputHashes = forged;
        result.action.verification.evidence.inputHashes = forged;
        result.state.inputHashes = forged;
      }
      for (const artifact of result.artifacts) artifact.inputHashes = forged;
      result.state.artifacts = JSON.parse(JSON.stringify(result.artifacts));
      result.checkpoint.state = JSON.parse(JSON.stringify(result.state));
      result.checkpoint.stateHash = hash(JSON.stringify(result.checkpoint.state));
    });
    const result = await f.session.execute(f.action, { scope: f.scope, approval: true });
    assert.notEqual(result.verification.status, 'passed');
    assert.equal(
      f.session.listVerifications().some(value => value.status === 'passed'),
      false,
    );
    assert.equal(f.session.status().status, 'unknown');
    assert.equal(f.calls(), 1);
  });
}

function rebindFixture(t, failure = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-rebind-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectDir = path.join(directory, 'project'),
    otherDir = path.join(directory, 'other');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(otherDir);
  const configDir = path.join(directory, 'config'),
    newProjectId = crypto.randomUUID();
  const previous = {
    location: 'remote',
    remoteProjectId: crypto.randomUUID(),
    canonicalProjectId: hash('old-canonical'),
    serviceIdentity: hash('old-service'),
    snapshotId: crypto.randomUUID(),
    files: ['input.txt'],
    manifestDigest: hash('old-manifest'),
  };
  const other = { ...previous, remoteProjectId: crypto.randomUUID(), protocol: '1.1' };
  const projectKey = hash(fs.realpathSync(projectDir) + '\0' + domain),
    otherKey = hash(fs.realpathSync(otherDir) + '\0' + domain);
  const environment = {
    INDUSTRIAL_REMOTE_SERVICE_URL: 'https://new.example',
    INDUSTRIAL_REMOTE_CREDENTIAL_ENV: 'FIXTURE_TOKEN',
    FIXTURE_TOKEN: 'new-private-token',
  };
  const requests = [];
  const settings = new RemoteSettings({
    directory: configDir,
    environment,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      if (url.endsWith('/service-info')) {
        if (failure === 'info') return new Response('{"code":"UNAVAILABLE"}', { status: 503 });
        return new Response(
          JSON.stringify({
            remoteProtocolVersion: failure === 'protocol' ? '1.0' : '1.1',
            canonicalSchemaVersion: '1',
            serverId: 'new-server',
            sessionModel: 'application-session',
            domains: [domain],
            capabilities: { snapshots: true },
            domainCapabilities: [],
          }),
        );
      }
      assert.ok(url.endsWith('/v1/projects'));
      if (failure === 'project') return new Response('{"code":"OUTCOME_UNKNOWN"}', { status: 500 });
      return new Response(
        JSON.stringify({ id: newProjectId, canonicalProjectId: hash('new-canonical'), domain }),
      );
    },
  });
  fs.writeFileSync(
    settings.file,
    JSON.stringify({
      schemaVersion: 1,
      service: {
        serviceUrl: 'https://old.example',
        credentialEnv: 'FIXTURE_TOKEN',
        serverId: 'old-server',
      },
      projects: { [projectKey]: previous, [otherKey]: other },
    }),
  );
  return {
    directory,
    projectDir,
    otherDir,
    settings,
    previous,
    other,
    projectKey,
    otherKey,
    newProjectId,
    requests,
  };
}

test('explicit rebind accepts a new service pin, preserves old history and requires a fresh upload', async t => {
  const f = rebindFixture(t);
  const original = fs.readFileSync(f.settings.file, 'utf8');
  const intent = f.settings.rebindIntent(f.projectDir, domain);
  assert.equal(intent.previousProjectId, f.previous.remoteProjectId);
  assert.equal(intent.requiresExplicitUpload, true);
  assert.equal(intent.historicalFacts, 'retained_without_migration');
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
  assert.equal((await f.settings.check()).status, 'unavailable');
  assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
  const binding = await f.settings.rebind(f.projectDir, domain);
  assert.equal(binding.remoteProjectId, f.newProjectId);
  assert.equal(binding.protocol, '1.1');
  assert.equal(binding.serviceIdentity, f.settings.identity());
  assert.equal(binding.snapshotId, undefined);
  assert.equal(binding.files, undefined);
  assert.equal(binding.manifestDigest, undefined);
  assert.equal(binding.syncedAt, undefined);
  assert.deepEqual(binding.bindingHistory[0].binding, f.previous);
  assert.equal(binding.bindingHistory[0].service.serverId, 'old-server');
  assert.equal(f.settings.read().service.serverId, 'new-server');
  assert.deepEqual(f.settings.project(f.otherDir, domain), f.other);
  assert.equal(f.settings.view().status, 'connected');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  await assert.rejects(f.settings.ensureSynced(f.projectDir, domain), /upload/);
  assert.throws(
    () => f.settings.sessionBinding(f.otherDir, domain, crypto.randomUUID()),
    /current remote service/,
  );
});

for (const failure of ['info', 'protocol', 'project']) {
  test('failed rebind ' + failure + ' preserves the original settings and binding', async t => {
    const f = rebindFixture(t, failure),
      original = fs.readFileSync(f.settings.file, 'utf8');
    await assert.rejects(f.settings.rebind(f.projectDir, domain));
    assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
    assert.deepEqual(f.settings.project(f.projectDir, domain), f.previous);
    assert.equal(f.settings.locks.size, 0);
    assert.equal(
      f.requests.filter(request => request.method === 'POST').length,
      failure === 'project' ? 1 : 0,
    );
  });
}

for (const legacy of [false, true]) {
  test(
    'rebind refuses active or unknown ' + (legacy ? 'legacy jobs' : 'old credential invocations'),
    async t => {
      const f = rebindFixture(t),
        original = fs.readFileSync(f.settings.file, 'utf8');
      const root = path.join(f.settings.directory, legacy ? 'remote-jobs' : 'remote-invocations');
      fs.mkdirSync(root);
      const file = path.join(root, (legacy ? f.projectKey : crypto.randomUUID()) + '.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          remoteProjectId: f.previous.remoteProjectId,
          serviceIdentity: f.previous.serviceIdentity,
          status: 'unknown',
        }),
      );
      await assert.rejects(f.settings.rebind(f.projectDir, domain), /active or unknown/);
      assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
      assert.equal(f.requests.length, 0);
    },
  );
}

for (const observed of [
  { status: 'completed', outcome: 'completed' },
  { status: 'unexpected', outcome: 'unknown' },
  { status: 'failed', outcome: 'unknown' },
  null,
]) {
  test(
    'malformed invocation status stays unknown in Runtime recovery and explicit refresh: ' +
      (observed?.status || 'null'),
    async t => {
      const f = await prepared(t),
        id = crypto.randomUUID();
      const pending = {
        invocationId: id,
        toolId,
        action: f.action,
        inputHashes: f.state.inputHashes,
        status: 'running',
        outcome: 'unknown',
        needsImport: true,
      };
      f.invocations.set(id, observed === null ? null : { id, ...observed });
      f.bundle.runtime.publish(f.bundle.runtime.context(f.chatId), pending);
      await assert.rejects(f.session.inspect());
      assert.equal(f.session.status().status, 'unknown');
      assert.equal(f.session.status().needsImport, true);
      await assert.rejects(f.settings.refreshTask(f.projectDir, domain, f.chatId), /unknown/);
      assert.equal(f.session.status().status, 'unknown');
      assert.equal(f.session.status().needsImport, true);
      assert.equal(f.calls(), 0);
    },
  );
}

test('failed not_submitted invocation without a result safely ends pending recovery', async t => {
  const f = await prepared(t),
    id = crypto.randomUUID();
  f.invocations.set(id, { id, status: 'failed', outcome: 'not_submitted' });
  f.bundle.runtime.publish(f.bundle.runtime.context(f.chatId), {
    invocationId: id,
    toolId,
    action: f.action,
    inputHashes: f.state.inputHashes,
    status: 'unknown',
    outcome: 'unknown',
    needsImport: false,
  });
  assert.ok(await f.session.inspect());
  assert.equal(f.session.status().status, 'failed');
  assert.equal(f.session.status().outcome, 'not_submitted');
  assert.equal((await f.settings.refreshTask(f.projectDir, domain, f.chatId)).status, 'failed');
  assert.equal(f.calls(), 0);
});

test('changing the global service pin refuses another project active under the old identity', async t => {
  const f = rebindFixture(t),
    original = fs.readFileSync(f.settings.file, 'utf8');
  const root = path.join(f.settings.directory, 'remote-invocations');
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, crypto.randomUUID() + '.json'),
    JSON.stringify({
      remoteProjectId: f.other.remoteProjectId,
      serviceIdentity: f.other.serviceIdentity,
      status: 'running',
    }),
  );
  await assert.rejects(
    f.settings.rebind(f.projectDir, domain),
    /Another remote project.*active or unknown/,
  );
  assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(f.settings.locks.size, 0);
});

test('qualified metadata without protected execution never makes a remote domain executable', async t => {
  const f = rebindFixture(t),
    saved = f.settings.read();
  saved.service.serverId = 'new-server';
  f.settings.write(saved);
  f.settings.fetch = async () =>
    new Response(
      JSON.stringify({
        remoteProtocolVersion: '1.1',
        canonicalSchemaVersion: '1',
        serverId: 'new-server',
        sessionModel: 'application-session',
        domains: [domain],
        capabilities: { protectedExecution: false },
        domainCapabilities: [{ domain, qualification: 'qualified' }],
      }),
    );
  const view = await f.settings.check();
  assert.equal(view.status, 'connected');
  assert.deepEqual(view.executableDomains, []);
});
