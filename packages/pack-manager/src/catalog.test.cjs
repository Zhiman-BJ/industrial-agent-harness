const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PackManager, createArchive, digest, signCatalog } = require('./index.cjs');
const { PackCatalog, describeInstalled, InstallationJournal } = require('./catalog.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installation-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      domain: 'review',
      version: '1.0.0',
      coreApi: 1,
      label: 'Review',
      emoji: 'R',
      capabilities: [],
      skills: [],
      providerPacks: [],
    }),
  );
  const bytes = createArchive(source);
  const bundledDirectory = path.join(root, 'bundled');
  fs.mkdirSync(bundledDirectory);
  fs.writeFileSync(path.join(bundledDirectory, 'review.hpack'), bytes);
  const entry = {
    domain: 'review',
    version: '1.0.0',
    size: bytes.length,
    sha256: digest(bytes),
    url: 'review.hpack',
    platforms: [`${process.platform}-${process.arch}`],
  };
  fs.writeFileSync(
    path.join(bundledDirectory, 'catalog.unsigned.json'),
    JSON.stringify({ schemaVersion: 1, packs: [entry] }),
  );
  return { root, bytes, entry, bundledDirectory, directory: path.join(root, 'store') };
}

test('unconfigured catalogs retain installable bundled entries and accurately distinguish installed from executable', async t => {
  const setup = fixture(t);
  const catalog = new PackCatalog(setup);
  const entries = await catalog.available();
  assert.equal(catalog.snapshot().state, 'unconfigured');
  assert.equal(catalog.snapshot().bundledDomains, 1);
  assert.equal(catalog.summaries(entries)[0].updateAvailable, false);
  await catalog.manager.install(entries[0]);
  const summary = describeInstalled(catalog.manager, catalog.manager.list()[0]);
  assert.equal(summary.runtimeState, 'installed');
  assert.equal(
    describeInstalled(catalog.manager, {
      ...catalog.manager.list()[0],
      prerequisites: ['External compiler'],
    }).runtimeState,
    'external-dependencies',
  );
  await assert.rejects(catalog.manager.install({ ...entries[0] }), /verified catalog/);
});

test('bad feed signatures preserve the bundled install path; newer incompatible feeds cannot hide a compatible bundled pack', async t => {
  const setup = fixture(t);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = { release: publicKey.export({ type: 'spki', format: 'pem' }) };
  const catalog = new PackCatalog({ ...setup, url: 'https://updates.example/catalog.json', keys });
  const previous = global.fetch;
  t.after(() => {
    global.fetch = previous;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({ schemaVersion: 1, keyId: 'release', payload: {}, signature: 'bad' }),
    );
  let entries = await catalog.available();
  assert.equal(catalog.snapshot().state, 'unavailable');
  assert.match(catalog.snapshot().message, /signature/);
  await catalog.manager.install(entries[0]);
  const payload = {
    schemaVersion: 1,
    channel: 'beta',
    packs: [{ ...setup.entry, version: '2.0.0', platforms: ['unqualified-platform'] }],
  };
  global.fetch = async () =>
    new Response(JSON.stringify(signCatalog(payload, 'release', privateKey)));
  entries = await catalog.available();
  assert.equal(catalog.snapshot().state, 'connected');
  assert.equal(entries[0].version, '1.0.0');
  assert.equal(catalog.summaries(entries)[0].updateAvailable, false);
  payload.packs[0].platforms = setup.entry.platforms;
  entries = await catalog.available();
  assert.equal(entries[0].version, '2.0.0');
  assert.equal(catalog.summaries(entries)[0].updateAvailable, true);
});

test('catalog cancellation is never converted into a successful fallback', async t => {
  const setup = fixture(t);
  const catalog = new PackCatalog({ ...setup, url: 'https://updates.example/catalog.json' });
  const controller = new AbortController();
  controller.abort(Error('Cancelled by user'));
  await assert.rejects(catalog.available({ signal: controller.signal }), /Cancelled by user/);
});

test('every declared domain remains visible with its actual distribution constraint', async t => {
  const setup = fixture(t);
  const catalog = new PackCatalog({
    ...setup,
    declaredDomains: [
      { id: 'review', label: 'Review' },
      {
        id: 'remote',
        label: 'Remote',
        qualifiedBundlePlatforms: [],
        prerequisites: ['Configured remote services'],
      },
      { id: 'other-platform', label: 'Other', qualifiedBundlePlatforms: ['other-os'] },
      { id: 'online', label: 'Online' },
    ],
  });
  const entries = await catalog.available();
  assert.deepEqual(
    entries.map(item => item.domain),
    ['review'],
  );
  assert.deepEqual(
    catalog.snapshot().unavailableDomains.map(item => [item.domain, item.reason]),
    [
      ['remote', 'not-distributed'],
      ['other-platform', 'platform-unsupported'],
      ['online', 'catalog-unavailable'],
    ],
  );
  assert.deepEqual(catalog.snapshot().unavailableDomains[0].prerequisites, [
    'Configured remote services',
  ]);
  await catalog.manager.install(entries[0]);
  await catalog.available();
  assert.ok(!catalog.snapshot().unavailableDomains.some(item => item.domain === 'review'));
});

test('installation journal detects a real exited owner, serializes adapters and retains failure and cancellation outcomes', t => {
  const setup = fixture(t);
  const manager = new PackManager({ directory: setup.directory });
  const journal = new InstallationJournal(manager);
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `const {PackManager}=require(${JSON.stringify(require.resolve('./index.cjs'))});const {InstallationJournal}=require(${JSON.stringify(require.resolve('./catalog.cjs'))});new InstallationJournal(new PackManager({directory:process.argv[1]})).begin(['review']);`,
      setup.directory,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(journal.snapshot().outcome, 'interrupted');
  journal.begin(['review']);
  const other = new InstallationJournal(manager);
  assert.throws(() => other.begin(['review']), /already in progress/);
  journal.progress({ phase: 'copying', label: 'Review' });
  assert.equal(other.snapshot().progress.phase, 'copying');
  journal.finish('cancelled', Error('Cancelled by user'));
  assert.equal(other.snapshot().outcome, 'cancelled');
  other.begin(['review']);
  journal.finish('completed'); // stale owner cannot replace the active receipt
  assert.equal(other.snapshot().active, true);
  other.finish('failed', Error('Archive digest mismatch'));
  const restarted = new InstallationJournal(manager);
  assert.equal(restarted.snapshot().outcome, 'failed');
  assert.match(restarted.snapshot().error, /digest mismatch/);
  assert.deepEqual(manager.list(), []);
});

test('a full disk cannot leave a finished operation permanently active or leak journal temporary files', t => {
  const setup = fixture(t);
  const manager = new PackManager({ directory: setup.directory });
  const journal = new InstallationJournal(manager);
  journal.begin(['review']);
  const write = fs.writeFileSync;
  const patched = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(journal.file + '.') && file.endsWith('.tmp')) {
      write(file, '');
      throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    }
    return write(file, ...args);
  });
  journal.finish('failed', Error('Original preparation error'));
  assert.equal(journal.snapshot().active, false);
  assert.equal(journal.snapshot().error, 'Original preparation error');
  assert.match(journal.snapshot().statusWarning, /status could not be saved/);
  assert.equal(new InstallationJournal(manager).snapshot(), null);
  assert.ok(!fs.readdirSync(setup.directory).some(file => file.endsWith('.tmp')));
  patched.mock.restore();
  const retried = new InstallationJournal(manager);
  retried.begin(['review']);
  retried.finish('completed');
  assert.equal(journal.snapshot().outcome, 'completed');
});
test('catalog installation estimates include only the Pack and disclose software totals as optional', t => {
  const f = fixture(t),
    catalog = new PackCatalog(f);
  const entry = { ...f.entry, runtimeDownloadSize: 1400000000, runtimeInstalledSize: 4000000000 };
  const summary = catalog.summaries([entry])[0];
  assert.equal(summary.runtimeDownloadSize, entry.runtimeDownloadSize);
  assert.equal(summary.installation.downloadBytes, entry.size);
  assert.ok(summary.installation.installedBytes < 1000000);
});
