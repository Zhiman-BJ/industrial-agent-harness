const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeEnvironmentManager, validateExecutionProfiles } = require('./index.cjs');
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'Editor.app'),
    executable = path.join(app, 'Contents', 'editor');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'vendor-binary', { mode: 0o755 });
  const asset = {
    id: 'editor',
    label: 'Editor',
    type: 'macos-app-zip',
    app: 'Editor.app',
    executable: 'Contents/editor',
    environment: 'EDITOR_COMMAND',
    versionText: '4.2',
    versionArgs: ['--version'],
    discoveryPaths: [app],
  };
  const native = {
    id: 'native-editor',
    label: 'Native',
    kind: 'native',
    qualified: true,
    platforms: ['darwin-arm64'],
    assetIds: ['editor'],
    toolIds: ['editor.verify'],
  };
  const bundle = {
    domain: 'drawing',
    version: '1.0.0',
    runtimeAssets: [asset],
    executionProfiles: [native],
  };
  let uses = 0,
    version = '4.2',
    ensure = 0;
  const manager = {
    directory,
    list: () => [bundle],
    withLock: fn => fn(),
    assertIdle: () => {
      if (uses) throw Error('Domain is in use.');
    },
    acquireUse: () => {
      uses++;
      return () => uses--;
    },
    runtimeAssets: {
      status: assets => assets.map(a => ({ id: a.id, ready: false })),
      environment: () => ({ EDITOR_COMMAND: '' }),
      ensure: async () => {
        ensure++;
      },
    },
  };
  const env = new RuntimeEnvironmentManager({
    manager,
    platform: 'darwin-arm64',
    command: async (file, args, options) => {
      options.signal?.throwIfAborted();
      return file.endsWith('codesign') ? '' : version;
    },
  });
  return {
    directory,
    app,
    executable,
    asset,
    bundle,
    manager,
    env,
    setVersion: v => (version = v),
    ensureCount: () => ensure,
  };
}
test('detect checks external app without downloading or associating; association injects exact executable and changes invalidate readiness', async t => {
  const f = setup(t);
  assert.equal(f.env.describe('drawing').status, 'unchecked');
  assert.equal((await f.env.detect('drawing', { profileId: 'native-editor' })).status, 'ready');
  assert.equal(f.env.describe('drawing').binding, null);
  assert.equal(f.ensureCount(), 0);
  const ready = await f.env.associate('drawing', { profileId: 'native-editor' });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.readyToolIds, ['editor.verify']);
  assert.equal(ready.environment.EDITOR_COMMAND, fs.realpathSync(f.executable));
  await f.env.detect('drawing', { profileId: 'native-editor' });
  assert.equal(
    f.env.describe('drawing').identity,
    ready.identity,
    'a read-only recheck does not change execution identity',
  );
  fs.appendFileSync(f.executable, 'changed');
  const changed = f.env.describe('drawing');
  assert.equal(changed.status, 'stale');
  assert.deepEqual(changed.readyToolIds, []);
  assert.equal(changed.environment.EDITOR_COMMAND, '');
  assert.notEqual(changed.identity, ready.identity);
});
test('wrong version, missing app, unsafe paths, cancellation and signature rejection cannot associate', async t => {
  const f = setup(t);
  f.setVersion('4.1');
  assert.equal(
    (await f.env.associate('drawing', { profileId: 'native-editor' })).status,
    'incompatible',
  );
  assert.equal(f.env.describe('drawing').binding, null);
  await assert.rejects(
    f.env.detect('drawing', { profileId: 'native-editor', paths: { other: f.app } }),
    /assets/,
  );
  const controller = new AbortController();
  controller.abort(Error('cancelled'));
  await assert.rejects(
    f.env.associate('drawing', { profileId: 'native-editor', signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(
    (
      await f.env.detect('drawing', {
        profileId: 'native-editor',
        paths: { editor: '/absent/editor.app' },
      })
    ).status,
    'missing',
  );
  f.env.command = async () => {
    throw Error('Bad signature');
  };
  assert.equal(
    (await f.env.detect('drawing', { profileId: 'native-editor' })).status,
    'incompatible',
  );
});
test('project binding overrides global binding, mutation requires idle, clear does not remove user software', async t => {
  const f = setup(t),
    project = path.join(f.directory, 'project');
  fs.mkdirSync(project);
  await f.env.associate('drawing', { profileId: 'native-editor', projectDir: project });
  assert.equal(f.env.describe('drawing').status, 'unchecked');
  assert.equal(f.env.describe('drawing', { projectDir: project }).status, 'ready');
  const release = f.env.acquireUse('drawing');
  assert.throws(() => f.env.clear('drawing', { projectDir: project }), /in use/);
  assert.equal(
    (await f.env.prepare('drawing', { profileId: 'native-editor' })).reasons[0].code,
    'DEPENDENCY_INSTALLATION_EXTERNAL',
  );
  release();
  f.env.clear('drawing', { projectDir: project });
  assert.ok(fs.existsSync(f.executable));
  assert.equal(f.env.describe('drawing', { projectDir: project }).status, 'unchecked');
});
test('unqualified, foreign platform and remote profiles remain unsupported without installing or fake readiness', async t => {
  const f = setup(t);
  f.bundle.executionProfiles[0].qualified = false;
  assert.equal(
    (await f.env.prepare('drawing', { profileId: 'native-editor' })).status,
    'unsupported',
  );
  f.bundle.executionProfiles[0].qualified = true;
  f.bundle.executionProfiles[0].kind = 'remote';
  assert.equal(
    (await f.env.detect('drawing', { profileId: 'native-editor' })).reasons[0].code,
    'REMOTE_SETTINGS_REQUIRED',
  );
  assert.equal(f.ensureCount(), 0);
  assert.throws(
    () =>
      validateExecutionProfiles(
        [{ ...f.bundle.executionProfiles[0], assetIds: ['unknown'] }],
        [f.asset],
      ),
    /Invalid/,
  );
});
test('product preparation refuses before locks or installation and preserves an existing binding', async t => {
  const f = setup(t);
  await f.env.associate('drawing', { profileId: 'native-editor' });
  const binding = f.env.describe('drawing').binding;
  f.manager.runtimeAssets.ensure = () => {
    throw Error('Unexpected dependency installation');
  };
  f.manager.withLock = () => {
    throw Error('Unexpected mutation lock');
  };
  const result = await f.env.prepare('drawing', { profileId: 'native-editor' });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reasons[0].code, 'DEPENDENCY_INSTALLATION_EXTERNAL');
  assert.deepEqual(f.env.describe('drawing').binding, binding);
  assert.equal(fs.existsSync(f.env.operationFile('drawing')), false);
  assert.equal(f.env.describe('drawing').profiles[0].assets[0].manageable, false);
});
test('multiple compatible installations require explicit selection and the injected version probe receives the chosen executable', async t => {
  const f = setup(t),
    second = path.join(f.directory, 'Other.app');
  fs.cpSync(f.app, second, { recursive: true });
  f.asset.discoveryPaths.push(second);
  const calls = [];
  f.env.versionProbe = async (asset, executable, options) => {
    calls.push({ asset: asset.id, executable, cwd: options.cwd });
    return '4.2';
  };
  const ambiguous = await f.env.associate('drawing', { profileId: 'native-editor' });
  assert.equal(ambiguous.status, 'unchecked');
  assert.equal(ambiguous.reasons[0].code, 'CHOOSE_APPLICATION');
  assert.equal(ambiguous.lastCheck.assets[0].candidates.length, 2);
  assert.equal(f.env.describe('drawing').binding, null);
  const selected = await f.env.associate('drawing', {
    profileId: 'native-editor',
    paths: { editor: second },
  });
  assert.equal(
    selected.environment.EDITOR_COMMAND,
    fs.realpathSync(path.join(second, 'Contents/editor')),
  );
  assert.equal(calls.at(-1).asset, 'editor');
  assert.ok(calls.at(-1).cwd.startsWith(os.tmpdir()));
});
test('container association checks the pinned managed image and exposes only that profile capabilities', async t => {
  const f = setup(t);
  const image = { id: 'drawing-image', type: 'docker-image', environment: 'DRAWING_IMAGE' };
  f.bundle.runtimeAssets.push(image);
  f.bundle.executionProfiles.push({
    id: 'drawing-container',
    label: 'Container',
    kind: 'container',
    qualified: true,
    platforms: ['darwin-arm64'],
    assetIds: [image.id],
    toolIds: ['drawing.render'],
  });
  f.manager.runtimeAssets.status = assets =>
    assets.map(a => ({
      id: a.id,
      ready: a.id === image.id,
      executables: { DRAWING_IMAGE: 'harbor.example/image@sha256:fixed' },
    }));
  const view = await f.env.associate('drawing', { profileId: 'drawing-container' });
  assert.equal(view.status, 'ready');
  assert.deepEqual(view.readyToolIds, ['drawing.render']);
  assert.equal(view.environment.EDITOR_COMMAND, '');
  assert.equal(view.environment.DRAWING_IMAGE, 'harbor.example/image@sha256:fixed');
  assert.equal(f.ensureCount(), 0);
});
test('declared platform probe is verified and consumed without falling back; changed component invalidates association', async t => {
  const f = setup(t),
    file = 'components/darwin-arm64/industrial-environment-probe';
  f.bundle.location = f.directory;
  const binary = path.join(f.directory, file),
    bytes = Buffer.from('platform-probe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, bytes, { mode: 0o755 });
  f.bundle.platformProbe = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    file,
    sha256: require('./index.cjs').digest(bytes),
    sizeBytes: bytes.length,
  };
  let used = 0;
  f.env.versionProbe = () => {
    throw Error('Fallback forbidden');
  };
  f.env.probeFactory = config => {
    assert.equal(config.sha256, f.bundle.platformProbe.sha256);
    return async () => {
      used++;
      return '4.2';
    };
  };
  const view = await f.env.associate('drawing', { profileId: 'native-editor' });
  assert.equal(view.status, 'ready');
  assert.equal(used, 1);
  assert.ok(view.binding.assets.editor.probeIdentity);
  fs.appendFileSync(binary, 'tampered');
  assert.equal(f.env.describe('drawing').status, 'stale');
  const failed = await f.env.associate('drawing', { profileId: 'native-editor' });
  assert.equal(failed.status, 'incompatible');
  assert.equal(used, 1);
});
test('runtime-managed paired connections preserve existing configuration without claiming service readiness or persisting secrets', async t => {
  const f = setup(t),
    variables = [
      { name: 'INDUSTRIAL_HARNESS_SERVICE_URL', type: 'endpoint' },
      { name: 'INDUSTRIAL_HARNESS_SERVICE_TOKEN', type: 'secret' },
      { name: 'INDUSTRIAL_HARNESS_SERVICE_IDENTITY', type: 'sha256' },
    ];
  f.bundle.executionProfiles = [
    {
      id: 'paired',
      label: 'Paired service',
      kind: 'remote',
      qualified: true,
      platforms: ['darwin-arm64'],
      assetIds: [],
      toolIds: ['service.check', 'service.execute'],
      connection: {
        kind: 'runtime-managed',
        verification: 'runtime-handshake',
        environment: variables,
      },
    },
  ];
  f.env.environment = {};
  assert.equal((await f.env.detect('drawing', { profileId: 'paired' })).status, 'missing');
  Object.assign(f.env.environment, {
    INDUSTRIAL_HARNESS_SERVICE_URL: 'https://service.example/mcp',
    INDUSTRIAL_HARNESS_SERVICE_TOKEN: 'private-secret-token',
    INDUSTRIAL_HARNESS_SERVICE_IDENTITY: 'a'.repeat(64),
  });
  const configured = f.env.describe('drawing');
  assert.equal(configured.status, 'unchecked');
  assert.equal(configured.executable, true);
  assert.deepEqual(configured.readyToolIds, []);
  assert.deepEqual(configured.executableToolIds, ['service.check', 'service.execute']);
  assert.equal(configured.binding.source, 'existing-settings');
  assert.equal(JSON.stringify(configured).includes('private-secret-token'), false);
  const oldPrivateIdentity = configured.configurationIdentity;
  f.env.environment.INDUSTRIAL_HARNESS_SERVICE_TOKEN = 'replacement-secret';
  const updated = f.env.describe('drawing');
  assert.equal(
    updated.identity,
    configured.identity,
    'canonical source identity excludes authorization secrets',
  );
  assert.notEqual(updated.configurationIdentity, oldPrivateIdentity);
  assert.equal(JSON.stringify(updated).includes('configurationIdentity'), false);
  const bound = await f.env.associate('drawing', { profileId: 'paired' });
  assert.equal(bound.status, 'unchecked');
  assert.equal(bound.executable, true);
  assert.equal(fs.readFileSync(f.env.file, 'utf8').includes('replacement-secret'), false);
  assert.equal((await f.env.prepare('drawing', { profileId: 'paired' })).status, 'unsupported');
  f.env.environment.INDUSTRIAL_HARNESS_SERVICE_URL = 'http://unsafe.example/mcp';
  assert.deepEqual(f.env.describe('drawing').executableToolIds, []);
});

test('secure connection store feeds execution without disclosing secrets and requires a secure adapter', async t => {
  const f = setup(t),
    name = 'INDUSTRIAL_HARNESS_SERVICE_TOKEN';
  f.bundle.executionProfiles = [
    {
      id: 'paired',
      label: 'Paired',
      kind: 'remote',
      qualified: true,
      platforms: ['darwin-arm64'],
      assetIds: [],
      toolIds: ['service.execute'],
      connection: {
        kind: 'runtime-managed',
        verification: 'runtime-handshake',
        environment: [{ name, type: 'secret' }],
      },
    },
  ];
  await assert.rejects(
    f.env.configureConnection('drawing', {
      profileId: 'paired',
      values: { [name]: 'secret-value' },
    }),
    /Secure connection storage/,
  );
  const records = new Map();
  f.env.connectionStore = {
    available: () => true,
    read: key => records.get(key),
    write: (key, value) => records.set(key, value),
  };
  const view = await f.env.configureConnection('drawing', {
    profileId: 'paired',
    values: { [name]: 'secret-value' },
  });
  assert.equal(view.executable, true);
  assert.equal(JSON.stringify(view).includes('secret-value'), false);
  assert.equal(
    f.env.describe('drawing').executable,
    false,
    'saving settings does not select a profile',
  );
  await f.env.associate('drawing', { profileId: 'paired' });
  assert.equal(f.env.describe('drawing').environment[name], 'secret-value');
  assert.equal(JSON.stringify(f.env.describe('drawing')).includes('secret-value'), false);
  await f.env.configureConnection('drawing', { profileId: 'paired', values: { [name]: '' } });
  assert.equal(f.env.describe('drawing').environment[name], 'secret-value');
  const release = f.env.acquireUse('drawing');
  await assert.rejects(
    f.env.configureConnection('drawing', { profileId: 'paired', values: { [name]: 'blocked' } }),
    /in use|active/i,
  );
  release();
  await f.env.configureConnection('drawing', { profileId: 'paired', values: { [name]: null } });
  assert.equal(f.env.connectionView('drawing', { profileId: 'paired' }).executable, false);
});

test('corrupt secure connection records are isolated, explicitly replaceable and resettable; unlink suppresses legacy migration', async t => {
  const f = setup(t),
    name = 'INDUSTRIAL_HARNESS_SERVICE_TOKEN';
  const native = f.bundle.executionProfiles[0];
  f.bundle.executionProfiles.push({
    id: 'paired',
    label: 'Paired',
    kind: 'remote',
    qualified: true,
    platforms: ['darwin-arm64'],
    assetIds: [],
    toolIds: ['remote.run'],
    connection: {
      kind: 'runtime-managed',
      verification: 'runtime-handshake',
      environment: [{ name, type: 'secret' }],
    },
  });
  let corrupt = true,
    record;
  f.env.environment = { [name]: 'legacy-secret' };
  f.env.connectionStore = {
    available: () => true,
    read: () => {
      if (corrupt) throw Error('sensitive error');
      return record;
    },
    write: (_, value) => {
      corrupt = false;
      record = value;
    },
    remove: () => {
      corrupt = false;
      record = null;
    },
  };
  const status = f.env.connectionView('drawing', { profileId: 'paired' });
  assert.equal(status.reasons[0].code, 'CONNECTION_STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(status).includes('sensitive'), false);
  assert.equal(f.env.describe('drawing').executable, false);
  await f.env.associate('drawing', { profileId: native.id });
  assert.equal(
    f.env.describe('drawing').status,
    'ready',
    'unrelated native profile remains usable',
  );
  await assert.rejects(
    f.env.configureConnection('drawing', {
      profileId: 'paired',
      values: { [name]: 'replacement' },
    }),
    /CONNECTION_STORAGE_UNAVAILABLE/,
  );
  await f.env.configureConnection('drawing', {
    profileId: 'paired',
    replace: true,
    values: { [name]: 'replacement' },
  });
  assert.equal(f.env.describe('drawing').binding.profileId, native.id);
  await f.env.associate('drawing', { profileId: 'paired' });
  f.env.clear('drawing');
  assert.equal(f.env.describe('drawing').binding.disabled, true);
  assert.equal(f.env.describe('drawing').executable, false);
  await f.env.resetConnection('drawing', { profileId: 'paired' });
  assert.equal(record, null);
  assert.equal(
    f.env.describe('drawing').executable,
    false,
    'legacy environment does not undo explicit unlink',
  );
});

test('native executable binds selected symlink target, fixed probe, and never invokes Docker or app signature checks', async t => {
  const f = setup(t);
  Object.assign(f.asset, {
    type: 'native-executable',
    probeId: 'version-short',
    versionText: 'tool 4.2',
  });
  delete f.asset.versionArgs;
  const selected = path.join(f.directory, 'tool');
  fs.symlinkSync(f.executable, selected);
  f.asset.discoveryPaths = [selected];
  const calls = [];
  f.env.versionProbe = undefined;
  f.env.versionProbe = (asset, executable, options) =>
    f.env.command(executable, require('./runtime-assets.cjs').probeArgs(asset), options);
  f.env.command = async (file, args) => {
    calls.push([file, args]);
    return 'tool 4.2';
  };
  const ready = await f.env.associate('drawing', { profileId: 'native-editor' });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(calls, [[fs.realpathSync(f.executable), ['-V']]]);
  assert.equal(ready.profiles[0].assets[0].selectionKind, 'file');
  assert.equal(ready.profiles[0].assets[0].manageable, false);
  const second = path.join(f.directory, 'second');
  fs.copyFileSync(f.executable, second);
  fs.chmodSync(second, 0o755);
  fs.unlinkSync(selected);
  fs.symlinkSync(second, selected);
  assert.equal(f.env.describe('drawing').status, 'stale');
  const binding = f.env.describe('drawing').binding;
  const missing = await f.env.prepare('drawing', { profileId: 'native-editor' });
  assert.equal(missing.reasons[0].code, 'DEPENDENCY_INSTALLATION_EXTERNAL');
  assert.deepEqual(f.env.describe('drawing').binding, binding);
  assert.equal(f.ensureCount(), 0);
});

test('native runtime directory binds library/data changes and version identity rejects the wrong tool', async t => {
  const f = setup(t);
  Object.assign(f.asset, {
    type: 'native-runtime-zip',
    probeId: 'version',
    versionText: 'tool 4.2',
  });
  delete f.asset.versionArgs;
  f.env.versionProbe = async () => 'other 4.2';
  assert.equal(
    (await f.env.detect('drawing', { profileId: 'native-editor' })).status,
    'incompatible',
  );
  f.env.versionProbe = async () => 'tool 4.2';
  assert.equal((await f.env.associate('drawing', { profileId: 'native-editor' })).status, 'ready');
  fs.writeFileSync(path.join(f.app, 'library.dat'), 'modified library');
  assert.equal(f.env.describe('drawing').status, 'stale');
});
