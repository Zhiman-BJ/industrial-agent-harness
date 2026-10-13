const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeAssetManager, validateRuntimeAssets } = require('./runtime-assets.cjs');
const asset = {
  id: 'example-runtime',
  version: '1.0.0',
  label: 'Example runtime',
  type: 'docker-image',
  platform: 'darwin-arm64',
  image: 'example.test/runtime/tool@sha256:' + 'b'.repeat(64),
  imageId: 'sha256:' + 'a'.repeat(64),
  sha256: 'a'.repeat(64),
  imagePlatform: 'linux/amd64',
  size: 100,
  installedSize: 200,
  environment: 'INDUSTRIAL_HARNESS_EXAMPLE_IMAGE',
};
function fixture(t, override = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-image-test-'));
  const calls = [];
  const manager = new RuntimeAssetManager({
    directory,
    platform: 'darwin-arm64',
    command: async (command, args) => {
      calls.push([command, ...args]);
      return 'linux';
    },
    inspectImage: () => ({
      Id: asset.imageId,
      Os: 'linux',
      Architecture: 'amd64',
      RepoDigests: [asset.image],
    }),
    space: () => 10 ** 10,
    ...override,
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { manager, calls };
}
test('managed image pull pins digest and config, then reuses verified Docker cache', async t => {
  const { manager, calls } = fixture(t);
  await manager.ensure([asset]);
  assert.equal(manager.status([asset])[0].ready, true);
  assert.equal(manager.environment([asset])[asset.environment], asset.image);
  assert.deepEqual(calls[1], ['docker', 'pull', '--platform', 'linux/amd64', asset.image]);
  await manager.ensure([asset]);
  assert.equal(calls.length, 2);
  manager.inspectImage = () => ({
    Id: asset.imageId,
    Os: 'linux',
    Architecture: 'amd64',
    RepoDigests: [],
  });
  assert.equal(manager.status([asset])[0].ready, false);
  assert.equal(manager.environment([asset])[asset.environment], '');
});
test('wrong config/platform and unavailable daemon cannot activate an image', async t => {
  const { manager } = fixture(t, {
    inspectImage: () => ({
      Id: asset.imageId,
      Os: 'linux',
      Architecture: 'arm64',
      RepoDigests: [asset.image],
    }),
  });
  await assert.rejects(manager.ensure([asset]), /identity verification/);
  assert.equal(manager.status([asset])[0].ready, false);
  manager.command = async () => {
    throw Error('daemon offline');
  };
  await assert.rejects(manager.ensure([asset]), /Install and start Docker/);
});
test('mutable or inconsistently pinned container declarations fail validation', () => {
  assert.throws(
    () => validateRuntimeAssets([{ ...asset, image: 'example.test/runtime:latest' }]),
    /container/,
  );
  assert.throws(() => validateRuntimeAssets([{ ...asset, sha256: 'c'.repeat(64) }]), /container/);
});

test('containerd Docker image store verifies descriptor config plus repository digest', async t => {
  const { manager } = fixture(t, {
    inspectImage: () => ({
      Id: 'sha256:' + 'b'.repeat(64),
      Descriptor: { annotations: { 'config.digest': asset.imageId } },
      Os: 'linux',
      Architecture: 'amd64',
      RepoDigests: [asset.image],
    }),
  });
  await manager.ensure([asset]);
  assert.equal(manager.status([asset])[0].ready, true);
});

test('containerd store without descriptor annotation accepts the pinned manifest digest as Id', async t => {
  // Docker Desktop 29 reports Id = manifest digest and omits config.digest.
  const { manager } = fixture(t, {
    inspectImage: () => ({
      Id: asset.image.split('@')[1],
      Descriptor: {
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        digest: asset.image.split('@')[1],
      },
      Os: 'linux',
      Architecture: 'amd64',
      RepoDigests: [asset.image],
    }),
  });
  await manager.ensure([asset]);
  assert.equal(manager.status([asset])[0].ready, true);
});

test('containerd store rejects a different manifest digest even with matching repo', async t => {
  const { manager } = fixture(t, {
    inspectImage: () => ({
      Id: 'sha256:' + 'd'.repeat(64),
      Descriptor: { mediaType: 'application/vnd.docker.distribution.manifest.v2+json' },
      Os: 'linux',
      Architecture: 'amd64',
      RepoDigests: [asset.image],
    }),
  });
  await assert.rejects(manager.ensure([asset]), /identity verification/);
  assert.equal(manager.status([asset])[0].ready, false);
});

test('one immutable image can be prepared only on its declared client platforms', async t => {
  const multi = { ...asset, platforms: ['darwin-arm64', 'linux-x64'] };
  const { manager } = fixture(t, { platform: 'linux-x64' });
  await assert.rejects(manager.ensure([asset]), /does not support this platform/);
  await manager.ensure([multi]);
  assert.equal(manager.status([multi])[0].ready, true);
  manager.platform = 'win32-x64';
  assert.equal(manager.status([multi])[0].ready, false);
  await assert.rejects(manager.ensure([multi]), /does not support this platform/);
  for (const platforms of [
    [],
    ['linux-x64'],
    ['darwin-arm64', 'darwin-arm64'],
    ['darwin-arm64', 'win32-x64'],
    'linux-x64',
  ])
    assert.throws(() => validateRuntimeAssets([{ ...asset, platforms }]), /container/);
});

test('externally prepared container associates without an install receipt or pull and invalidates on identity change', async t => {
  const { RuntimeEnvironmentManager } = require('./runtime-environments.cjs');
  const { manager: runtimeAssets, calls } = fixture(t);
  const bundle = {
    domain: 'example',
    version: '1.0.0',
    runtimeAssets: [asset],
    executionProfiles: [
      {
        id: 'container',
        label: 'Container',
        kind: 'container',
        qualified: true,
        platforms: ['darwin-arm64'],
        toolIds: ['example.check'],
        assetIds: [asset.id],
      },
    ],
  };
  const manager = {
    directory: path.dirname(runtimeAssets.directory),
    list: () => [bundle],
    withLock: fn => fn(),
    assertIdle: () => {},
    runtimeAssets,
  };
  const environments = new RuntimeEnvironmentManager({ manager, platform: 'darwin-arm64' });
  runtimeAssets.ensure = () => {
    throw Error('No dependency installation allowed.');
  };
  assert.equal(runtimeAssets.status([asset])[0].ready, false);
  const view = await environments.associate('example', { profileId: 'container' });
  assert.equal(view.status, 'ready');
  assert.equal(view.environment[asset.environment], asset.image);
  assert.equal(view.profiles[0].assets[0].source, 'external');
  assert.deepEqual(view.readyToolIds, ['example.check']);
  assert.deepEqual(calls, []);
  assert.equal(
    fs.existsSync(runtimeAssets.directory),
    false,
    'No managed install receipt or cache is created.',
  );
  assert.equal((await environments.validate(bundle)).status, 'ready');
  for (const mismatch of [
    {
      Id: 'sha256:' + 'c'.repeat(64),
      Os: 'linux',
      Architecture: 'amd64',
      RepoDigests: [asset.image],
    },
    { Id: asset.imageId, Os: 'linux', Architecture: 'arm64', RepoDigests: [asset.image] },
    { Id: asset.imageId, Os: 'linux', Architecture: 'amd64', RepoDigests: [] },
  ]) {
    runtimeAssets.inspectImage = () => mismatch;
    const changed = environments.describe('example');
    assert.equal(changed.status, 'missing');
    assert.equal(changed.environment[asset.environment], '');
    assert.deepEqual(changed.readyToolIds, []);
  }
});

test('explicit container preparation requires an existing Docker CLI and daemon before pull or state mutation', async t => {
  const { RuntimeEnvironmentManager } = require('./runtime-environments.cjs');
  const { manager: runtimeAssets, calls } = fixture(t);
  const bundle = {
    domain: 'example',
    version: '1.0.0',
    runtimeAssets: [asset],
    executionProfiles: [
      {
        id: 'container',
        label: 'Container',
        kind: 'container',
        qualified: true,
        platforms: ['darwin-arm64'],
        toolIds: ['example.check'],
        assetIds: [asset.id],
      },
    ],
  };
  const manager = {
    directory: path.dirname(runtimeAssets.directory),
    list: () => [bundle],
    withLock: fn => fn(),
    assertIdle: () => {},
    runtimeAssets,
  };
  const environment = new RuntimeEnvironmentManager({
    manager,
    platform: 'darwin-arm64',
    command: async () => {
      throw Error('spawn docker ENOENT');
    },
  });
  for (const issue of ['spawn docker ENOENT', 'Cannot connect to the Docker daemon']) {
    environment.command = async () => {
      throw Error(issue);
    };
    const refused = await environment.prepare('example', { profileId: 'container' });
    assert.equal(refused.status, 'missing');
    assert.equal(refused.reasons[0].code, 'DOCKER_UNAVAILABLE');
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(runtimeAssets.directory), false);
    assert.equal(fs.existsSync(environment.directory), false);
  }
  environment.command = async (command, args, options) => {
    assert.equal(command, 'docker');
    assert.equal(args[0], 'info');
    assert.equal(options.captureOutput, true);
    return { stdout: 'linux\n', stderr: 'WARNING: daemon diagnostic\n' };
  };
  const ready = await environment.prepare('example', { profileId: 'container' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.binding.profileId, 'container');
  assert.equal(ready.profiles[0].assets[0].manageable, true);
  assert.equal(calls.filter(call => call[1] === 'pull').length, 1);
  assert.equal(runtimeAssets.status([asset])[0].ready, true);
  const previous = ready.binding;
  environment.command = async () => {
    throw Error('daemon offline');
  };
  assert.equal(
    (await environment.prepare('example', { profileId: 'container' })).reasons[0].code,
    'DOCKER_UNAVAILABLE',
  );
  assert.deepEqual(environment.describe('example').binding, previous);
});

test('command output capture separates a real child warning while retaining legacy output and failure diagnostics', async () => {
  const { run } = require('./runtime-assets.cjs');
  const args = [
    '-e',
    'process.stdout.write("linux\\n"); process.stderr.write("WARNING: daemon diagnostic\\n")',
  ];
  const captured = await run(process.execPath, args, { captureOutput: true });
  assert.equal(captured.stdout, 'linux\n');
  assert.equal(captured.stderr, 'WARNING: daemon diagnostic\n');
  assert.match(await run(process.execPath, args), /WARNING: daemon diagnostic/);
  await assert.rejects(
    run(process.execPath, ['-e', 'console.error("daemon failure detail"); process.exit(1)'], {
      captureOutput: true,
    }),
    /daemon failure detail/,
  );
});
