const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { createLocalhostCertificate } = require('./localhost-tls.cjs');
const { writeOciFixture, dockerFixture } = require('./container-image-fixture.cjs');
const {
  acquireImage,
  resolveImageAsset,
  readDistributionLock,
  ContainerImageManager,
} = require('./container-images.cjs');

async function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-acquisition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = await writeOciFixture(path.join(root, 'image.tar'), options);
  const temporaryDirectory = path.join(root, 'downloads');
  fs.mkdirSync(temporaryDirectory);
  const previous = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, body: fs.createReadStream(identity.file) });
  t.after(() => {
    global.fetch = previous;
  });
  return {
    ...identity,
    root,
    temporaryDirectory,
    options: { distribution: { lock: identity.lock }, image: 'review-image', temporaryDirectory },
  };
}

test('explicit registry, namespace, tag and digest must agree with the locked release', async t => {
  const f = await fixture(t);
  for (const image of [
    'review-image',
    'review-image:v1',
    'ghcr.io/example/review-image:v1',
    'review-image@' + f.lock.images[0].current.imageDigest,
  ])
    assert.equal(resolveImageAsset({ lock: f.lock }, image).imageRef, 'review-image:v1');
  for (const image of [
    'review-image:v0',
    'ghcr.io/other/review-image:v1',
    'other.io/example/review-image:v1',
    'review-image@sha256:' + 'a'.repeat(64),
  ])
    assert.throws(() => resolveImageAsset({ lock: f.lock }, image), /does not match/);
  assert.equal(resolveImageAsset({ lock: f.lock }, 'missing'), null);
  assert.equal(resolveImageAsset({ lock: f.lock }, 'unreleased').released, false);
});

test('distribution discovery finds the owner root and missing trees return null', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.root, 'provenance'));
  fs.writeFileSync(
    path.join(f.root, 'provenance/runtime-distribution.json'),
    JSON.stringify(f.lock),
  );
  assert.deepEqual(readDistributionLock(path.join(f.root, 'packs/review')).lock, f.lock);
  assert.equal(readDistributionLock(path.join(os.tmpdir(), 'absent-' + Date.now())), null);
});

test('unreleased images and a non-Linux Docker engine fail before downloading', async t => {
  const f = await fixture(t);
  let downloads = 0;
  global.fetch = async () => {
    downloads++;
    throw Error('No download should start.');
  };
  const docker = dockerFixture(f);
  await assert.rejects(
    acquireImage({ ...f.options, image: 'unreleased', command: docker.command }),
    /no released version/,
  );
  assert.equal(docker.calls.length, 0);
  await assert.rejects(
    acquireImage({ ...f.options, command: async () => 'windows' }),
    /Linux Docker/,
  );
  assert.equal(downloads, 0);
  assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
});

test('missing Docker and unreachable engines give distinct guidance without downloading; cancellation remains cancellation', async t => {
  const f = await fixture(t);
  let downloads = 0;
  global.fetch = async () => {
    downloads++;
    throw Error('No image download should start.');
  };
  // Real process spawn against a nonexistent absolute executable exercises ENOENT.
  await assert.rejects(
    acquireImage({ ...f.options, docker: path.join(f.root, 'missing-docker') }),
    /Docker was not found\. Install Docker Desktop/,
  );
  await assert.rejects(
    acquireImage({
      ...f.options,
      command: async () => {
        throw Error('Cannot connect to the Docker daemon');
      },
    }),
    /Docker could not be reached\. Start Docker Desktop/,
  );
  const controller = new AbortController();
  const cancelled = Error('User cancelled engine check');
  await assert.rejects(
    acquireImage({
      ...f.options,
      signal: controller.signal,
      command: async () => {
        controller.abort(cancelled);
        throw cancelled;
      },
    }),
    error => error === cancelled,
  );
  assert.equal(downloads, 0);
  assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
});

for (const classic of [false, true])
  test(`untagged OCI acquisition verifies ${classic ? 'classic config' : 'containerd manifest'} identity and creates a usable tag`, async t => {
    const f = await fixture(t),
      docker = dockerFixture(f, { classic });
    const result = await acquireImage({ ...f.options, command: docker.command });
    assert.equal(result.imageId, classic ? f.configDigest : f.manifestDigest);
    assert.ok(docker.calls.some(args => args[1] === 'tag' && args[3] === result.imageRef));
    assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
  });

test('streaming a 256 MiB archive keeps payload memory bounded', async t => {
  const f = await fixture(t, { layerBytes: 256 * 1024 * 1024 }),
    docker = dockerFixture(f);
  let peak = 0;
  await acquireImage({
    ...f.options,
    command: docker.command,
    onProgress: () => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    },
  });
  assert.ok(peak < 160 * 1024 * 1024, `payload memory peaked at ${peak}`);
});

test('failed downloads, OCI verification, Docker load and inspect remove staging even with keepArchive', async t => {
  const f = await fixture(t);
  for (const failAt of ['load', 'image inspect']) {
    const docker = dockerFixture(f, { failAt });
    await assert.rejects(
      acquireImage({ ...f.options, keepArchive: true, command: docker.command }),
      /Docker failure/,
    );
    assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
  }
  f.lock.images[0].current.ociArchiveSha256 = 'a'.repeat(64);
  const docker = dockerFixture(f);
  await assert.rejects(acquireImage({ ...f.options, command: docker.command }), /sha256 mismatch/);
  assert.ok(!docker.calls.some(args => args[0] === 'load'));
  assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
});

test('truncated and oversized downloads fail before docker load', async t => {
  const f = await fixture(t),
    docker = dockerFixture(f);
  for (const change of [-1, 2]) {
    f.lock.images[0].current.ociArchiveBytes += change;
    await assert.rejects(acquireImage({ ...f.options, command: docker.command }), /size/);
    assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
  }
  assert.ok(!docker.calls.some(args => args[0] === 'load'));
});

test('OCI metadata content must match its descriptor before loading', async t => {
  const f = await fixture(t, { badConfig: true }),
    docker = dockerFixture(f);
  await assert.rejects(acquireImage({ ...f.options, command: docker.command }), /metadata digest/);
  assert.ok(!docker.calls.some(args => args[0] === 'load'));
  assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
});

test('a valid archive for another platform is rejected before Docker load', async t => {
  const f = await fixture(t),
    docker = dockerFixture(f);
  f.lock.images[0].platform = 'linux/arm64';
  await assert.rejects(acquireImage({ ...f.options, command: docker.command }), /platform/);
  assert.ok(!docker.calls.some(args => args[0] === 'load'));
  assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
});

test('cancellation after the final download chunk cannot start docker load', async t => {
  const f = await fixture(t),
    docker = dockerFixture(f),
    controller = new AbortController();
  await assert.rejects(
    acquireImage({
      ...f.options,
      command: docker.command,
      signal: controller.signal,
      onProgress: p => {
        if (p.received === f.bytes) controller.abort(Error('cancelled at download completion'));
      },
    }),
    /cancelled/,
  );
  assert.ok(!docker.calls.some(args => args[0] === 'load'));
  assert.deepEqual(fs.readdirSync(f.temporaryDirectory), []);
});

test('successful retention is explicit and failed identities never produce receipts', async t => {
  const f = await fixture(t),
    docker = dockerFixture(f);
  const result = await acquireImage({ ...f.options, command: docker.command, keepArchive: true });
  assert.equal(fs.statSync(result.archive).size, f.bytes);
  const manager = new ContainerImageManager({
    directory: f.root,
    command: dockerFixture(f, { failAt: 'load' }).command,
  });
  await assert.rejects(manager.ensure(f.lock, ['review-image']), /Docker failure/);
  assert.deepEqual(fs.readdirSync(manager.directory), []);
});

test('a prepared image is reused only while Docker retains its verified identity', async t => {
  const f = await fixture(t),
    docker = dockerFixture(f);
  const manager = new ContainerImageManager({ directory: f.root, command: docker.command });
  await manager.ensure(f.lock, ['review-image']);
  const [result] = await manager.ensure(f.lock, ['review-image']);
  assert.equal(result.reused, true);
  assert.equal(docker.calls.filter(args => args[0] === 'load').length, 1);
  manager.command = dockerFixture(f).command;
  assert.equal((await manager.ensure(f.lock, ['review-image']))[0].reused, undefined);
});

test('real HTTPS transport verifies the release bytes with a portable Docker fixture', async t => {
  const f = await fixture(t),
    tls = createLocalhostCertificate();
  const server = https.createServer(tls, (_req, res) => fs.createReadStream(f.file).pipe(res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.lock.releaseAssetUrlTemplate = `https://127.0.0.1:${server.address().port}/{tag}/{archive}`;
  const cert = path.join(f.root, 'cert.pem');
  fs.writeFileSync(cert, tls.cert);
  const script = path.join(f.root, 'child.cjs');
  fs.writeFileSync(
    script,
    `const { acquireImage } = require(${JSON.stringify(require.resolve('./container-images.cjs'))});
    const { dockerFixture } = require(${JSON.stringify(require.resolve('./container-image-fixture.cjs'))});
    acquireImage({ ...${JSON.stringify(f.options)}, command: dockerFixture(${JSON.stringify({ manifestDigest: f.manifestDigest, configDigest: f.configDigest })}).command })
      .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });`,
  );
  const done = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', b => {
      stdout += b;
    });
    child.stderr.on('data', b => {
      stderr += b;
    });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).manifestDigest, f.manifestDigest);
});
