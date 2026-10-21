const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { decodeArchive } = require('../../packages/pack-manager/src/index.cjs');
const { LOCK_PATH } = require('../../packages/pack-manager/src/container-images.cjs');

const script = path.resolve(__dirname, '../../scripts/build-pack-distribution.cjs');

function build(t, environment) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-distribution-native-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = path.join(root, 'qualification.pem');
  fs.writeFileSync(
    key,
    crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  const output = path.join(root, 'release');
  const result = spawnSync(process.execPath, [script, output], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INDUSTRIAL_HARNESS_PACK_STORE: '',
      HARNESS_PACK_DOMAINS: 'chip',
      HARNESS_PACK_PLATFORMS: 'darwin-arm64',
      HARNESS_PACK_CHANNEL: 'beta',
      HARNESS_PACK_SIGNING_KEY_FILE: key,
      HARNESS_PACK_SIGNING_KEY_ID: 'qualification',
      HARNESS_PACK_OMIT_CONTAINER_IMAGES: '1',
      ...environment,
    },
  });
  return { result, output };
}

test('qualification bundles can omit released container images while keeping the owner lock', t => {
  const { result, output } = build(t, {});
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /^chip: omitting released container images .+; the owner lock stays embedded\.$/m,
  );
  const catalog = JSON.parse(fs.readFileSync(path.join(output, 'catalog.json'), 'utf8')).payload;
  const entry = catalog.packs.find(pack => pack.domain === 'chip');
  assert.ok(entry, 'the chip bundle is still published');
  assert.equal(entry.containerDownloadSize, 0);
  const archive = decodeArchive(fs.readFileSync(path.join(output, path.basename(entry.url))));
  assert.deepEqual(archive.bundle.containerImages, []);
  assert.deepEqual(
    entry.pythonEnvironments,
    archive.bundle.pythonEnvironments,
    'catalog and authenticated archive bind the same Python resources',
  );
  const viewer = archive.bundle.pythonEnvironments.find(
    item => item.purpose === 'viewer' && item.viewer === 'layout',
  );
  assert.ok(viewer, 'the optional Viewer environment remains available without container images');
  assert.equal(viewer.version, '0.30.12');
  const platform = viewer.platforms['darwin-arm64'];
  assert.ok(
    entry.runtimeDownloadSize >=
      platform.interpreter.size + platform.wheels.reduce((sum, item) => sum + item.size, 0),
  );
  assert.ok(
    !archive.files.some(file => file.path.includes('.python-environments/')),
    'building a Pack preserves declarations without downloading Python or wheels',
  );
  const lock = archive.files.find(file => file.path === LOCK_PATH);
  assert.ok(lock, 'the owner distribution lock stays embedded');
  assert.ok(
    JSON.parse(lock.bytes.toString('utf8')).images.some(
      image => image.pack === 'chip' && image.current != null,
    ),
    'released chip images remain discoverable in the embedded lock',
  );
});

test('omitting container images is refused outside the qualification signing identity', t => {
  const { result, output } = build(t, { HARNESS_PACK_SIGNING_KEY_ID: 'release' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only valid for qualification builds/);
  assert.equal(fs.existsSync(output), false, 'the guard fails before any output is written');
});
