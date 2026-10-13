const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PackCatalog } = require('../../pack-manager/src/catalog.cjs');
const { loadRegistry } = require('../../domain-skills/src/index.cjs');

test('production PCB hpack dispatches every installed design tool through Project Runtime to the session backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-hpack-dispatch-'));
  // Windows releases child handles asynchronously; retry the teardown
  // instead of failing the test on a transient EPERM/EBUSY.
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const release = path.join(root, 'release');
  // The production publisher writes owner metadata and createArchive bytes.
  // JS probing is explicit here: this portable test qualifies packaging and
  // Runtime dispatch, not a Go probe, Docker image, or engineering verdict.
  execFileSync(
    process.execPath,
    [path.resolve(__dirname, '../../../scripts/build-pack-distribution.cjs'), release],
    {
      env: {
        ...process.env,
        HARNESS_PACK_DOMAINS: 'pcb',
        HARNESS_PACK_PLATFORMS: 'darwin-arm64',
        HARNESS_ALLOW_JS_ENVIRONMENT_PROBE: '1',
        HARNESS_PACK_SIGNING_KEY_FILE: '',
        HARNESS_RELEASE_BUILD: '',
        HARNESS_PLATFORM_PROBE_INDEX: '',
      },
      stdio: 'pipe',
    },
  );
  const catalog = new PackCatalog({
    directory: path.join(root, 'store'),
    platform: 'darwin-arm64',
    bundledDirectory: release,
  });
  const entries = await catalog.available();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].platforms, ['darwin-arm64']);
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    await catalog.manager.install(entries[0]);
  } else {
    await assert.rejects(catalog.manager.install(entries[0]), /does not support this platform/);
    // Same production archive bytes; only this unsigned packaging fixture omits
    // target filtering. Published metadata still rejects this host platform.
    const bytes = fs.readFileSync(path.join(release, path.basename(entries[0].url)));
    const { platforms, ...fixtureEntry } = entries[0];
    await catalog.manager.install(fixtureEntry, { allowUnsigned: true, bytes });
  }
  const scan = catalog.manager.scan();
  assert.deepEqual(scan.errors, []);
  const location = fs.realpathSync(scan.installed[0].location);
  const installed = path.join(location, 'domain-packs/pcb');
  assert.equal(fs.existsSync(path.join(location, 'lib')), false);
  assert.equal(fs.existsSync(path.join(location, 'domain-packs/lib')), false);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const environment = { ...process.env, INDUSTRIAL_HARNESS_PACK_STORE: catalog.manager.directory };
  const registry = loadRegistry(environment, { projectDir: project });
  const pack = registry.runtimePacks.find(item => item.domain === 'pcb');
  assert.equal(fs.realpathSync(pack.directory), installed);
  const tools = scan.installed[0].providerPacks
    .find(item => item.domain === 'pcb')
    .provider.tools.filter(tool => tool.id.startsWith('pcb.design.'))
    .map(tool => tool.id);
  assert.equal(tools.length, 88);
  // Qualification and process execution are fixture boundaries. All loading,
  // inventory checking, canonical actions and Pack dispatch below are real.
  pack.runtimeEnvironmentResolver = () => ({
    legacy: false,
    identity: 'a'.repeat(64),
    executableToolIds: tools,
    readyToolIds: tools,
    environment: {},
  });
  pack.validateRuntimeEnvironment = async () => {};
  const backend = require('../../domain-runtime/src/index.cjs');
  const calls = [];
  let starts = 0;
  t.mock.method(backend, 'openToolSession', async config => {
    starts++;
    assert.equal(config.runtime.kind, 'docker');
    assert.equal(config.expectedServerName, 'industrial-pcb-gateway');
    assert.equal(config.mounts[0].source, fs.realpathSync(project));
    assert.equal(config.mounts[1].source, path.join(installed, 'bridge/pcb-controller.py'));
    return {
      callTool: async (name, args) => {
        assert.equal(name, 'domain_tool_call');
        calls.push(args.toolId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ result: { packagingFixture: true } }) }],
        };
      },
      close: async () => {},
    };
  });
  // Capture the fixture backend when the real project factory is loaded.
  delete require.cache[require.resolve('../src/project-runtime.cjs')];
  const { createProjectRuntime } = require('../src/project-runtime.cjs');
  const view = createProjectRuntime({
    projectDir: project,
    domain: 'pcb',
    directory: path.join(root, 'state'),
    environment,
    registry,
  });
  t.after(() => view.runtime.close());
  let state = await view.runtime.inspect();
  for (const toolId of tools) {
    const result = await view.runtime.execute(
      { toolId, inputs: {}, expectedStateId: state.id },
      {
        approval: true,
        scope: { domain: 'pcb', projectId: state.projectId, stateId: state.id, tools: [toolId] },
      },
    );
    assert.equal(calls.at(-1), toolId, JSON.stringify(result.action));
    assert.notEqual(
      result.verification.status,
      'passed',
      'Fixture transport cannot establish engineering acceptance.',
    );
    state = result.state;
  }
  assert.deepEqual(calls, tools);
  assert.equal(starts, 1);
  assert.deepEqual(catalog.manager.scan().errors, []);
});
