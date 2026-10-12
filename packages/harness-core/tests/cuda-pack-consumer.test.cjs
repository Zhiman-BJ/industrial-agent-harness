const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const owner = require('@zhiman-bj/industrial-domain-packs');
const { loadRegistry, materializeSkills } = require('../../domain-skills/src/index.cjs');
const { createProjectRuntime } = require('../src/project-runtime.cjs');
const { resolveFromState } = require('../../capability-broker/src/index.cjs');
const { CudaService, startHttp } = require(
  path.join(owner.sourceDirectory('cuda-pack'), 'server/mcp.cjs'),
);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// node:test runs after hooks in registration order, so cleanup must close the
// runtime (and its SQLite handles) before removing the tree: on Windows an
// open -wal/-shm keeps every unlink busy and the suite stalls on retries.
const cleanup = root => {
  let bound;
  let server;
  return {
    bind(runtime) {
      bound = runtime;
    },
    listen(httpServer) {
      server = httpServer;
    },
    async run() {
      if (bound) await bound.runtime.close().catch(() => {});
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
};

test('default consumer offers four domains and no standalone CUDA resources', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offered-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = loadRegistry();
  assert.deepEqual(registry.domains.map(domain => domain.id).sort(), [
    'cad',
    'chip',
    'godot',
    'pcb',
  ]);
  assert(!registry.runtimePacks.some(pack => pack.id === 'cuda-pack'));
  assert(!registry.skills.some(skill => skill.domain === 'cuda'));
  assert(!registry.capabilities.some(capability => capability.domain === 'cuda'));
  assert.throws(
    () => materializeSkills({ skills: ['cuda.kernel.optimize'] }, directory),
    /Unknown/,
  );
});

test('explicit standalone CUDA runtime remains unavailable without remote configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuda-standalone-unconfigured-'));
  const cleaner = cleanup(root);
  t.after(() => cleaner.run());
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'model.py'), 'reference');
  fs.writeFileSync(path.join(projectDir, 'model_new.py'), 'candidate');
  const bound = createProjectRuntime({
    projectDir,
    domain: 'cuda',
    directory: path.join(root, 'store'),
    environment: { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') },
    registry: require('../../../tests/fixtures/standalone-cuda.cjs').registry(),
  });
  cleaner.bind(bound);
  const state = await bound.runtime.inspect();
  assert.equal(state.stage, 'kernel');
  assert(!bound.runtime.descriptors().some(tool => tool.id.startsWith('cuda.')));
});

test('shared factory and Broker use both authenticated MCP identities from the pinned owner', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuda-consumer-http-'));
  const cleaner = cleanup(root);
  t.after(() => cleaner.run());
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'model.py'), 'reference');
  fs.writeFileSync(path.join(projectDir, 'model_new.py'), 'candidate');
  const config = {
    projectId: hash(projectDir + '\0cuda'),
    stateDirectory: path.join(root, 'native-store'),
    imageId: require(path.join(owner.sourceDirectory('cuda-pack'), 'locks/rtx4090-image.json'))
      .imageId,
    gpuUuid: 'GPU-31ebe3bf-b2e5-5e2e-2350-131b6336dd39',
    taskSha256: hash('reference'),
  };
  const service = new CudaService(config, {
    check: async () => ({ ready: true, nativeQualification: 'transport-fixture-only' }),
  });
  const server = await startHttp(service, {
    compilerToken: 'compiler-test-token',
    evaluatorToken: 'evaluator-test-token',
  });
  cleaner.listen(server);
  const environment = { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') };
  for (const role of ['compiler', 'evaluator']) {
    const prefix = 'INDUSTRIAL_HARNESS_CUDA_' + role.toUpperCase() + '_MCP_';
    environment[prefix + 'URL'] = 'http://127.0.0.1:' + server.address().port + '/' + role + '/mcp';
    environment[prefix + 'TOKEN'] = role + '-test-token';
    environment[prefix + 'IDENTITY'] = hash(JSON.stringify(service.identities[role]));
  }
  const bound = createProjectRuntime({
    projectDir,
    domain: 'cuda',
    directory: path.join(root, 'store'),
    environment,
    registry: require('../../../tests/fixtures/standalone-cuda.cjs').registry(),
  });
  cleaner.bind(bound);
  for (const role of ['compiler', 'evaluator']) {
    const state = await bound.runtime.inspect(),
      scope = resolveFromState(
        { task: 'CUDA kernel optimization', state },
        bound.capabilities,
      ).scope;
    assert(scope.skills.includes('cuda.kernel.optimize'));
    const result = await bound.runtime.execute(
      {
        schemaVersion: '1',
        projectId: state.projectId,
        domain: state.domain,
        toolId: 'cuda.' + role + '.check',
        expectedStateId: state.id,
        inputs: {},
      },
      { scope },
    );
    assert.equal(result.action.status, 'completed');
    assert.equal(result.verification.status, 'not_run');
    assert.equal(JSON.parse(result.action.diagnostics[0]).identity.role, role);
  }
});
