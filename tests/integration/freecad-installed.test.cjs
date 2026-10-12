const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createProjectRuntime } = require('../../packages/harness-core/src/project-runtime.cjs');
const {
  PackManager,
  decodeArchive,
  RuntimeEnvironmentManager,
} = require('../../packages/pack-manager/src/index.cjs');
const { prepareNativeApplication } = require('./fixtures/native-application.cjs');
const { call, plate } = require('./fixtures/freecad.cjs');
const execute = promisify(execFile);
const repo = path.resolve(__dirname, '../..');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('Installed CAD qualification requires macOS Apple Silicon; tests cannot be skipped.');

test(
  'signed installed CAD Pack keeps its inventory intact and restores persisted acceptance after reopening',
  { timeout: 600000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-cad-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const key = path.join(directory, 'key.pem');
    fs.writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const output = path.join(directory, 'release');
    await execute(
      process.execPath,
      [path.join(repo, 'scripts/build-pack-distribution.cjs'), output],
      {
        cwd: repo,
        env: {
          ...process.env,
          HARNESS_PACK_DOMAINS: 'cad',
          HARNESS_PACK_SIGNING_KEY_FILE: key,
          HARNESS_PACK_SIGNING_KEY_ID: 'qualification',
          HARNESS_PACK_CHANNEL: 'beta',
        },
      },
    );
    const manager = new PackManager({
      directory: path.join(directory, 'installed'),
      keys: { qualification: publicKey.export({ type: 'spki', format: 'pem' }) },
      channel: 'beta',
    });
    const fetch = global.fetch;
    global.fetch = async () => new Response(fs.readFileSync(path.join(output, 'catalog.json')));
    let entry;
    try {
      entry = (await manager.catalog('https://qualification.example/catalog.json')).packs[0];
    } finally {
      global.fetch = fetch;
    }
    const bytes = fs.readFileSync(path.join(output, path.basename(entry.url)));
    const { bundle: declaredBundle } = decodeArchive(bytes);
    const appPath = await prepareNativeApplication({
      asset: declaredBundle.runtimeAssets.find(asset => asset.id === 'freecad'),
      packStore: manager.directory,
      directory: path.join(directory, 'external-applications'),
    });
    await manager.install(entry, { bytes });
    const selectedBundle = manager.list()[0];
    const selectedProfile = selectedBundle.executionProfiles.find(
      profile => profile.kind === 'native' && profile.assetIds.includes('freecad'),
    );
    assert.ok(selectedProfile);
    const associated = await new RuntimeEnvironmentManager({ manager }).associate(
      selectedBundle.domain,
      {
        profileId: selectedProfile.id,
        paths: { freecad: appPath },
      },
    );
    assert.equal(associated.status, 'ready', JSON.stringify(associated));
    const prior = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    process.env.INDUSTRIAL_HARNESS_PACK_STORE = manager.directory;
    t.after(() => {
      if (prior === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
      else process.env.INDUSTRIAL_HARNESS_PACK_STORE = prior;
    });
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const open = () => createProjectRuntime({ projectDir: project, domain: 'cad' }).runtime;
    let runtime = open();
    t.after(() => runtime?.close());
    const out = await call(runtime, 'build', {
      recipe: plate,
      expect: { solids: 1, volume: 4000 - 20 * Math.PI },
    });
    assert.equal(out.verification.status, 'passed', JSON.stringify(out.action));
    runtime.close();
    runtime = null;
    assert.deepEqual(manager.scan().errors, []);
    runtime = open();
    assert.equal((await runtime.inspect()).id, out.state.id);
    assert.equal(runtime.latestCheckpoint().id, out.checkpoint.id);
    assert.equal(runtime.listVerifications()[0].status, 'passed');
    assert.deepEqual(manager.scan().errors, []);
  },
);
