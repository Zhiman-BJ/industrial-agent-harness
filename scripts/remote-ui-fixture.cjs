// Local UI fixture only. This is not a remote worker, OS sandbox or Verilator.
// Protocol handling follows packages/harness-core/tests/remote.test.cjs.
// Qualification below is a controlled UI test value; engineering verification
// always remains not_run. Nothing in this fixture runs an industrial program.
//
// Start: MOCK_REMOTE_TOKEN=mock-token node scripts/remote-ui-fixture.cjs
// Client: INDUSTRIAL_REMOTE_SERVICE_URL=http://127.0.0.1:8787
//         INDUSTRIAL_REMOTE_CREDENTIAL_ENV=MOCK_REMOTE_TOKEN
//         MOCK_REMOTE_TOKEN=mock-token
// Control: authenticated GET/POST /__fixture/state, with JSON changes:
//   {"queryFailure":true}                        -> session query returns 503
//   {"queryFailure":false,"sessionStatus":"idle"} -> clear fault / idle fixture session
//   {"sessionStatus":"stopped"}                  -> ended session
//   {"invocationMode":"unknown"}                 -> lose next call response, keep lookup unknown
//   {"invocationMode":"complete"}                -> reveal stored result without replay
// Readiness still requires the client's explicit file review and upload.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { IndustrialRuntime } = require('../packages/domain-runtime/src/industrial.cjs');
const { hash } = require('../packages/domain-runtime/src/remote-client.cjs');

const domain = 'chip';
const toolId = 'chip.eda.smoke';
const descriptor = {
  schemaVersion: '1',
  id: toolId,
  version: 'ui-fixture-1',
  risk: 'mutating',
  verification: ['ui.fixture.unverified'],
};
const terminal = status => ['stopped', 'expired', 'failed'].includes(status);

async function createFixture({ port = 0, directory, token = 'mock-token' } = {}) {
  assert.ok(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'Invalid fixture port');
  assert.ok(typeof token === 'string' && token.length >= 8, 'Use a nonempty fixture-only token');
  const ownedDirectory = !directory;
  const root = directory || fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-ui-'));
  fs.mkdirSync(root, { recursive: true });
  const serverId = crypto.randomUUID();
  const projects = new Map();
  const sessions = new Map();
  const grants = new Map();
  const invocations = new Map();
  const handlers = new Set();
  const controls = { queryFailure: false, sessionStatus: 'idle', invocationMode: 'complete' };
  const stats = { uploads: 0, calls: 0, terminations: 0 };
  let closed = false;

  function state() {
    return {
      fixture: true,
      engineeringExecution: false,
      ...controls,
      stats: { ...stats },
      projects: projects.size,
      sessions: [...sessions.values()].map(({ id, status, sandboxId }) => ({
        id,
        status,
        sandboxId,
      })),
    };
  }
  function setState(changes) {
    assert.ok(changes && typeof changes === 'object' && !Array.isArray(changes));
    for (const [key, value] of Object.entries(changes)) {
      assert.ok(Object.hasOwn(controls, key), 'Unknown fixture control');
      if (key === 'queryFailure') assert.equal(typeof value, 'boolean');
      if (key === 'sessionStatus')
        assert.ok(['idle', 'stopped', 'expired', 'failed'].includes(value));
      if (key === 'invocationMode') assert.ok(['complete', 'unknown'].includes(value));
    }
    Object.assign(controls, changes);
    if (Object.hasOwn(changes, 'sessionStatus'))
      for (const session of sessions.values()) session.status = controls.sessionStatus;
    return state();
  }
  function createProject() {
    const id = crypto.randomUUID();
    const workspace = path.join(root, id, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const project = { id, workspace, snapshotId: null, hashes: {} };
    project.runtime = new IndustrialRuntime(workspace, domain, {
      directory: path.join(root, id, 'store'),
      stateProvider: () => ({ stage: null, inputHashes: project.hashes }),
      tools: [
        {
          descriptor,
          execute: ({ action }) => {
            const report = path.join(workspace, `ui-fixture-${action.id}.json`);
            fs.writeFileSync(
              report,
              JSON.stringify({
                fixture: true,
                engineeringExecution: false,
                verification: 'not_run',
                message:
                  'UI protocol fixture only; no industrial software or OS sandbox was executed.',
              }),
            );
            return {
              executionSucceeded: true,
              artifacts: [{ kind: 'report.ui-fixture', file: report }],
              diagnostics: ['Controlled UI fixture only; not engineering acceptance.'],
            };
          },
        },
      ],
      verifiers: {
        'ui.fixture.unverified': () => ({
          status: 'not_run',
          reason: 'UI fixture does not execute or verify an engineering tool.',
          metrics: {},
        }),
      },
    });
    projects.set(id, project);
    return project;
  }
  function boundProject(request) {
    const project = projects.get(request.headers['x-remote-project-id']);
    assert.ok(project, 'Unknown fixture project binding');
    assert.ok(request.headers['x-client-session-id'], 'Missing client session binding');
    return project;
  }
  function sessionFor(request, project) {
    const key = `${project.id}:${request.headers['x-client-session-id']}`;
    if (!sessions.has(key)) {
      // Lazy fixture state, not a claim that a sandbox process was provisioned.
      sessions.set(key, {
        id: crypto.randomUUID(),
        status: controls.sessionStatus,
        callLocked: false,
        sandboxId: 'ui-fixture-no-os-sandbox',
        projectId: project.id,
      });
    }
    return sessions.get(key);
  }
  function invocationView(record) {
    if (controls.invocationMode === 'unknown')
      return { id: record.id, status: 'unknown', outcome: 'unknown' };
    return { id: record.id, status: record.status, outcome: record.outcome, result: record.result };
  }
  async function handle(request, response) {
    const send = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const fail = (code, status, message) =>
      send({ code, message, outcome: 'not_submitted' }, status);
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress))
        return fail('LOOPBACK_ONLY', 403, 'UI fixture accepts loopback clients only.');
      if (request.headers.authorization !== `Bearer ${token}`)
        return fail('UNAUTHORIZED', 401, 'Fixture token required.');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024)
          return fail('BODY_TOO_LARGE', 413, 'Fixture request exceeds the upload limit.');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
      const route = new URL(request.url, 'http://127.0.0.1').pathname;
      if (route === '/__fixture/state') {
        if (request.method === 'GET') return send(state());
        if (request.method === 'POST') return send(setState(body));
        return fail('METHOD_NOT_ALLOWED', 405, 'Use GET or POST.');
      }
      if (route === '/v1/service-info' && request.method === 'GET')
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
          // Controlled values exercise the existing UI gate; not native qualification.
          domainCapabilities: [
            {
              domain,
              qualification: 'qualified',
              label: 'UI fixture only; no engineering execution',
            },
          ],
          fixture: true,
          engineeringExecution: false,
        });
      if (route === '/v1/projects' && request.method === 'POST') {
        assert.equal(body.domain, domain);
        const project = createProject();
        return send({
          id: project.id,
          canonicalProjectId: project.runtime.project.projectId,
          domain,
        });
      }
      const projectRoute = route.match(/^\/v1\/projects\/([^/]+)\/(.+)$/);
      if (projectRoute) {
        const project = projects.get(projectRoute[1]);
        if (!project) return fail('PROJECT_NOT_FOUND', 404, 'Unknown fixture project.');
        const suffix = projectRoute[2];
        if (suffix === 'snapshots' && request.method === 'POST') {
          assert.equal(body.baseSnapshotId, project.snapshotId);
          assert.ok(body.manifest?.files?.length > 0 && body.manifest.files.length <= 256);
          const seen = new Set();
          let total = 0;
          for (const file of body.manifest.files) {
            assert.ok(
              typeof file.path === 'string' &&
                !file.path.includes('\\') &&
                !file.path.includes('\0') &&
                !file.path.startsWith('/') &&
                !file.path.split('/').some(part => !part || part === '.' || part === '..'),
            );
            assert.ok(!seen.has(file.path), 'Duplicate fixture upload path');
            seen.add(file.path);
            const upload = body.files.find(value => value.path === file.path);
            const content = Buffer.from(upload.contentBase64, 'base64');
            assert.equal(hash(content), file.sha256);
            assert.equal(content.length, file.sizeBytes);
            total += content.length;
          }
          assert.ok(total <= 8 * 1024 * 1024);
          const snapshotId = crypto.randomUUID();
          const snapshotRoot = path.join(root, project.id, 'snapshots', snapshotId);
          fs.mkdirSync(snapshotRoot, { recursive: true });
          for (const file of body.manifest.files) {
            const content = Buffer.from(
              body.files.find(value => value.path === file.path).contentBase64,
              'base64',
            );
            const target = path.join(snapshotRoot, file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
          }
          project.snapshotId = snapshotId;
          project.hashes = Object.fromEntries(
            body.manifest.files.map(file => [file.path, file.sha256]),
          );
          stats.uploads++;
          return send({
            id: snapshotId,
            projectId: project.id,
            manifest: body.manifest,
            state: await project.runtime.inspect(),
          });
        }
        if (suffix === 'state')
          return send({ snapshotId: project.snapshotId, state: await project.runtime.inspect() });
        if (suffix === 'capabilities')
          return send({
            domain,
            capabilitySnapshotHash: hash('remote-ui-fixture-v1'),
            tools: [descriptor],
          });
        if (suffix === 'grants' && request.method === 'POST') {
          assert.equal(boundProject(request), project);
          assert.equal(body.approval.decision, 'approved');
          assert.equal(body.approval.source, 'harness-host');
          assert.equal(body.scope.projectId, project.runtime.project.projectId);
          assert.equal(body.scope.domain, domain);
          assert.ok(body.scope.tools.includes(toolId));
          assert.equal(body.action.toolId, toolId);
          assert.ok(project.snapshotId && body.snapshotId === project.snapshotId);
          const id = crypto.randomUUID();
          grants.set(id, {
            ...body,
            projectId: project.id,
            clientSessionId: request.headers['x-client-session-id'],
          });
          return send({ invocationGrantId: id });
        }
        if (suffix.startsWith('invocations/')) {
          const record = invocations.get(suffix.split('/')[1]);
          if (controls.queryFailure)
            return fail('UI_FIXTURE_QUERY_FAILED', 503, 'Controlled UI fixture query failure.');
          return record?.projectId === project.id
            ? send(invocationView(record))
            : send({ code: 'INVOCATION_NOT_FOUND', outcome: 'unknown' }, 404);
        }
        if (suffix === 'artifacts')
          return send({
            artifacts: project.runtime
              .listActions()
              .flatMap(action =>
                action.artifactIds.map(id => project.runtime.readArtifact(id).artifact),
              ),
          });
        if (suffix.startsWith('artifacts/') && suffix.endsWith('/content')) {
          const artifact = project.runtime.readArtifact(suffix.split('/')[1]);
          response.writeHead(200, { 'content-length': artifact.content.length });
          response.end(artifact.content);
          return;
        }
      }
      if (route === `/v1/sessions/current/${domain}` && request.method === 'GET') {
        if (controls.queryFailure)
          return fail('UI_FIXTURE_QUERY_FAILED', 503, 'Controlled UI fixture query failure.');
        const project = boundProject(request);
        if (!project.snapshotId) return send({ code: 'SESSION_NOT_FOUND' }, 404);
        return send(sessionFor(request, project));
      }
      if (/^\/v1\/sessions\/[^/]+\/terminate$/.test(route) && request.method === 'POST') {
        const project = boundProject(request);
        const session = sessionFor(request, project);
        assert.equal(session.id, route.split('/')[3]);
        if (session.callLocked) return fail('SESSION_BUSY', 409, 'Fixture invocation is active.');
        session.status = 'stopped';
        stats.terminations++;
        return send(session);
      }
      if (route === `/v1/mcp/${domain}`) {
        if (request.method !== 'POST') return send({}, 405);
        const project = boundProject(request);
        if (body.method === 'initialize')
          return send({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'remote-ui-fixture-no-engineering', version: '1.1' },
            },
          });
        if (body.method.startsWith('notifications/')) {
          response.writeHead(202);
          response.end();
          return;
        }
        assert.equal(body.method, 'tools/call');
        const reply = value =>
          send({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
          });
        if (body.params.name === 'domain_tool_list') return reply({ tools: [descriptor] });
        if (body.params.name === 'domain_tool_describe')
          return reply({
            tool: descriptor,
            description: 'Controlled UI fixture only. No industrial program or OS sandbox runs.',
            inputs: {},
          });
        assert.equal(body.params.name, 'domain_tool_call');
        const args = body.params.arguments;
        assert.equal(args.toolId, toolId);
        const invocation = args.invocation;
        const grant = grants.get(invocation.invocationGrantId);
        assert.ok(grant && grant.projectId === project.id);
        assert.equal(grant.clientSessionId, request.headers['x-client-session-id']);
        assert.equal(grant.invocationId, invocation.invocationId);
        assert.deepEqual(grant.action, invocation.action);
        assert.deepEqual(args.arguments, invocation.action.inputs);
        const session = sessionFor(request, project);
        if (terminal(session.status))
          return fail('SESSION_ENDED', 409, 'Start a new fixture chat.');
        let record = invocations.get(invocation.invocationId);
        if (!record) {
          stats.calls++;
          session.callLocked = true;
          record = {
            id: invocation.invocationId,
            projectId: project.id,
            status: 'running',
            outcome: 'unknown',
          };
          invocations.set(record.id, record);
          try {
            const current = await project.runtime.inspect();
            record.result = await project.runtime.execute(invocation.action, {
              scope: { projectId: current.projectId, domain, stateId: current.id, tools: [toolId] },
              approval: true,
            });
            record.status = 'completed';
            record.outcome = 'completed';
          } finally {
            session.callLocked = false;
          }
        }
        if (controls.invocationMode === 'unknown') {
          response.destroy();
          return;
        }
        return reply({ invocationId: record.id, status: record.status, result: record.result });
      }
      return fail('ROUTE_NOT_FOUND', 404, 'Unknown UI fixture route.');
    } catch {
      if (!response.headersSent)
        return fail('UI_FIXTURE_INVALID_REQUEST', 400, 'Invalid UI fixture request.');
      response.destroy();
    }
  }
  const server = http.createServer((request, response) => {
    const pending = handle(request, response);
    handlers.add(pending);
    void pending.finally(() => handlers.delete(pending));
  });
  async function close() {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...handlers]);
    for (const project of projects.values()) await project.runtime.close();
    if (ownedDirectory) fs.rmSync(root, { recursive: true, force: true });
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    serverId,
    directory: root,
    domain,
    toolId,
    descriptor,
    setState,
    state,
    close,
  };
}

if (require.main === module) {
  createFixture({
    port: Number(process.env.REMOTE_UI_FIXTURE_PORT || 8787),
    token: process.env.MOCK_REMOTE_TOKEN || 'mock-token',
  })
    .then(fixture => {
      console.log(`UI fixture only (no engineering execution): ${fixture.url}`);
      console.log(
        'Use MOCK_REMOTE_TOKEN for the client and /__fixture/state; default test token is mock-token.',
      );
      const stop = () => void fixture.close().then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { createFixture, domain, toolId, descriptor };
