const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { RemoteSettings } = require('../src/remote-settings.cjs');
const {
  createRemoteRuntime,
  createWorkspacePlugin,
  IndustrialRuntime,
  hash,
} = require('@industrial-agent-harness/domain-runtime');
const json = value =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function setup(
  t,
  {
    corrupt = false,
    disconnect = false,
    metadataOnly = false,
    staleCatalog = false,
    failedReceipt = false,
    workerTools = ['test.run'],
    wrongDescription = false,
    releaseSessions = true,
    releaseFailure = false,
    releaseSessionChange = {},
    unconfirmedStop = false,
    sessionLimit = 1,
    sharedWorkspace = false,
    prepareInputs,
  } = {},
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
  const sessions = new Map();
  let terminations = 0;
  const fetch = async (url, init) => {
    const route = new URL(url).pathname;
    urls.push(route);
    const clientSessionId = new Headers(init.headers).get('x-client-session-id');
    if (releaseSessions && route === '/v1/sessions/current/test') {
      const session = sessions.get(clientSessionId);
      return session
        ? json({ ...session, ...releaseSessionChange })
        : new Response(JSON.stringify({ error: { code: 'SESSION_NOT_FOUND' } }), { status: 404 });
    }
    if (releaseSessions && route.endsWith('/terminate')) {
      terminations++;
      if (releaseFailure === true || (releaseFailure === 'once' && terminations === 1))
        throw Error('Teardown transport lost');
      const session = [...sessions.values()].find(item => route.includes(item.id));
      assert.ok(session);
      session.status = unconfirmedStop ? 'stopping' : 'stopped';
      return json(session);
    }
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
                    worker: { toolIds: workerTools },
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
      if (body.method === 'initialize') {
        if (releaseSessions && !sessions.has(clientSessionId)) {
          assert.ok(
            [...sessions.values()].filter(item => item.status !== 'stopped').length < sessionLimit,
            'active session quota',
          );
          sessions.set(clientSessionId, {
            id: randomUUID(),
            projectId,
            domain: 'test',
            clientSessionId,
            status: 'idle',
            callLocked: false,
          });
        }
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
        });
      }
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
        assert.ok(workerTools.includes(body.params.arguments.toolId));
        payload = {
          tool: { id: wrongDescription ? 'test.foreign' : body.params.arguments.toolId },
          inputs: { type: 'object' },
        };
      } else {
        calls++;
        assert.equal(body.params.arguments.snapshotId, snapshotId);
        assert.equal(body.params.arguments.expectedStateId, null);
        assert.equal(body.params.arguments.invocation, undefined);
        if (disconnect) throw Error('socket disconnected');
        payload = {
          status: failedReceipt ? 'failed' : 'completed',
          persisted: true,
          state: null,
          evidence: { requestId: body.params.arguments.requestId },
          verification: {
            schemaVersion: '1',
            id: randomUUID(),
            status: failedReceipt ? 'failed' : 'passed',
            verifierId: 'test.check',
            reason: failedReceipt ? 'Fixture verifier failed.' : 'Fixture verifier passed.',
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
    prepareInputs: prepareInputs && (context => prepareInputs(context, { settings, projectDir })),
  };
  if (sharedWorkspace) {
    const plugin = createWorkspacePlugin({
      domain: 'test',
      protectedPaths: [path.join(projectDir, 'remote-results')],
    });
    plugin.tools = plugin.tools.filter(tool => tool.descriptor.id !== 'project.task.run');
    plugin.tools.push({
      descriptor: {
        schemaVersion: '1',
        id: 'remote.plan',
        version: '1',
        risk: 'read-only',
        verification: [],
      },
      execute: async () => ({ artifacts: [], diagnostics: ['local planning is available'] }),
      preview: () => ({ title: 'Plan remote inputs', text: 'Only the proposed input list.' }),
    });
    options.workspaceRuntime = new IndustrialRuntime(projectDir, 'test', {
      directory: path.join(root, 'runtime', 'remote-workspaces'),
      projectRef: {
        schemaVersion: '1',
        projectId: settings.project(projectDir, 'test').canonicalProjectId,
        domain: 'test',
      },
      stateProvider: plugin.stateProvider,
      tools: plugin.tools,
      verifiers: plugin.verifiers,
    });
    options.workspaceCapabilities = [
      ...plugin.capabilities,
      { id: 'remote.planning', tools: [{ id: 'remote.plan', summary: 'Plan remote inputs' }] },
    ];
  }
  let bundle = createRemoteRuntime(options);
  const chatId = randomUUID();
  let runtime = bundle.runtime.forSession(chatId);
  t.after(async () => {
    await bundle.runtime.close();
    if (options.workspaceRuntime) await options.workspaceRuntime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    settings,
    projectDir,
    chatId,
    urls,
    sessions,
    options,
    get terminations() {
      return terminations;
    },
    get runtime() {
      return runtime;
    },
    get ownerRuntime() {
      return bundle.runtime;
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
  assert.equal(f.runtime.status().needsImport, false);
  const requestsBeforeRead = f.urls.length;
  for (const kind of ['run', 'action', 'state', 'verification', 'checkpoint'])
    assert.deepEqual(f.runtime.get(kind, result[kind].id), result[kind]);
  assert.deepEqual(f.runtime.get('artifact', result.artifacts[0].id), result.artifacts[0]);
  assert.equal(f.runtime.get('presentation', result.action.id).actionId, result.action.id);
  assert.equal(f.runtime.get('artifact', randomUUID()), null);
  f.runtime.assertProjectBound();
  assert.equal(f.urls.length, requestsBeforeRead, 'record reads must not contact the service');
  assert.equal(
    f.runtime.readArtifact(result.artifacts[0].id).content.toString(),
    'actual fixture evidence',
  );
  assert.equal((await f.settings.artifacts(f.projectDir, 'test')).length, 1);
  await f.reopen();
  assert.deepEqual(f.runtime.get('action', result.action.id), result.action);
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
test('metadata-only discovery exposes every protected worker tool, not only the entry descriptor', async t => {
  const workerTools = ['test.run', 'test.inspect', 'test.export', 'test.edit'];
  const f = await setup(t, { metadataOnly: true, workerTools });
  await f.runtime.inspect();
  assert.deepEqual(
    f.runtime.remoteTools.map(tool => tool.id),
    workerTools,
  );
  const result = await invoke(f);
  const index = JSON.parse(
    fs.readFileSync(
      path.join(
        f.projectDir,
        path.dirname(result.artifacts[0].relativePath),
        'artifact-bundle.json',
      ),
    ),
  );
  assert.equal(index.artifacts[0].sha256, result.artifacts[0].sha256);
  assert.equal(index.artifacts[0].name, path.basename(result.artifacts[0].relativePath));
});
for (const options of [
  { workerTools: ['test.run', 'test.run'] },
  { workerTools: [] },
  { workerTools: Array(129).fill('test.run') },
  { wrongDescription: true },
])
  test(`invalid protected worker inventory is rejected: ${JSON.stringify(options)}`, async t => {
    const f = await setup(t, { metadataOnly: true, ...options });
    await assert.rejects(f.runtime.inspect(), /profile/i);
    assert.equal(f.calls, 0);
    assert.deepEqual(f.runtime.remoteTools, []);
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

function gate() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}
function executeFrom(f, state) {
  return f.runtime.execute(
    { toolId: 'test.run', inputs: {}, expectedStateId: state.id },
    {
      scope: { projectId: state.projectId, domain: 'test', stateId: state.id, tools: ['test.run'] },
      approval: true,
    },
  );
}

for (const phase of ['listTools', 'info', 'describeTool'])
  test(`cancellation during ${phase} preflight never submits a mutation`, async t => {
    const f = await setup(t, { metadataOnly: true });
    const state = await f.runtime.inspect();
    const client = phase === 'info' ? f.runtime.control : f.runtime.context(f.chatId).client;
    const original = client[phase].bind(client);
    const entered = gate(),
      release = gate();
    client[phase] = async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    };
    const pending = executeFrom(f, state);
    await entered.promise;
    f.runtime.cancel();
    release.resolve();
    const result = await pending;
    assert.equal(f.calls, 0);
    assert.equal(result.action.status, 'failed');
    assert.notEqual(result.verification.status, 'passed');
    assert.equal(f.runtime.status(), null);
    client[phase] = original;
    assert.equal((await invoke(f)).action.status, 'completed');
    assert.equal(f.calls, 1, 'a later explicitly approved request can still run');
  });

test('a completed but unimported journal blocks execution and settings changes after reopen', async t => {
  const f = await setup(t);
  await invoke(f);
  const file = f.settings.taskFile(f.projectDir, 'test', f.chatId);
  // Reconstruct the durable phase written before download, as left by a stopped process.
  const pending = { ...f.runtime.status(), needsImport: true };
  fs.writeFileSync(file, JSON.stringify(pending));
  await f.reopen();
  await assert.rejects(f.runtime.inspect(), /import|recover/i);
  const refreshed = await f.settings.refreshTask(f.projectDir, 'test', f.chatId);
  assert.equal(refreshed.needsImport, true);
  assert.equal(refreshed.requestId, pending.requestId);
  assert.throws(() => f.settings.setLocation(f.projectDir, 'test', 'local'), /import|recover/i);
  await assert.rejects(f.settings.rebind(f.projectDir, 'test'), /import|recover/i);
  assert.throws(() => f.settings.assertServiceIdle(), /import|recover/i);
  const other = f.runtime.forSession(randomUUID());
  await assert.rejects(other.inspect(), /import|recover/i);
  assert.equal(f.calls, 1);
});

for (const phase of ['collection', 'commit'])
  test(`local ${phase} failure preserves pending import and blocks replay after reopen`, async t => {
    const f = await setup(t);
    if (phase === 'collection')
      f.runtime.workspace.collect = async () => {
        throw Error('Injected CAS write failure');
      };
    else {
      const put = f.runtime.workspace.put.bind(f.runtime.workspace);
      let injected = false;
      f.runtime.workspace.put = (kind, ...args) => {
        if (kind === 'artifact' && !injected) {
          injected = true;
          throw Error('Injected canonical transaction failure');
        }
        return put(kind, ...args);
      };
    }
    const result = await invoke(f);
    assert.equal(result.action.status, 'failed');
    assert.notEqual(result.verification.status, 'passed');
    const pending = f.runtime.status();
    assert.equal(pending.needsImport, true);
    assert.ok(
      fs.existsSync(
        path.join(f.settings.directory, 'remote-receipts', pending.requestId + '.json'),
      ),
    );
    await f.reopen();
    await assert.rejects(f.runtime.inspect(), /import|recover/i);
    assert.equal(f.runtime.status().requestId, pending.requestId);
    assert.equal(f.calls, 1);
  });

test('a failed remote result with committed evidence completes import without claiming acceptance', async t => {
  const f = await setup(t, { failedReceipt: true });
  const result = await invoke(f);
  assert.equal(result.action.status, 'failed');
  assert.equal(result.verification.status, 'failed');
  assert.equal(f.runtime.status().status, 'failed');
  assert.equal(f.runtime.status().needsImport, false);
  await f.reopen();
  assert.equal((await f.runtime.inspect()).id, result.state.id);
  assert.equal(f.calls, 1);
});

for (const phase of ['callProtectedTool', 'downloadProducedArtifact'])
  test(`cancelling during ${phase} preserves the submitted request and never replays it`, async t => {
    const f = await setup(t);
    const state = await f.runtime.inspect();
    const client = f.runtime.context(f.chatId).client;
    const original = client[phase].bind(client);
    const entered = gate();
    client[phase] = async (...args) => {
      // The server has already executed; hold its response/download until Stop.
      await original(...args);
      const signal = args.at(-1).signal;
      const waiting = new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      entered.resolve();
      return waiting;
    };
    const pending = executeFrom(f, state);
    await entered.promise;
    // Another chat's Stop must not cancel the owner of this workspace action.
    const other = f.runtime.forSession(randomUUID());
    other.cancel();
    assert.equal(f.runtime.workspace.abortController.signal.aborted, false);
    f.runtime.cancel();
    const result = await pending;
    assert.equal(result.action.status, 'failed');
    assert.notEqual(result.verification.status, 'passed');
    assert.equal(f.runtime.status().status, 'unknown');
    assert.equal(f.runtime.status().needsImport, phase === 'downloadProducedArtifact');
    await f.reopen();
    await assert.rejects(f.runtime.inspect(), /unknown/);
    assert.equal(f.calls, 1);
  });

test('the import flag clears only after canonical records are readable', async t => {
  const f = await setup(t);
  const put = f.runtime.workspace.put.bind(f.runtime.workspace);
  let committing = false;
  f.runtime.workspace.put = (kind, ...args) => {
    if (kind === 'artifact' || kind === 'verification') {
      committing = true;
      assert.equal(f.runtime.status().needsImport, true);
    }
    return put(kind, ...args);
  };
  const result = await invoke(f);
  assert.equal(committing, true);
  assert.equal(result.action.status, 'completed');
  assert.equal(f.runtime.status().needsImport, false);
  assert.deepEqual(f.runtime.workspace.get('action', result.action.id), result.action);
  assert.deepEqual(f.runtime.workspace.get('checkpoint', result.checkpoint.id), result.checkpoint);
});

test('a chat awaiting discovery cannot bypass another chat newly requiring import', async t => {
  const f = await setup(t, { sessionLimit: 2 });
  const state = await f.runtime.inspect();
  const client = f.runtime.context(f.chatId).client;
  const list = client.listTools.bind(client);
  const entered = gate(),
    release = gate();
  client.listTools = async (...args) => {
    entered.resolve();
    await release.promise;
    return list(...args);
  };
  const waiting = executeFrom(f, state);
  await entered.promise;
  const other = f.runtime.forSession(randomUUID());
  const put = f.runtime.workspace.put.bind(f.runtime.workspace);
  let injected = false;
  f.runtime.workspace.put = (kind, ...args) => {
    if (kind === 'artifact' && !injected) {
      injected = true;
      throw Error('Injected canonical transaction failure');
    }
    return put(kind, ...args);
  };
  const failed = await invoke({ runtime: other });
  assert.equal(failed.action.status, 'failed');
  assert.equal(other.status().needsImport, true);
  // The failed transaction leaves the original State valid, so stale-State
  // protection alone cannot prevent this second chat from submitting.
  assert.equal(failed.state.id, state.id);
  release.resolve();
  const result = await waiting;
  assert.equal(result.action.status, 'failed');
  assert.match(result.action.diagnostics.join('\n'), /import/);
  assert.equal(f.calls, 1);
});

test('completed imports automatically release quota and the same chat can run again', async t => {
  const f = await setup(t, { releaseSessions: true });
  const firstBinding = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
  const first = await invoke(f);
  assert.equal(first.action.status, 'completed');
  assert.equal(f.terminations, 1);
  assert.equal(f.runtime.status().sessionRelease.status, 'released');
  const nextBinding = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
  assert.notEqual(nextBinding.clientSessionId, firstBinding.clientSessionId);
  assert.equal(
    nextBinding.previousApplicationSessionId,
    f.runtime.status().sessionRelease.sessionId,
  );
  await f.runtime.inspect();
  assert.equal(f.sessions.size, 1, 'post-turn refresh must not reacquire the released quota');
  const second = await invoke(f);
  assert.equal(second.action.status, 'completed', second.action.diagnostics.join('\n'));
  assert.equal(f.terminations, 2);
  assert.equal(f.calls, 2);
  assert.equal(f.sessions.size, 2);
  assert.ok([...f.sessions.values()].every(item => item.status === 'stopped'));
  assert.equal(f.runtime.get('action', first.action.id).status, 'completed');
});
test('uncertain sandbox release preserves committed results and does not rotate the session key', async t => {
  const f = await setup(t, { releaseSessions: true, releaseFailure: true });
  const binding = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
  const result = await invoke(f);
  assert.equal(result.action.status, 'completed');
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.runtime.status().sessionRelease.status, 'pending');
  assert.equal(
    f.settings.sessionBinding(f.projectDir, 'test', f.chatId).clientSessionId,
    binding.clientSessionId,
  );
  await assert.rejects(() => f.runtime.inspect(), /release is not confirmed/);
  assert.equal(f.calls, 1, 'uncertain teardown must not dispatch another engineering call');
});
test('a later refresh confirms deferred release before the same chat executes again', async t => {
  const f = await setup(t, { releaseSessions: true, releaseFailure: 'once' });
  const first = await invoke(f);
  assert.equal(first.action.status, 'completed');
  assert.equal(f.runtime.status().sessionRelease.status, 'pending');
  await f.runtime.inspect();
  assert.equal(f.runtime.status().sessionRelease.status, 'released');
  assert.equal(f.sessions.size, 1);
  const second = await invoke(f);
  assert.equal(second.action.status, 'completed');
  assert.equal(f.calls, 2);
  assert.equal(f.terminations, 3);
});
test('closing a released MCP transport cannot invalidate the committed result', async t => {
  const f = await setup(t);
  const state = await f.runtime.inspect();
  const client = f.runtime.context(f.chatId).client;
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    throw Error('Injected transport close failure');
  };
  const result = await executeFrom(f, state);
  assert.equal(result.action.status, 'completed');
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.runtime.status().sessionRelease.status, 'released');
});
for (const releaseSessionChange of [
  { callLocked: true },
  { projectId: randomUUID() },
  { clientSessionId: randomUUID() },
  { domain: 'foreign' },
])
  test(`automatic release rejects mismatched or busy session: ${Object.keys(releaseSessionChange)[0]}`, async t => {
    const f = await setup(t, { releaseSessions: true, releaseSessionChange });
    const binding = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
    const result = await invoke(f);
    assert.equal(result.action.status, 'completed');
    assert.equal(f.runtime.status().sessionRelease.status, 'pending');
    assert.equal(f.terminations, 0);
    assert.equal(
      f.settings.sessionBinding(f.projectDir, 'test', f.chatId).clientSessionId,
      binding.clientSessionId,
    );
  });
test('stopping does not count as a confirmed released sandbox', async t => {
  const f = await setup(t, { releaseSessions: true, unconfirmedStop: true });
  const binding = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
  const result = await invoke(f);
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.runtime.status().sessionRelease.status, 'pending');
  assert.equal(
    f.settings.sessionBinding(f.projectDir, 'test', f.chatId).clientSessionId,
    binding.clientSessionId,
  );
});
for (const failure of ['corrupt', 'disconnect'])
  test(`automatic release preserves ${failure} recovery evidence`, async t => {
    const f = await setup(t, { releaseSessions: true, [failure]: true });
    await invoke(f);
    assert.equal(f.terminations, 0);
    assert.equal(await f.settings.releaseCompletedSession(f.projectDir, 'test', f.chatId), null);
    assert.equal(f.terminations, 0);
  });

test('an injected workspace keeps local planning State, tools and previews across remote reopen', async t => {
  const f = await setup(t, { sharedWorkspace: true });
  const workspace = f.options.workspaceRuntime;
  assert.equal(f.runtime.workspace, workspace);
  assert.equal(f.runtime.ownsWorkspace, false);
  fs.writeFileSync(path.join(f.projectDir, 'planning.txt'), 'local unsynced planning notes');
  const state = await f.runtime.inspect();
  assert.equal(state.inputHashes['planning.txt'], hash('local unsynced planning notes'));
  assert.ok(f.runtime.descriptors().some(tool => tool.id === 'remote.plan'));
  assert.ok(f.runtime.capabilities.some(capability => capability.id === 'remote.planning'));
  assert.equal(
    f.runtime.approvalPreview({ toolId: 'remote.plan', inputs: {}, expectedStateId: state.id })
      .title,
    'Plan remote inputs',
  );
  const remoteTool = workspace.tools.get('test.run');
  assert.ok(remoteTool);
  await f.reopen();
  assert.equal(f.runtime.workspace, workspace);
  assert.ok(workspace.db, 'transport teardown must not close the shared canonical store');
  assert.equal(workspace.tools.has('test.run'), false, 'old transport callbacks are removed');
  assert.ok(workspace.tools.has('remote.plan'));
  assert.equal((await f.runtime.inspect()).id, state.id);
  assert.notEqual(workspace.tools.get('test.run'), remoteTool);
});

test('transport close failures remove owned callbacks and preserve the injected workspace', async t => {
  const f = await setup(t, { sharedWorkspace: true });
  await f.runtime.inspect();
  const workspace = f.options.workspaceRuntime;
  const client = f.runtime.context(f.chatId).client;
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    throw Error('Injected transport close failure');
  };
  try {
    await assert.rejects(f.ownerRuntime.close(), /Injected transport close failure/);
    assert.ok(workspace.db);
    assert.equal(workspace.tools.has('test.run'), false);
    assert.ok(workspace.tools.has('remote.plan'));
    await workspace.inspect();
  } finally {
    client.close = close;
  }
});

for (const mismatch of ['projectId', 'domain', 'projectDir', 'closed'])
  test(`shared workspace rejects mismatched ${mismatch} before opening a second store`, async t => {
    const f = await setup(t, { sharedWorkspace: true });
    const workspace = Object.create(f.options.workspaceRuntime);
    if (mismatch === 'projectId')
      workspace.project = { ...workspace.project, projectId: randomUUID() };
    if (mismatch === 'domain') workspace.project = { ...workspace.project, domain: 'foreign' };
    if (mismatch === 'projectDir') workspace.projectDir = path.dirname(f.projectDir);
    if (mismatch === 'closed') workspace.db = null;
    assert.throws(
      () => createRemoteRuntime({ ...f.options, workspaceRuntime: workspace }),
      /Shared workspace does not match/,
    );
    assert.ok(f.options.workspaceRuntime.db);
    assert.equal(f.calls, 0);
  });

test('approved remote execution prepares modified inputs using the shared local State', async t => {
  let preparations = 0;
  const f = await setup(t, {
    sharedWorkspace: true,
    prepareInputs: async (context, { settings, projectDir }) => {
      preparations++;
      assert.equal(context.request.toolId, 'test.run');
      assert.equal(context.chatId, f.chatId);
      assert.equal(context.signal.aborted, false);
      const review = await settings.review(projectDir, 'test', ['input.txt']);
      await settings.sync(projectDir, 'test', review.id);
    },
  });
  await f.runtime.inspect();
  fs.writeFileSync(path.join(f.projectDir, 'input.txt'), 'updated input approved for execution');
  const state = await f.runtime.workspace.inspect();
  const result = await executeFrom(f, state);
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
  assert.equal(preparations, 1);
  assert.equal(f.calls, 1);
  assert.equal(
    result.action.inputHashes['input.txt'],
    hash('updated input approved for execution'),
  );
});

for (const invalid of ['approval', 'tool', 'project', 'domain', 'scopeState', 'requestState'])
  test(`input preparation cannot upload for invalid ${invalid}`, async t => {
    let preparations = 0;
    const f = await setup(t, {
      sharedWorkspace: true,
      prepareInputs: async () => preparations++,
    });
    const state = await f.runtime.inspect();
    const request = { toolId: 'test.run', inputs: {}, expectedStateId: state.id };
    const policy = {
      approval: true,
      scope: { projectId: state.projectId, domain: 'test', stateId: state.id, tools: ['test.run'] },
    };
    if (invalid === 'approval') policy.approval = false;
    if (invalid === 'tool') policy.scope.tools = [];
    if (invalid === 'project') policy.scope.projectId = randomUUID();
    if (invalid === 'domain') policy.scope.domain = 'foreign';
    if (invalid === 'scopeState') policy.scope.stateId = randomUUID();
    if (invalid === 'requestState') request.expectedStateId = randomUUID();
    const result = await f.runtime.execute(request, policy);
    assert.equal(result.action.status, 'failed');
    assert.match(result.action.diagnostics.join('\n'), /scope|approval/i);
    assert.equal(preparations, 0);
    assert.equal(f.calls, 0);
  });

test('cancellation during input preparation never submits an engineering mutation', async t => {
  const entered = gate(),
    release = gate();
  const f = await setup(t, {
    sharedWorkspace: true,
    prepareInputs: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const state = await f.runtime.inspect();
  const pending = executeFrom(f, state);
  await entered.promise;
  f.runtime.cancel();
  release.resolve();
  const result = await pending;
  assert.equal(result.action.status, 'failed');
  assert.equal(f.calls, 0);
  assert.equal(f.runtime.status(), null);
});

test('input preparation cannot rebind execution to another remote project', async t => {
  const f = await setup(t, {
    sharedWorkspace: true,
    prepareInputs: async (_context, { settings }) => {
      const read = settings.project.bind(settings);
      settings.project = (...args) => ({ ...read(...args), remoteProjectId: randomUUID() });
    },
  });
  const state = await f.runtime.inspect();
  const result = await executeFrom(f, state);
  assert.equal(result.action.status, 'failed');
  assert.match(result.action.diagnostics.join('\n'), /configuration changed/);
  assert.equal(f.calls, 0);
});
