const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  prepareNativeApplication,
} = require('../../../tests/integration/fixtures/native-application.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-native-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packStore = path.join(root, 'product');
  fs.mkdirSync(packStore);
  fs.writeFileSync(path.join(packStore, 'preserved'), 'user record');
  const archive = path.join(root, 'official.dmg');
  fs.writeFileSync(archive, 'official archive fixture');
  const asset = {
    id: 'freecad',
    label: 'Fixture application',
    type: 'macos-app-dmg',
    platform: 'darwin-arm64',
    version: '1.0.0',
    url: 'https://never-request.invalid/app.dmg',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    size: fs.statSync(archive).size,
    installedSize: 4096,
    app: 'Fixture.app',
    executable: 'Contents/MacOS/tool',
    environment: 'INDUSTRIAL_HARNESS_NATIVE_FIXTURE',
    versionArgs: ['--version'],
    versionText: 'fixture 1.0.0',
  };
  const calls = [];
  const command = async (file, args) => {
    calls.push([file, args]);
    if (file === '/usr/bin/hdiutil' && args[0] === 'attach') {
      const app = path.join(args[args.indexOf('-mountpoint') + 1], asset.app);
      fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
      fs.writeFileSync(path.join(app, asset.executable), 'fixture executable', { mode: 0o755 });
    } else if (file === '/usr/bin/ditto') fs.cpSync(args[0], args[1], { recursive: true });
    return 'fixture 1.0.0';
  };
  return {
    root,
    asset,
    archive,
    packStore,
    calls,
    options: {
      asset,
      packStore,
      directory: path.join(root, 'external'),
      environment: { HARNESS_RUNTIME_ARCHIVES: JSON.stringify({ freecad: archive }) },
      defaultApplication: path.join(root, 'absent.app'),
      platform: 'darwin-arm64',
      command,
    },
  };
}
test('offline native prerequisite reuses maintained signature/version checks outside product store', async t => {
  const f = fixture(t);
  const previous = global.fetch;
  let network = 0;
  global.fetch = () => {
    network++;
    throw Error('Network forbidden');
  };
  t.after(() => {
    global.fetch = previous;
  });
  const app = await prepareNativeApplication(f.options);
  assert.ok(app.startsWith(fs.realpathSync(path.join(f.root, 'external')) + path.sep));
  assert.ok(f.calls.some(([file]) => file === '/usr/bin/codesign'));
  assert.ok(
    f.calls.some(
      ([file, args]) =>
        file.endsWith(path.join('Contents', 'MacOS', 'tool')) && args[0] === '--version',
    ),
  );
  assert.ok(f.calls.some(([file, args]) => file === '/usr/bin/hdiutil' && args[0] === 'detach'));
  assert.equal(network, 0);
  assert.deepEqual(fs.readdirSync(f.packStore), ['preserved']);
  assert.equal(fs.readFileSync(path.join(f.packStore, 'preserved'), 'utf8'), 'user record');
});
test('missing or tampered archives fail offline before extraction, and explicit applications take priority', async t => {
  const f = fixture(t);
  await assert.rejects(
    prepareNativeApplication({ ...f.options, environment: {} }),
    /downloads are disabled/,
  );
  await assert.rejects(
    prepareNativeApplication({
      ...f.options,
      environment: { HARNESS_FREECAD_ARCHIVE: path.join(f.root, 'missing.dmg') },
    }),
    /ENOENT/,
  );
  const tampered = Buffer.from(fs.readFileSync(f.archive));
  tampered[0] ^= 1;
  fs.writeFileSync(f.archive, tampered);
  await assert.rejects(prepareNativeApplication(f.options), /SHA-256 mismatch/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.options.directory), false);
  const app = path.join(f.root, 'existing.app');
  fs.mkdirSync(app);
  assert.equal(
    await prepareNativeApplication({
      ...f.options,
      environment: {
        HARNESS_FREECAD_APP_PATH: app,
        HARNESS_RUNTIME_ARCHIVES: 'invalid ignored JSON',
      },
    }),
    fs.realpathSync(app),
  );
  assert.equal(
    await prepareNativeApplication({ ...f.options, defaultApplication: app, environment: {} }),
    fs.realpathSync(app),
  );
  await assert.rejects(
    prepareNativeApplication({
      ...f.options,
      environment: { HARNESS_FREECAD_APP_PATH: f.packStore },
    }),
    /outside the product/,
  );
  await assert.rejects(
    prepareNativeApplication({
      ...f.options,
      environment: { HARNESS_FREECAD_APP_PATH: path.join(f.root, 'missing.app') },
    }),
    /ENOENT/,
  );
});
test('invalid extracted application fails signature validation without changing the product store', async t => {
  const f = fixture(t),
    original = f.options.command;
  await assert.rejects(
    prepareNativeApplication({
      ...f.options,
      command: async (file, args) => {
        if (file === '/usr/bin/codesign') throw Error('invalid signature');
        return original(file, args);
      },
    }),
    /invalid signature/,
  );
  assert.ok(f.calls.some(([file, args]) => file === '/usr/bin/hdiutil' && args[0] === 'detach'));
  assert.deepEqual(fs.globSync('**/receipt.json', { cwd: f.options.directory }), []);
  assert.deepEqual(fs.globSync('**/prepare.lock', { cwd: f.options.directory }), []);
  assert.deepEqual(fs.readdirSync(f.packStore), ['preserved']);
});

test('offline extracted application must also pass its declared version probe', async t => {
  const f = fixture(t),
    original = f.options.command;
  await assert.rejects(
    prepareNativeApplication({
      ...f.options,
      command: async (file, args) =>
        file.endsWith(path.join('Contents', 'MacOS', 'tool'))
          ? 'fixture 9.0.0'
          : original(file, args),
    }),
    /version/i,
  );
  assert.deepEqual(fs.globSync('**/receipt.json', { cwd: f.options.directory }), []);
  assert.deepEqual(fs.readdirSync(f.packStore), ['preserved']);
});
