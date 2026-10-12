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
  RuntimeEnvironmentManager,
} = require('../../packages/pack-manager/src/index.cjs');
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
    if (process.env.HARNESS_FREECAD_ARCHIVE) {
      const asset = require('../../packages/domain-skills/src/packs.cjs')
        .loadDomainPacks()
        .find(pack => pack.id === 'freecad-pack').runtimeAssets[0];
      const cache = path.join(manager.runtimeAssets.directory, 'cache');
      fs.mkdirSync(cache, { recursive: true });
      fs.copyFileSync(process.env.HARNESS_FREECAD_ARCHIVE, path.join(cache, asset.sha256 + '.dmg'));
    }
    await manager.install(entry, {
      bytes: fs.readFileSync(path.join(output, path.basename(entry.url))),
      prepareRuntime: true,
      onProgress: progress =>
        console.log(
          'CAD runtime preparation: ' +
            JSON.stringify({
              at: new Date().toISOString(),
              id: progress.id,
              phase: progress.phase,
            }),
        ),
    });
    const selectedBundle = manager.list()[0];
    await new RuntimeEnvironmentManager({ manager }).associate(selectedBundle.domain, {
      profileId: selectedBundle.executionProfiles.find(profile => profile.kind === 'native').id,
    });
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
