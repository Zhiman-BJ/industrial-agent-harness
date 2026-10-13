const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RuntimeEnvironmentManager,
  PackManager,
  signCatalog,
} = require('../../packages/pack-manager/src/index.cjs');
const { createProjectRuntime } = require('../../packages/harness-core/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const owner = require('@zhiman-bj/industrial-domain-packs');
const source = owner.sourceDirectory('cuda-pack');
const { CudaService, startHttp } = require(path.join(source, 'server/mcp.cjs'));
const { imageLock, sha256 } = require(path.join(source, 'runtime/protocol.cjs'));

test(
  'signed installed CUDA runtime loads pinned dependencies outside node_modules and uses real HTTP MCP',
  { timeout: 60000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-installed-cuda-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    // Build an explicit standalone fixture, never the product release catalog.
    const bundleDirectory = path.join(directory, 'bundle');
    const legacyBundle = require('../fixtures/standalone-cuda.cjs').writeBundle(bundleDirectory, {
      // Transport-only fixture; no platform GPU qualification is implied.
      transportFixturePlatform: `${process.platform}-${process.arch}`,
    });
    const { createArchive, digest } = require('../../packages/pack-manager/src/index.cjs');
    const archive = createArchive(bundleDirectory);
    const catalog = JSON.stringify(
      signCatalog(
        {
          schemaVersion: 1,
          channel: 'beta',
          generatedAt: new Date().toISOString(),
          packs: [
            {
              domain: legacyBundle.domain,
              label: legacyBundle.label,
              emoji: legacyBundle.emoji,
              version: legacyBundle.version,
              sha256: digest(archive),
              size: archive.length,
              executionProfiles: legacyBundle.executionProfiles,
              runtimeAssets: [],
              url: 'cuda.hpack',
              platforms: [`${process.platform}-${process.arch}`],
            },
          ],
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
      bytes: archive,
      prepareRuntime: false,
    });
    assert.deepEqual(manager.scan().errors, []);
    const installed = manager.list()[0];
    const { loadRegistry, isDomainOffered } = require('../../packages/domain-skills/src/index.cjs');
    const legacyRegistry = loadRegistry({ INDUSTRIAL_HARNESS_PACK_STORE: manager.directory });
    assert.ok(legacyRegistry.domains.some(domain => domain.id === 'cuda'));
    assert.ok(legacyRegistry.skills.some(skill => skill.id === 'cuda.kernel.optimize'));
    assert.deepEqual(
      legacyRegistry.domains.filter(domain => isDomainOffered(domain.id)),
      [],
    );
    assert.equal(manager.list().length, 1, 'Withdrawal must not delete installed legacy bytes.');
    const {
      productResourceCatalog,
    } = require('../../apps/desktop/electron/product-resource-catalog.cjs');
    const { ResourceSettings } = require('../../packages/harness-core/src/resource-settings.cjs');
    const settings = new ResourceSettings(path.join(directory, 'resource-settings'));
    const legacyResources = { skills: legacyRegistry.skills, mcpServers: [] };
    settings.set(legacyResources, { kind: 'skill', id: 'cuda.kernel.optimize', mode: 'disabled' });
    const savedSettings = fs.readFileSync(settings.file, 'utf8');
    const productResources = productResourceCatalog(legacyResources);
    assert.ok(
      !settings.snapshot(productResources).catalog.skills.some(skill => skill.domain === 'cuda'),
    );
    assert.ok(
      settings
        .snapshot(legacyResources)
        .catalog.skills.some(skill => skill.id === 'cuda.kernel.optimize'),
    );
    assert.equal(
      fs.readFileSync(settings.file, 'utf8'),
      savedSettings,
      'Product filtering preserves saved legacy policy.',
    );

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
    const connectionRecords = new Map();
    const connectionStore = {
      available: () => true,
      read: key => connectionRecords.get(key),
      write: (key, value) => connectionRecords.set(key, value),
    };
    const connectionValues = Object.fromEntries(
      Object.entries(environment).filter(([key]) =>
        /^INDUSTRIAL_HARNESS_CUDA_(COMPILER|EVALUATOR)_MCP_/.test(key),
      ),
    );
    for (const key of Object.keys(connectionValues)) delete environment[key];
    const environments = new RuntimeEnvironmentManager({ manager, environment, connectionStore });
    const selectedProfile = installed.executionProfiles.find(
      profile => profile.connection?.kind === 'runtime-managed',
    );
    const configured = await environments.configureConnection('cuda', {
      profileId: selectedProfile.id,
      values: connectionValues,
    });
    assert.equal(JSON.stringify(configured).includes('compiler-token'), false);
    const associated = await environments.associate('cuda', {
      profileId: selectedProfile.id,
      projectDir: project,
    });
    assert.equal(associated.executable, true);
    assert.equal(associated.status, 'unchecked');
    const bundle = createProjectRuntime({
      projectDir: project,
      domain: 'cuda',
      directory: path.join(directory, 'state'),
      environment,
      connectionStore,
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
