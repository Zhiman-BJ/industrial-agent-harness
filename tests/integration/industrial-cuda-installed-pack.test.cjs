const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PackManager, signCatalog } = require('../../packages/pack-manager/src/index.cjs');
const { createProjectRuntime } = require('../../packages/harness-core/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const owner = require('@zhiman-bj/industrial-domain-packs');
const source = owner.sourceDirectory('cuda-pack');
const { CudaService, startHttp } = require(path.join(source, 'server/mcp.cjs'));
const { imageLock, sha256 } = require(path.join(source, 'runtime/protocol.cjs'));
const execute = promisify(execFile);

test(
  'signed installed CUDA runtime loads pinned dependencies outside node_modules and uses real HTTP MCP',
  { timeout: 60000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-installed-cuda-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(directory, 'key.pem');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const output = path.join(directory, 'release');
    // This is portable installation/HTTP evidence, not native client or GPU
    // qualification. Build the exact owner package for its declared client.
    const platform = owner.consumerMetadata().domains.find(domain => domain.id === 'cuda')
      .qualifiedBundlePlatforms[0];
    await execute(
      process.execPath,
      [path.resolve(__dirname, '../../scripts/build-pack-distribution.cjs'), output],
      {
        cwd: path.resolve(__dirname, '../..'),
        timeout: 30000,
        env: {
          ...process.env,
          HARNESS_PACK_DOMAINS: 'cuda',
          HARNESS_PACK_PLATFORMS: platform,
          HARNESS_PACK_SIGNING_KEY_FILE: keyFile,
          HARNESS_PACK_SIGNING_KEY_ID: 'qualification',
          HARNESS_PACK_CHANNEL: 'beta',
        },
      },
    );
    const original = JSON.parse(fs.readFileSync(path.join(output, 'catalog.json'))).payload;
    // A test-only signed feed admits those unchanged bytes on this CI host to
    // exercise protocol loading with a fixture backend. Production qualification
    // metadata and its catalog remain untouched.
    const catalog = JSON.stringify(
      signCatalog(
        {
          ...original,
          packs: original.packs.map(pack => ({
            ...pack,
            platforms: [`${process.platform}-${process.arch}`],
          })),
        },
        'qualification',
        privateKey,
      ),
    );
    const manager = new PackManager({
      directory: path.join(directory, 'store'),
      keys: { qualification: publicKey.export({ type: 'spki', format: 'pem' }) },
      channel: 'beta',
    });
    const oldFetch = global.fetch;
    let entry;
    try {
      global.fetch = async () => new Response(catalog);
      entry = (await manager.catalog('https://qualification.example/catalog.json')).packs[0];
    } finally {
      global.fetch = oldFetch;
    }
    await manager.install(entry, {
      bytes: fs.readFileSync(path.join(output, path.basename(entry.url))),
      prepareRuntime: true,
    });
    assert.deepEqual(manager.scan().errors, []);
    const installed = manager.list()[0];
    assert.ok(!fs.existsSync(path.join(installed.location, 'node_modules')));
    const project = path.join(directory, 'project');
    fs.mkdirSync(path.join(project, 'kernels'), { recursive: true });
    fs.writeFileSync(path.join(project, 'model.py'), 'reference');
    fs.writeFileSync(path.join(project, 'model_new.py'), 'candidate');
    fs.writeFileSync(path.join(project, 'kernels/example.cu'), 'source');
    const config = {
      projectId: 'a'.repeat(64),
      stateDirectory: path.join(directory, 'service-state'),
      imageId: imageLock.imageId,
      gpuUuid: 'GPU-31ebe3bf-b2e5-5e2e-2350-131b6336dd39',
      taskSha256: sha256('reference'),
    };
    // Real MCP initialization/authentication/transport; backend readiness is an
    // explicit fixture and establishes no GPU or engineering qualification.
    const service = new CudaService(config, {
      check: async () => ({ ready: true, nativeQualification: 'fixture-only' }),
    });
    const server = await startHttp(service, {
      compilerToken: 'compiler-token',
      evaluatorToken: 'evaluator-token',
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const originalStore = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    process.env.INDUSTRIAL_HARNESS_PACK_STORE = manager.directory;
    t.after(() => {
      if (originalStore === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
      else process.env.INDUSTRIAL_HARNESS_PACK_STORE = originalStore;
    });
    const environment = { ...process.env };
    for (const role of ['compiler', 'evaluator']) {
      const prefix = 'INDUSTRIAL_HARNESS_CUDA_' + role.toUpperCase() + '_MCP_';
      environment[prefix + 'URL'] =
        'http://127.0.0.1:' + server.address().port + '/' + role + '/mcp';
      environment[prefix + 'TOKEN'] = role + '-token';
      environment[prefix + 'IDENTITY'] = sha256(JSON.stringify(service.identities[role]));
    }
    const bundle = createProjectRuntime({
      projectDir: project,
      domain: 'cuda',
      directory: path.join(directory, 'state'),
      environment,
    });
    t.after(() => bundle.runtime.close());
    const state = await bundle.runtime.inspect();
    const scope = resolveFromState(
      { task: 'Check CUDA Compiler and Evaluator readiness', state },
      bundle.capabilities,
    ).scope;
    for (const toolId of ['cuda.compiler.check', 'cuda.evaluator.check']) {
      const current = await bundle.runtime.inspect();
      const result = await bundle.runtime.execute(
        { toolId, inputs: {}, expectedStateId: current.id },
        { scope },
      );
      assert.equal(result.action.status, 'completed', JSON.stringify(result.action));
      assert.match(result.action.diagnostics.join('\n'), /fixture-only/);
      assert.equal(result.verification.status, 'not_run');
    }
    await bundle.runtime.close();
    assert.deepEqual(manager.scan().errors, []);
  },
);
