const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createArchive, digest } = require('./index.cjs');
const { dockerFixture } = require('./container-image-fixture.cjs');
const { fixture } = require('./container-install-fixture.cjs');

test('signed Pack installation prepares the authenticated images before activation; repair ignores discovery overrides', async t => {
  const f = await fixture(t);
  process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION = path.join(f.root, 'untrusted-lock.json');
  fs.writeFileSync(process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION, '{}');
  const installed = await f.manager.install(await f.selected(), { prepareRuntime: true });
  assert.equal(installed.domain, 'review');
  assert.deepEqual(f.manager.scan().errors, []);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(installed.location, 'provenance/runtime-distribution.json')),
    ).images[0].current.configDigest,
    f.configDigest,
  );
  await f.manager.prepareRuntime(installed, { recheck: true });
  assert.equal(f.docker.calls.filter(args => args[0] === 'load').length, 1);
  fs.writeFileSync(path.join(installed.location, 'provenance/runtime-distribution.json'), '{}');
  await assert.rejects(f.manager.prepareRuntime(installed), /resource changed/);
});

test('image failure and cancellation preserve the installed Pack version and leave no staging', async t => {
  const f = await fixture(t);
  await f.manager.install(await f.selected(), { prepareRuntime: true });
  f.update('1.1.0');
  f.manager.containerImages.command = dockerFixture(f, { failAt: 'load' }).command;
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker failure/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
  assert.ok(
    fs.readdirSync(f.manager.containerImages.directory).every(name => name.endsWith('.json')),
  );
  const abort = new AbortController();
  f.manager.containerImages.command = dockerFixture(f).command;
  await assert.rejects(
    f.manager.install(await f.selected(), {
      prepareRuntime: true,
      signal: abort.signal,
      onProgress: p => {
        if (p.phase === 'downloading' && p.received === p.total) abort.abort(Error('cancelled'));
      },
    }),
    /cancelled/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
});

test('image declarations without their signed lock or from another domain cannot be bundled', async t => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.source, 'provenance/runtime-distribution.json'));
  assert.throws(() => createArchive(f.source), /distribution lock inside/);
  f.lock.images[0].pack = 'another';
  fs.writeFileSync(
    path.join(f.source, 'provenance/runtime-distribution.json'),
    JSON.stringify(f.lock),
  );
  assert.throws(() => createArchive(f.source), /another Domain/);
});

test('missing Docker prevents first activation and preserves the installed version during update', async t => {
  const f = await fixture(t);
  const available = f.manager.containerImages.command;
  f.manager.containerImages.command = require('./runtime-assets.cjs').run;
  f.manager.containerImages.docker = path.join(f.root, 'missing-docker');
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker was not found/,
  );
  assert.deepEqual(f.manager.list(), []);
  assert.equal(fs.existsSync(f.manager.containerImages.directory), false);
  f.manager.containerImages.command = available;
  await f.manager.install(await f.selected(), { prepareRuntime: true });
  f.update('1.1.0');
  f.manager.containerImages.command = require('./runtime-assets.cjs').run;
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker was not found/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
  assert.ok(
    fs.readdirSync(f.manager.containerImages.directory).every(name => name.endsWith('.json')),
  );
});

test('mixed native and image installation checks Docker before any native download', async t => {
  const f = await fixture(t);
  f.bundle.runtimeAssets = [
    {
      id: 'modeler',
      label: 'Modeler',
      version: '1.2.3',
      type: 'macos-app-dmg',
      platform: 'darwin-arm64',
      url: 'https://vendor.example/runtime.dmg',
      sha256: digest(Buffer.from('vendor image')),
      size: 12,
      app: 'Modeler.app',
      executable: 'Contents/bin/modeler',
      environment: 'INDUSTRIAL_HARNESS_MODELER_CMD',
      versionArgs: ['--version'],
      versionText: '1.2.3',
      profileEnvironment: {},
    },
  ];
  f.update('1.1.0');
  let nativePreparations = 0;
  f.manager.runtimeAssets.ensure = async () => {
    nativePreparations++;
  };
  f.manager.containerImages.command = require('./runtime-assets.cjs').run;
  f.manager.containerImages.docker = path.join(f.root, 'missing-docker');
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker was not found/,
  );
  assert.equal(nativePreparations, 0);
  assert.deepEqual(f.manager.list(), []);
  assert.equal(fs.existsSync(f.manager.runtimeAssets.directory), false);
  assert.equal(fs.existsSync(f.manager.containerImages.directory), false);

  f.manager.containerImages.command = async () => {
    throw Error('engine unavailable');
  };
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker could not be reached/,
  );
  assert.equal(nativePreparations, 0);
  f.manager.containerImages.command = f.docker.command;
  await f.manager.install(await f.selected(), { prepareRuntime: true });
  assert.equal(nativePreparations, 1);
  assert.equal(f.manager.list()[0].version, '1.1.0');
});
