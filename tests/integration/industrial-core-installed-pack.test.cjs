const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  PackManager,
  RuntimeEnvironmentManager,
  createArchive,
  digest,
  signCatalog,
} = require('../../packages/pack-manager/src/index.cjs');
const { createProjectRuntime } = require('../../packages/harness-core/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');

test(
  'a signed installed Chip Pack executes real Verilator without changing its verified inventory, then factory restart restores acceptance',
  { timeout: 20 * 60 * 1000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-installed-chip-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(directory, 'release-key.pem');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const output = path.join(directory, 'release');
    await execute(
      process.execPath,
      [path.join(root, 'scripts/build-pack-distribution.cjs'), output],
      {
        cwd: root,
        env: {
          ...process.env,
          HARNESS_PACK_DOMAINS: 'chip',
          HARNESS_PACK_SIGNING_KEY_FILE: keyFile,
          HARNESS_PACK_SIGNING_KEY_ID: 'qualification',
          HARNESS_PACK_CHANNEL: 'beta',
        },
        timeout: 30000,
      },
    );
    const catalog = fs.readFileSync(path.join(output, 'catalog.json'));
    const manager = new PackManager({
      directory: path.join(directory, 'installed'),
      keys: { qualification: publicKey.export({ type: 'spki', format: 'pem' }) },
      channel: 'beta',
    });
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(catalog);
    t.after(() => {
      global.fetch = originalFetch;
    });
    const selected = (await manager.catalog('https://qualification.example/catalog.json')).packs[0];
    global.fetch = originalFetch;
    await manager.install(selected, {
      bytes: fs.readFileSync(path.join(output, path.basename(selected.url))),
      prepareRuntime: false,
    });
    const selectedBundle = manager.list()[0];
    const prepared = await new RuntimeEnvironmentManager({ manager }).prepare(
      selectedBundle.domain,
      {
        profileId: selectedBundle.executionProfiles.find(profile => profile.kind === 'container')
          .id,
      },
    );
    if (prepared.reasons?.some(reason => reason.code === 'DOCKER_UNAVAILABLE')) {
      // PD-075: without an installed Docker CLI and daemon, preparation must
      // refuse explicitly instead of half-preparing. The full Verilator path
      // runs on the Docker-equipped native lane.
      assert.equal(prepared.status, 'unsupported');
      return;
    }
    const installed = manager.scan();
    assert.deepEqual(installed.errors, []);
    assert.equal(installed.installed.length, 1);
    const location = installed.installed[0].location;
    assert.ok(fs.existsSync(path.join(location, 'domain-packs/chip/eda-harness/LICENSE')));
    assert.ok(!fs.existsSync(path.join(location, 'domain-packs/chip/eda-harness/.venv')));
    const originalStore = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    process.env.INDUSTRIAL_HARNESS_PACK_STORE = manager.directory;
    t.after(() => {
      if (originalStore === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
      else process.env.INDUSTRIAL_HARNESS_PACK_STORE = originalStore;
    });
    const project = path.join(directory, 'project');
    fs.cpSync(path.join(__dirname, 'fixtures/industrial-rtl'), project, { recursive: true });
    const environment = { ...process.env };
    delete environment.INDUSTRIAL_HARNESS_EDA_PYTHON;
    const open = () =>
      createProjectRuntime({
        projectDir: project,
        domain: 'chip',
        directory: path.join(directory, 'state'),
        environment,
      });
    let bundle = open();
    t.after(() => bundle?.runtime.close());
    assert.ok(bundle.protectedPaths.some(file => file.startsWith(fs.realpathSync(location))));
    const state = await bundle.runtime.inspect();
    const scope = resolveFromState(
      { task: 'Run RTL simulation assertions', state },
      bundle.capabilities,
    ).scope;
    const result = await bundle.runtime.execute(
      { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
      { scope, approval: true },
    );
    assert.equal(result.verification.status, 'passed', JSON.stringify(result.action));
    const nativeReport = result.artifacts.find(
      artifact => artifact.kind === 'report.eda.execution',
    );
    assert.ok(nativeReport, 'Managed execution must retain its native EDA report.');
    const native = JSON.parse(bundle.runtime.readArtifact(nativeReport.id).content);
    const verilator = native.toolIdentities['rtl.simulate'];
    assert.match(verilator.version, /Verilator/);
    assert.match(verilator.binary, /\/verilator$/);
    assert.match(verilator.sha256, /^[a-f0-9]{64}$/);
    bundle.runtime.close();
    bundle = null;
    assert.deepEqual(manager.scan().errors, []);
    assert.equal(manager.scan().installed.length, 1);
    function walk(directory) {
      return fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap(item =>
          item.isDirectory() ? [item.name, ...walk(path.join(directory, item.name))] : [item.name],
        );
    }
    assert.ok(!walk(location).some(name => name === '__pycache__' || name.endsWith('.pyc')));
    bundle = open();
    assert.equal((await bundle.runtime.inspect()).id, result.state.id);
    assert.equal(bundle.runtime.latestCheckpoint().id, result.checkpoint.id);
    assert.equal(bundle.runtime.listVerifications()[0].status, 'passed');
    assert.deepEqual(manager.scan().errors, []);
    bundle.runtime.close();
    bundle = null;
    // Exercise actual signed same-version repair, including an internal helper
    // that has already been required. Only plugin code is reloaded, and altered
    // StateProvider facts invalidate the earlier current acceptance.
    const sourceDirectory = path.join(output, 'chip');
    const runtimeDirectory = path.join(sourceDirectory, 'domain-packs/chip/runtime');
    fs.appendFileSync(
      path.join(runtimeDirectory, 'index.cjs'),
      '\nconst baseCreate = module.exports.createRuntimePlugin;\nmodule.exports.createRuntimePlugin = options => { const plugin = baseCreate(options); const inspect = plugin.stateProvider; plugin.stateProvider = async request => ({ ...await inspect(request), stage: require("./revision.cjs").stage }); return plugin; };\n',
    );
    const coreCacheKey = require.resolve('../../packages/domain-runtime/src/industrial.cjs');
    const coreCache = require.cache[coreCacheKey];
    for (const stage of ['rtl-repaired-1', 'rtl-repaired-2']) {
      fs.writeFileSync(
        path.join(runtimeDirectory, 'revision.cjs'),
        `module.exports = { stage: ${JSON.stringify(stage)} };\n`,
      );
      const bundleFile = path.join(sourceDirectory, 'bundle.json');
      const repairedBundle = JSON.parse(fs.readFileSync(bundleFile));
      const repairedPack = repairedBundle.providerPacks.find(pack => pack.id === 'chip-pack');
      const packDirectory = path.join(sourceDirectory, 'domain-packs/chip');
      const resourceFiles = [];
      const inventory = relative => {
        const file = path.join(packDirectory, relative);
        if (fs.statSync(file).isDirectory()) {
          for (const name of fs.readdirSync(file).sort()) inventory(relative + '/' + name);
        } else resourceFiles.push(relative);
      };
      repairedPack.provider.resourceRoots.forEach(inventory);
      repairedPack.provider.sourceFiles = Object.fromEntries(
        resourceFiles
          .sort()
          .map(relative => [relative, digest(fs.readFileSync(path.join(packDirectory, relative)))]),
      );
      repairedPack.provider.sourceSha256 = digest(
        Buffer.from(JSON.stringify(repairedPack.provider.sourceFiles)),
      );
      fs.writeFileSync(
        path.join(packDirectory, 'harness-pack.json'),
        JSON.stringify(repairedPack, null, 2) + '\n',
      );
      fs.writeFileSync(bundleFile, JSON.stringify(repairedBundle, null, 2) + '\n');
      const archive = createArchive(sourceDirectory);
      const originalPayload = JSON.parse(catalog.toString()).payload;
      const repaired = signCatalog(
        {
          ...originalPayload,
          packs: [{ ...originalPayload.packs[0], sha256: digest(archive), size: archive.length }],
        },
        'qualification',
        privateKey,
      );
      global.fetch = async () => new Response(JSON.stringify(repaired));
      const repair = (await manager.catalog('https://qualification.example/catalog.json')).packs[0];
      await manager.install(repair, { bytes: archive, prepareRuntime: false });
      assert.deepEqual(manager.scan().errors, []);
      bundle = open();
      const current = await bundle.runtime.inspect();
      assert.equal(current.stage, stage);
      assert.equal(current.status, 'stale');
      assert.equal(require.cache[coreCacheKey], coreCache);
      bundle.runtime.close();
      bundle = null;
    }
  },
);
