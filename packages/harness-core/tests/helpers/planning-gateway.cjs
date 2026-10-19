const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { hash } = require('@industrial-agent-harness/domain-runtime');
const { RemoteSettings } = require('../../src/remote-settings.cjs');
const { createProjectRuntime } = require('../../src/project-runtime.cjs');

function planningGateway(t, { configured = true, runtimeInsideProject = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-runtime-'));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'input.txt'), 'task input');
  const projectId = randomUUID();
  const requests = [],
    uploads = [],
    invocations = [];
  const snapshots = new Map(),
    sessions = new Map(),
    artifacts = new Map();
  const controls = {
    capabilityHash: 'a'.repeat(64),
    inventoryHash: null,
    protected: true,
    failTool: false,
  };
  const tools = ['test.run', 'test.inspect', 'test.extra'];
  const fetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const route = new URL(url).pathname;
    requests.push({ route, method: init.method });
    const clientSessionId = new Headers(init.headers).get('x-client-session-id');
    if (route === '/v1/service-info')
      return Response.json({
        version: '1.1.0',
        domains: ['test'],
        sessionModel: 'application-session',
        capabilitySnapshotHash: controls.capabilityHash,
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
                    worker: { toolIds: tools },
                  },
                ],
              },
            ],
          },
        ],
      });
    if (route === '/v1/projects') return Response.json({ id: projectId, domain: 'test' });
    if (route.endsWith('/snapshots')) {
      const body = JSON.parse(init.body),
        snapshotId = randomUUID();
      uploads.push(body);
      snapshots.set(snapshotId, body.manifest);
      return Response.json({
        snapshotId,
        projectId,
        status: 'uploading',
        files: body.manifest.files.map(file => {
          const objectKey = `snapshots/${file.sha256.slice(0, 2)}/${file.sha256}`;
          return {
            ...file,
            upload: {
              method: 'PUT',
              objectKey,
              url: `${route}/${snapshotId}/objects/${objectKey}`,
            },
          };
        }),
      });
    }
    if (init.method === 'PUT') {
      assert.equal(hash(Buffer.from(init.body)), route.split('/').at(-1));
      return Response.json({});
    }
    if (route.endsWith('/complete'))
      return Response.json({
        snapshotId: route.split('/').at(-2),
        projectId,
        status: 'ready',
      });
    if (route === '/v1/sessions/current/test') {
      const session = sessions.get(clientSessionId);
      return session
        ? Response.json(session)
        : Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 });
    }
    if (route.endsWith('/terminate')) {
      const session = [...sessions.values()].find(item => route.includes(item.id));
      assert.ok(session);
      session.status = 'stopped';
      return Response.json(session);
    }
    if (route.endsWith('/download')) {
      const id = route.split('/').at(-2);
      assert.ok(artifacts.has(id));
      return new Response(artifacts.get(id));
    }
    if (route === '/v1/mcp/test') {
      if (!init.body) return new Response(null, { status: 405 });
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize') {
        if (!sessions.has(clientSessionId))
          sessions.set(clientSessionId, {
            id: randomUUID(),
            projectId,
            domain: 'test',
            clientSessionId,
            status: 'ready',
            callLocked: false,
          });
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'planning-fixture', version: '1' },
          },
        });
      }
      let payload;
      if (body.params.name === 'domain_tool_list') {
        if (controls.failInventory) throw Error('Protected MCP unavailable');
        payload = {
          domain: 'test',
          protected: controls.protected,
          capabilitySnapshotHash: controls.inventoryHash || controls.capabilityHash,
          packId: 'test-pack',
          profileId: 'test-native',
          ...(controls.liveTools
            ? { tools: controls.liveTools.map(id => ({ id, version: '1' })) }
            : {}),
        };
      } else if (body.params.name === 'domain_tool_describe') {
        assert.ok(tools.includes(body.params.arguments.toolId));
        payload = { tool: { id: body.params.arguments.toolId }, inputs: { type: 'object' } };
      } else {
        const request = body.params.arguments;
        invocations.push(request);
        assert.ok(snapshots.has(request.snapshotId));
        await controls.beforeInvoke?.(request);
        if (controls.failTool) throw Error('Engineering response lost');
        const id = randomUUID(),
          content = Buffer.from('verified fixture evidence');
        artifacts.set(id, content);
        payload = {
          status: 'completed',
          persisted: true,
          state: null,
          evidence: { requestId: request.requestId },
          verification: {
            schemaVersion: '1',
            id: randomUUID(),
            status: 'passed',
            verifierId: 'test.check',
            reason: 'Fixture evidence matches.',
            metrics: {},
            evidence: { artifactIds: [id], inputHashes: { 'invocation.json': 'b'.repeat(64) } },
          },
          artifacts: [
            {
              artifactId: id,
              kind: 'report.result',
              sha256: hash(content),
              sizeBytes: content.length,
            },
          ],
        };
      }
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        },
      });
    }
    throw Error(`Unexpected fixture request ${init.method} ${route}`);
  };
  const environment = configured
    ? {
        INDUSTRIAL_REMOTE_SERVICE_URL: 'https://planning.example',
        INDUSTRIAL_REMOTE_CREDENTIAL_ENV: 'TEST_TOKEN',
        TEST_TOKEN: 'fixture-token',
      }
    : {};
  const settings = new RemoteSettings({
    directory: path.join(root, 'settings'),
    environment,
    fetch,
  });
  settings.setLocation(projectDir, 'test', 'remote');
  const runtimeOptions = {
    projectDir,
    domain: 'test',
    directory: path.join(runtimeInsideProject ? projectDir : root, 'runtime'),
    environment,
    remoteSettings: settings,
    registry: { capabilities: [], runtimePacks: [] },
  };
  const bundle = createProjectRuntime(runtimeOptions);
  const chatId = randomUUID(),
    taskId = randomUUID(),
    runtime = bundle.runtime.forSession(chatId);
  t.after(async () => {
    await bundle.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    projectDir,
    settings,
    bundle,
    runtime,
    chatId,
    taskId,
    requests,
    uploads,
    invocations,
    snapshots,
    sessions,
    controls,
    runtimeOptions,
  };
}
module.exports = { planningGateway };
