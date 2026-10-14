const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLocalhostCertificate } = require('./localhost-tls.cjs');
const { readDistributionLock, resolveImageAsset } = require('./container-images.cjs');

const configDigest = 'sha256:' + 'b'.repeat(64);

function lockFixture() {
  return {
    schemaVersion: 1,
    registry: 'ghcr.io',
    imageNamespace: 'zhiman-bj',
    releaseAssetUrlTemplate: 'https://github.com/example/example/releases/download/{tag}/{archive}',
    registryManifestUrlTemplate: 'https://ghcr.io/v2/{namespace}/{repository}/manifests/{digest}',
    images: [
      {
        id: 'industrial-chip-tools',
        repository: 'industrial-chip-tools',
        recipe: 'packs/chip/eda-harness/Dockerfile.tools',
        context: 'packs/chip/eda-harness',
        platform: 'linux/amd64',
        tagPattern: 'chip-v*',
        current: {
          tag: 'chip-v0.1.0',
          imageDigest: 'sha256:' + 'a'.repeat(64),
          configDigest,
          ociArchive: 'industrial-chip-tools-chip-v0.1.0.tar',
          ociArchiveSha256: '0'.repeat(64),
          ociArchiveBytes: 4096,
          releasedAt: '2026-10-14T10:57:00Z',
        },
      },
      {
        id: 'industrial-pcb-runtime',
        repository: 'industrial-pcb-runtime',
        recipe: 'packs/pcb/Dockerfile.local-dev',
        context: 'packs/pcb',
        platform: 'linux/amd64',
        tagPattern: 'pcb-v*',
        current: null,
      },
    ],
  };
}

test('the distribution lock resolves by id, repository, tagged and registry-prefixed references', () => {
  const found = { lock: lockFixture() };
  const expectedUrl =
    'https://github.com/example/example/releases/download/chip-v0.1.0/industrial-chip-tools-chip-v0.1.0.tar';
  for (const reference of [
    'industrial-chip-tools',
    'industrial-chip-tools:chip-v0.1.0',
    'ghcr.io/zhiman-bj/industrial-chip-tools:chip-v0.1.0',
  ]) {
    const asset = resolveImageAsset(found, reference);
    assert.equal(asset.released, true);
    assert.equal(asset.imageRef, 'industrial-chip-tools:chip-v0.1.0');
    assert.equal(asset.url, expectedUrl);
    assert.equal(asset.configDigest, configDigest);
    assert.equal(asset.bytes, 4096);
  }
  assert.equal(resolveImageAsset(found, 'unknown-image'), null);
  const unreleased = resolveImageAsset(found, 'industrial-pcb-runtime');
  assert.equal(unreleased.released, false);
  assert.equal(resolveImageAsset({ lock: { images: [] } }, 'anything'), null);
});

test('the lock is discovered above the pack directory and absent trees return null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'container-images-'));
  const packDirectory = path.join(root, 'packs', 'chip');
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.mkdirSync(path.join(root, 'provenance'));
  fs.writeFileSync(
    path.join(root, 'provenance', 'runtime-distribution.json'),
    JSON.stringify(lockFixture()),
  );
  const found = readDistributionLock(packDirectory);
  assert.equal(found.lock.images.length, 2);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'container-images-empty-'));
  assert.equal(readDistributionLock(empty), null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

async function releaseFixture() {
  const tls = createLocalhostCertificate();
  const payload = crypto.randomBytes(4096);
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    if (req.url.endsWith('.tar')) {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(payload);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const port = await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  return { server, port, payload, sha256, cert: tls.cert };
}

// The in-process fetch validates TLS; the acquisition runs in a child that
// trusts the fixture certificate, mirroring the transfer-bearer suite.
function childAcquire(directory, { lockFile, dockerDirectory, image }) {
  const script = path.join(directory, 'acquire.cjs');
  fs.writeFileSync(
    script,
    `const { acquireImage } = require(${JSON.stringify(
      path.resolve(__dirname, 'container-images.cjs'),
    )});
     acquireImage({
       packDirectory: ${JSON.stringify(path.dirname(path.dirname(lockFile)))},
       image: ${JSON.stringify(image)},
       environment: { ...process.env, PATH: ${JSON.stringify(dockerDirectory)} + ':' + process.env.PATH },
     })
       .then(result => { console.log(JSON.stringify(result)); })
       .catch(error => { console.error(error.message); process.exit(1); });`,
  );
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(directory, 'localhost-cert.pem') },
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });
}

function dockerShim(directory, configDigestValue, loadedRef) {
  fs.mkdirSync(directory, { recursive: true });
  const docker = path.join(directory, 'docker');
  fs.writeFileSync(
    docker,
    `#!/bin/sh
     case "$1" in
       load) echo "Loaded image: ${loadedRef}" ;;
       image) echo "${configDigestValue}" ;;
       *) echo "unexpected: $*" >&2; exit 9 ;;
     esac
     exit 0`,
  );
  fs.chmodSync(docker, 0o755);
  return docker;
}

test(
  'acquireImage downloads the release tar, verifies it and loads it through docker',
  { timeout: 30000 },
  async t => {
    const fixture = await releaseFixture();
    t.after(() => new Promise(resolve => fixture.server.close(resolve)));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'container-images-run-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'localhost-cert.pem'), fixture.cert);

    const root = path.join(directory, 'pack-root');
    fs.mkdirSync(path.join(root, 'provenance'), { recursive: true });
    const lock = lockFixture();
    lock.images[0].current.ociArchiveSha256 = fixture.sha256;
    lock.releaseAssetUrlTemplate = `https://127.0.0.1:${fixture.port}/releases/download/{tag}/{archive}`;
    const lockFile = path.join(root, 'provenance', 'runtime-distribution.json');
    fs.writeFileSync(lockFile, JSON.stringify(lock));

    const dockerDirectory = path.join(directory, 'bin');
    dockerShim(dockerDirectory, configDigest, 'industrial-chip-tools:chip-v0.1.0');

    const done = await childAcquire(directory, {
      lockFile,
      dockerDirectory,
      image: 'industrial-chip-tools',
    });
    assert.equal(done.status, 0, done.stderr);
    const result = JSON.parse(done.stdout);
    assert.equal(result.imageRef, 'industrial-chip-tools:chip-v0.1.0');
    assert.equal(result.sha256, fixture.sha256);
    assert.equal(result.bytes, 4096);
  },
);

test('acquireImage refuses tampered bytes and unreleased images', { timeout: 30000 }, async t => {
  const fixture = await releaseFixture();
  t.after(() => new Promise(resolve => fixture.server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'container-images-bad-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'localhost-cert.pem'), fixture.cert);

  const root = path.join(directory, 'pack-root');
  fs.mkdirSync(path.join(root, 'provenance'), { recursive: true });
  const lock = lockFixture();
  lock.images[0].current.ociArchiveSha256 = 'f'.repeat(64); // mismatching pin
  lock.releaseAssetUrlTemplate = `https://127.0.0.1:${fixture.port}/releases/download/{tag}/{archive}`;
  const lockFile = path.join(root, 'provenance', 'runtime-distribution.json');
  fs.writeFileSync(lockFile, JSON.stringify(lock));

  const dockerDirectory = path.join(directory, 'bin');
  dockerShim(dockerDirectory, configDigest, 'industrial-chip-tools:chip-v0.1.0');

  const tampered = await childAcquire(directory, {
    lockFile,
    dockerDirectory,
    image: 'industrial-chip-tools',
  });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /sha256 mismatch/);

  const unreleased = await childAcquire(directory, {
    lockFile,
    dockerDirectory,
    image: 'industrial-pcb-runtime',
  });
  assert.notEqual(unreleased.status, 0);
  assert.match(unreleased.stderr, /no released version/);
});
