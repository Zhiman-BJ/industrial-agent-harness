const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  PackManager,
  createArchive,
  digest,
  signCatalog,
} = require('@industrial-agent-harness/pack-manager');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const { runDomains } = require('../src/domains.cjs');
const { run } = require('../src/main.cjs');

test('CLI installs a signed new Domain, loads its Broker scope, then removes it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-domain-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = {
    store: process.env.INDUSTRIAL_HARNESS_PACK_STORE,
    config: process.env.INDUSTRIAL_HARNESS_CONFIG_DIR,
    fetch: global.fetch,
  };
  t.after(() => {
    if (previous.store === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = previous.store;
    if (previous.config === undefined) delete process.env.INDUSTRIAL_HARNESS_CONFIG_DIR;
    else process.env.INDUSTRIAL_HARNESS_CONFIG_DIR = previous.config;
    global.fetch = previous.fetch;
  });
  process.env.INDUSTRIAL_HARNESS_CONFIG_DIR = path.join(root, 'config');
  const source = path.join(root, 'source');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(source, 'skills', 'test-inspect'), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(source, 'skills', 'test-inspect', 'SKILL.md'), '# Inspect\n');
  fs.writeFileSync(
    path.join(source, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      domain: 'test',
      label: 'Test',
      emoji: '🧪',
      version: '1.0.0',
      coreApi: 1,
      capabilities: [
        {
          id: 'test.inspect',
          domain: 'test',
          stages: ['review'],
          keywords: ['inspect'],
          priority: 10,
          skills: [{ id: 'test.inspect', summary: 'Inspect', reference: 'Read.' }],
          tools: [],
          verification: [],
        },
      ],
      skills: [
        {
          id: 'test.inspect',
          domain: 'test',
          title: 'Inspect',
          file: 'skills/test-inspect/SKILL.md',
        },
      ],
      providerPacks: [],
    }),
  );
  const bytes = createArchive(source);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = path.join(root, 'keys.json');
  fs.writeFileSync(
    keys,
    JSON.stringify({ release: publicKey.export({ type: 'spki', format: 'pem' }) }),
  );
  const catalog = signCatalog(
    {
      schemaVersion: 1,
      channel: 'stable',
      packs: [
        {
          domain: 'test',
          version: '1.0.0',
          sha256: digest(bytes),
          size: bytes.length,
          url: 'test.hpack',
          platforms: [`${process.platform}-${process.arch}`],
        },
      ],
    },
    'release',
    privateKey,
  );
  global.fetch = async url =>
    new Response(url.endsWith('catalog.json') ? JSON.stringify(catalog) : bytes);
  const store = path.join(root, 'packs');
  const output = {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
  await runDomains(
    [
      'install',
      'test',
      '--catalog',
      'https://updates.example/catalog.json',
      '--keys-file',
      keys,
      '--store',
      store,
    ],
    output,
  );
  assert.match(output.text, /"installed":"test"/);
  output.text = '';
  await run(
    {
      command: 'run',
      projectDir: project,
      domain: 'test',
      task: 'inspect this project',
      scopeOnly: true,
    },
    output,
  );
  const scope = JSON.parse(output.text.split('\n')[0]);
  assert.deepEqual(scope.scope.capabilityIds, ['test.inspect']);
  const { InstallationJournal } = require('@industrial-agent-harness/pack-manager/src/catalog.cjs');
  const manager = new PackManager({ directory: store });
  const preparing = new InstallationJournal(manager);
  preparing.begin(['test']);
  await assert.rejects(
    runDomains(['remove', 'test', '--store', store], output),
    /already in progress/,
  );
  assert.equal(manager.list()[0].domain, 'test');
  assert.equal(preparing.snapshot().active, true);
  preparing.finish('cancelled');
  await runDomains(['remove', 'test', '--store', store], output);
  assert.equal(preparing.snapshot().operation, 'remove');
  assert.equal(preparing.snapshot().outcome, 'completed');
  output.text = '';
  await assert.rejects(
    run(
      { command: 'run', projectDir: project, domain: 'test', task: 'inspect', scopeOnly: true },
      output,
    ),
    /valid project domain/,
  );
});

test('portable registration installs Chip and PCB, then adds Godot; native preparation is qualified separately', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-real-packs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = {
    store: process.env.INDUSTRIAL_HARNESS_PACK_STORE,
    config: process.env.INDUSTRIAL_HARNESS_CONFIG_DIR,
    fetch: global.fetch,
  };
  t.after(() => {
    if (previous.store === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = previous.store;
    if (previous.config === undefined) delete process.env.INDUSTRIAL_HARNESS_CONFIG_DIR;
    else process.env.INDUSTRIAL_HARNESS_CONFIG_DIR = previous.config;
    global.fetch = previous.fetch;
  });
  process.env.INDUSTRIAL_HARNESS_CONFIG_DIR = path.join(root, 'config');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = path.join(root, 'keys.json');
  const signingKey = path.join(root, 'signing.pem');
  fs.writeFileSync(
    keys,
    JSON.stringify({ release: publicKey.export({ type: 'spki', format: 'pem' }) }),
  );
  fs.writeFileSync(signingKey, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const outputDir = path.join(root, 'feed');
  const built = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../../scripts/build-pack-distribution.cjs'), outputDir],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        INDUSTRIAL_HARNESS_PACK_STORE: '',
        HARNESS_PACK_CHANNEL: 'stable',
        HARNESS_PACK_SIGNING_KEY_FILE: signingKey,
        HARNESS_PACK_SIGNING_KEY_ID: 'release',
        HARNESS_PACK_PLATFORMS: `${process.platform}-${process.arch}`,
      },
    },
  );
  assert.equal(built.status, 0, built.stderr);
  global.fetch = async url =>
    new Response(fs.readFileSync(path.join(outputDir, path.basename(new URL(url).pathname))));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, 'catalog.json'))).payload;
    assert.ok(!catalog.packs.some(item => ['pcb', 'godot'].includes(item.domain)));
    assert.ok(catalog.packs.some(item => item.domain === 'chip'));
    return;
  }
  const store = path.join(root, 'packs');
  // This suite checks registration/scope on every OS. Native dependency
  // preparation and real task execution belong to the installed native gate.
  const manager = new PackManager({ directory: store, keys: JSON.parse(fs.readFileSync(keys)) });
  const catalog = await manager.catalog('https://updates.example/catalog.json');
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = store;
  const sink = {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
  for (const domain of ['chip', 'pcb'])
    await manager.install(
      catalog.packs.find(item => item.domain === domain),
      { prepareRuntime: false },
    );
  assert.deepEqual(
    loadRegistry().domains.map(item => item.id),
    ['chip', 'pcb'],
  );
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  for (const [domain, task, expected] of [
    ['chip', 'Inspect netlist signals', 'chip.rtl.netlist.inspect'],
    ['pcb', 'Inspect PCB board', 'pcb.native.task'],
  ]) {
    sink.text = '';
    await run({ command: 'run', projectDir: project, domain, task, scopeOnly: true }, sink);
    assert.equal(
      JSON.parse(sink.text.split('\n')[0]).scope.capabilityIds.includes(expected),
      false,
      'Pack-only installation must not disclose unprepared execution capabilities',
    );
  }
  await manager.install(
    catalog.packs.find(item => item.domain === 'godot'),
    { prepareRuntime: false },
  );
  for (const installed of manager.list().filter(item => ['pcb', 'godot'].includes(item.domain)))
    assert.ok(manager.runtimeAssets.status(installed.runtimeAssets).every(asset => !asset.ready));
  assert.deepEqual(
    loadRegistry().domains.map(item => item.id),
    ['chip', 'godot', 'pcb'],
  );
  sink.text = '';
  await run(
    {
      command: 'run',
      projectDir: project,
      domain: 'godot',
      task: 'Preview animation',
      scopeOnly: true,
    },
    sink,
  );
  assert.equal(JSON.parse(sink.text.split('\n')[0]).scope.domain, 'godot');
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    // Registration can be checked without preparing a multi-gigabyte native
    // dependency in the cross-platform unit suite. The mandatory installed native
    // and CAD installer gates exercise managed preparation and real native tasks.
    await manager.install(catalog.packs.find(item => item.domain === 'cad'));
    assert.equal(
      manager.runtimeAssets.status(
        manager.list().find(item => item.domain === 'cad').runtimeAssets,
      )[0].ready,
      false,
    );
    assert.deepEqual(
      loadRegistry().domains.map(item => item.id),
      ['cad', 'chip', 'godot', 'pcb'],
    );
    sink.text = '';
    await run(
      {
        command: 'run',
        projectDir: project,
        domain: 'cad',
        task: 'Operate AutoCAD drawing',
        scopeOnly: true,
      },
      sink,
    );
    assert.ok(
      JSON.parse(sink.text.split('\n')[0]).scope.capabilityIds.includes('cad.autocad.operate'),
    );
  }
});

test('a platform-only Pack is omitted from other platform catalogs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-platform-packs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'feed');
  const built = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../../scripts/build-pack-distribution.cjs'), output],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        INDUSTRIAL_HARNESS_PACK_STORE: '',
        HARNESS_PACK_PLATFORMS: 'linux-x64',
      },
    },
  );
  assert.equal(built.status, 0, built.stderr);
  const catalog = JSON.parse(fs.readFileSync(path.join(output, 'catalog.unsigned.json'), 'utf8'));
  // Chip has passed the real Linux signed installed runtime qualification.
  assert.deepEqual(catalog.packs.map(item => item.domain).sort(), ['chip']);
  assert.ok(catalog.packs.every(item => item.platforms.length > 0));
});
test('CLI environment commands share project bindings and never prepare software during detect or repair', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-environment-cli-'));
  const previous = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = previous;
  });
  const source = path.join(root, 'source'),
    store = path.join(root, 'store'),
    project = path.join(root, 'project');
  fs.mkdirSync(source);
  fs.mkdirSync(project);
  const profile = {
    id: 'cpu',
    label: 'CPU fixture',
    kind: 'native',
    platforms: [process.platform + '-' + process.arch],
    qualified: true,
    assetIds: [],
    toolIds: [],
  };
  fs.writeFileSync(
    path.join(source, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      coreApi: 1,
      domain: 'fixture',
      label: 'Fixture',
      emoji: 'F',
      version: '1.0.0',
      capabilities: [],
      skills: [],
      providerPacks: [],
      executionProfiles: [profile],
    }),
  );
  const bytes = createArchive(source),
    manager = new PackManager({ directory: store });
  await manager.install(
    { domain: 'fixture', version: '1.0.0', sha256: digest(bytes), size: bytes.length },
    { bytes, allowUnsigned: true },
  );
  const invoke = async args => {
    let text = '';
    const code = await runDomains([...args, '--store', store], { write: value => (text += value) });
    return { code, text };
  };
  let result = await invoke(['environments', 'fixture', '--project-dir', project]);
  assert.equal(JSON.parse(result.text).binding, null);
  result = await invoke(['detect', 'fixture', '--profile', 'cpu']);
  assert.match(result.text, /"status": "ready"/);
  result = await invoke(['associate', 'fixture', '--profile', 'cpu', '--project-dir', project]);
  assert.equal(JSON.parse(result.text.slice(result.text.indexOf('{\n'))).binding.profileId, 'cpu');
  result = await invoke(['repair', 'fixture', '--project-dir', project]);
  assert.match(result.text, /"profileId": "cpu"/);
  assert.equal(result.code, 0);
  result = await invoke(['prepare', 'fixture', '--profile', 'cpu', '--project-dir', project]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.text).reasons[0].code, 'DEPENDENCY_INSTALLATION_EXTERNAL');
  assert.equal(manager.list().length, 1);
  result = await invoke(['unbind', 'fixture', '--project-dir', project]);
  assert.equal(JSON.parse(result.text).binding, null);
  assert.equal(fs.existsSync(path.join(store, '.runtime-assets')), false);
});
test('CLI parses explicit profile and repeated app selections and rejects ambiguous options', () => {
  const { parse } = require('../src/domains.cjs');
  assert.deepEqual(
    parse([
      'associate',
      'design',
      '--profile',
      'native',
      '--path',
      'editor=/Applications/Editor.app',
      '--path',
      'cad=/Applications/CAD.app',
    ]).paths,
    { editor: '/Applications/Editor.app', cad: '/Applications/CAD.app' },
  );
  assert.throws(() => parse(['detect', 'design']), /profile/);
  assert.throws(
    () => parse(['associate', 'design', '--profile', 'native', '--path', 'editor=relative']),
    /absolute/,
  );
  assert.throws(
    () =>
      parse([
        'prepare',
        'design',
        '--profile',
        'native',
        '--path',
        'editor=/Applications/Editor.app',
      ]),
    /only valid/,
  );
  assert.throws(
    () =>
      parse([
        'associate',
        'design',
        '--profile',
        'native',
        '--path',
        'editor=/a',
        '--path',
        'editor=/b',
      ]),
    /Duplicate/,
  );
});

test('CLI ambiguous native candidates fail checks until explicitly associated; listing and unbind succeed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-candidates-'));
  const previous = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = previous;
  });
  const source = path.join(root, 'source'),
    store = path.join(root, 'store');
  fs.mkdirSync(source);
  const candidates = ['first', 'second'].map(name => {
    const file = path.join(root, name + (process.platform === 'win32' ? '.exe' : ''));
    if (process.platform === 'win32') fs.copyFileSync(process.execPath, file);
    else fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${process.version}'\n`);
    fs.chmodSync(file, 0o755);
    return file;
  });
  fs.writeFileSync(
    path.join(source, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      coreApi: 1,
      domain: 'fixture',
      label: 'Fixture',
      emoji: 'F',
      version: '1.0.0',
      capabilities: [],
      skills: [],
      providerPacks: [],
      runtimeAssets: [
        {
          id: 'cli',
          label: 'Fixture executable',
          type: 'native-executable',
          platform: 'darwin-arm64',
          version: process.version.slice(1),
          environment: 'INDUSTRIAL_HARNESS_CLI_CANDIDATE_TEST',
          probeId: 'version',
          versionText: process.version,
          discoveryPaths: candidates,
        },
      ],
      executionProfiles: [
        {
          id: 'native',
          label: 'Native fixture',
          kind: 'native',
          platforms: [`${process.platform}-${process.arch}`],
          qualified: true,
          assetIds: ['cli'],
          toolIds: [],
        },
      ],
    }),
  );
  const bytes = createArchive(source),
    manager = new PackManager({ directory: store });
  await manager.install(
    { domain: 'fixture', version: '1.0.0', sha256: digest(bytes), size: bytes.length },
    { bytes, allowUnsigned: true },
  );
  const invoke = async args => {
    let text = '';
    const code = await runDomains([...args, '--store', store], { write: value => (text += value) });
    return { code, result: JSON.parse(text.slice(text.indexOf('{\n'))) };
  };
  for (const command of ['detect', 'associate', 'repair']) {
    const checked = await invoke([command, 'fixture', '--profile', 'native']);
    assert.equal(checked.code, 1, command);
    assert.equal(checked.result.status, 'unchecked', command);
    const check = checked.result.lastCheck || checked.result;
    assert.equal(check.reasons[0].code, 'CHOOSE_APPLICATION');
    assert.equal(check.assets[0].candidates.filter(item => item.status === 'ready').length, 2);
  }
  let listed = await invoke(['environments', 'fixture']);
  assert.equal(listed.code, 0);
  assert.equal(listed.result.binding, null, 'Ambiguous checks do not select an application.');
  const associated = await invoke([
    'associate',
    'fixture',
    '--profile',
    'native',
    '--path',
    `cli=${candidates[0]}`,
  ]);
  assert.equal(associated.code, 0);
  assert.equal(
    fs.realpathSync(associated.result.binding.assets.cli.appPath),
    fs.realpathSync(candidates[0]),
  );
  assert.equal(
    (await invoke(['repair', 'fixture'])).code,
    0,
    'Repair checks the explicitly saved path.',
  );
  const unbound = await invoke(['unbind', 'fixture']);
  assert.equal(unbound.code, 0);
  assert.equal(unbound.result.binding.disabled, true);
  assert.equal(fs.existsSync(candidates[0]), true, 'Unbinding preserves external software.');
  listed = await invoke(['environments', 'fixture']);
  assert.equal(listed.code, 0);
});
