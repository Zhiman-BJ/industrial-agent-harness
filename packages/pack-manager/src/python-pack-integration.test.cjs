const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  PackManager,
  PythonEnvironmentManager,
  createArchive,
  decodeArchive,
  digest,
  validateBundle,
  verifyCatalog,
  signCatalog,
} = require('./index.cjs');
const { PackCatalog, describeInstalled } = require('./catalog.cjs');
const { fixture: containerFixture } = require('./container-install-fixture.cjs');

// Synthetic transfer declarations for Pack integration only. No official URL or
// checksum is replaced and these tests never download or claim Python readiness.
const pythonDeclaration = () => ({
  id: 'layout-python',
  label: 'Layout reader',
  version: '1.0.0',
  purpose: 'viewer',
  viewer: 'layout',
  environment: 'INDUSTRIAL_HARNESS_LAYOUT_PYTHON',
  pythonVersion: '3.12.15',
  modules: ['sample.db', 'sample.lay'],
  platforms: {
    [`${process.platform}-${process.arch}`]: {
      interpreter: {
        url: 'https://official.example/python.tar.gz',
        sha256: 'a'.repeat(64),
        size: 10,
        executable: 'python/bin/python3.12',
        format: 'tar.gz',
      },
      wheels: [
        {
          name: 'sample',
          version: '1.2.3',
          filename: 'sample-1.2.3-py3-none-any.whl',
          url: 'https://official.example/sample.whl',
          sha256: 'b'.repeat(64),
          size: 20,
        },
      ],
      installedSize: 1000,
    },
  },
});
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pack-python-integration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const bundle = {
    schemaVersion: 1,
    domain: 'review',
    version: '1.0.0',
    coreApi: 1,
    label: 'Review',
    emoji: '',
    capabilities: [],
    skills: [],
    providerPacks: [],
    prerequisites: ['External engineering toolchain'],
    pythonEnvironments: [pythonDeclaration()],
  };
  const build = () => {
    fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
    return createArchive(source);
  };
  const entry = bytes => ({
    domain: bundle.domain,
    version: bundle.version,
    size: bytes.length,
    sha256: digest(bytes),
    url: 'review.hpack',
    platforms: [`${process.platform}-${process.arch}`],
    pythonEnvironments: structuredClone(bundle.pythonEnvironments),
  });
  const manager = new PackManager({ directory: path.join(root, 'store'), space: () => 1024 ** 4 });
  return { root, source, bundle, build, entry, manager };
}
const status = (asset, ready) => ({
  id: asset.id,
  label: asset.label,
  version: asset.version,
  purpose: asset.purpose,
  viewer: asset.viewer,
  environment: asset.environment,
  ready,
});

test('Python declarations are independently validated in bundles, decoded archives and signed catalogs', t => {
  const f = fixture(t);
  assert.equal(validateBundle({ ...f.bundle, pythonEnvironments: undefined }).domain, 'review');
  const bytes = f.build();
  assert.deepEqual(decodeArchive(bytes).bundle.pythonEnvironments, f.bundle.pythonEnvironments);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = { release: publicKey };
  const payload = () => ({ schemaVersion: 1, channel: 'stable', packs: [f.entry(bytes)] });
  assert.equal(verifyCatalog(signCatalog(payload(), 'release', privateKey), keys).packs.length, 1);
  for (const mutate of [
    bundle => {
      bundle.pythonEnvironments = {};
    },
    bundle => {
      bundle.pythonEnvironments[0].purpose = 'runtime';
    },
    bundle => {
      bundle.pythonEnvironments[0].environment = 'HOME';
    },
    bundle => {
      bundle.pythonEnvironments[0].platforms[
        `${process.platform}-${process.arch}`
      ].interpreter.url = 'http://untrusted.example/python.tar.gz';
    },
    bundle => {
      bundle.pythonEnvironments[0].platforms[
        `${process.platform}-${process.arch}`
      ].wheels[0].sha256 = '';
    },
    bundle => {
      bundle.pythonEnvironments.push(structuredClone(bundle.pythonEnvironments[0]));
    },
  ]) {
    const invalid = structuredClone(f.bundle);
    mutate(invalid);
    assert.throws(() => validateBundle(invalid), /Python|HTTPS/);
    const signedPayload = payload();
    signedPayload.packs[0].pythonEnvironments = invalid.pythonEnvironments;
    assert.throws(
      () => verifyCatalog(signCatalog(signedPayload, 'release', privateKey), keys),
      /Python|HTTPS/,
    );
    const archive = JSON.parse(zlib.gunzipSync(bytes));
    const manifest = archive.files.find(file => file.path === 'bundle.json');
    const changed = Buffer.from(JSON.stringify(invalid));
    manifest.data = changed.toString('base64');
    manifest.sha256 = digest(changed);
    assert.throws(() => decodeArchive(zlib.gzipSync(JSON.stringify(archive))), /Python|HTTPS/);
  }
});

test('verified catalog Python identities are immutable and bind preparation to the decoded manifest', async t => {
  const f = fixture(t),
    bytes = f.build();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  f.manager.keys = { release: publicKey };
  const payload = { schemaVersion: 1, channel: 'stable', packs: [f.entry(bytes)] };
  const previous = global.fetch;
  t.after(() => {
    global.fetch = previous;
  });
  global.fetch = async () =>
    new Response(JSON.stringify(signCatalog(payload, 'release', privateKey)));
  const selected = (await f.manager.catalog('https://feed.example/catalog.json')).packs[0];
  assert.equal(Object.isFrozen(selected.pythonEnvironments), true);
  assert.equal(
    Object.isFrozen(
      selected.pythonEnvironments[0].platforms[`${process.platform}-${process.arch}`].wheels[0],
    ),
    true,
  );
  let preparations = 0;
  f.manager.pythonEnvironments.ensure = async assets => {
    preparations++;
    assert.deepEqual(assets, f.bundle.pythonEnvironments);
    return assets.map(asset => status(asset, true));
  };
  const installed = await f.manager.install(selected, { bytes, prepareRuntime: true });
  assert.equal(preparations, 1);
  assert.deepEqual(installed.pythonEnvironments, f.bundle.pythonEnvironments);
  payload.packs[0].pythonEnvironments[0].version = '2.0.0';
  const mismatched = (await f.manager.catalog('https://feed.example/catalog.json')).packs[0];
  await assert.rejects(
    f.manager.install(mismatched, { bytes, prepareRuntime: true }),
    /Python environment identity mismatch/,
  );
  assert.equal(preparations, 1, 'a mismatching catalog never starts the environment installer');
  assert.equal(f.manager.list()[0].version, '1.0.0');
});

test('installed Python repair requires receipt-bound declarations and preserves provenance on tampering', async t => {
  const f = fixture(t),
    bytes = f.build();
  assert.ok(f.manager.pythonEnvironments instanceof PythonEnvironmentManager);
  assert.equal(
    f.manager.pythonEnvironments.directory,
    path.join(f.manager.directory, '.python-environments'),
  );
  const installed = await f.manager.install(f.entry(bytes), { bytes, allowUnsigned: true });
  let calls = 0;
  f.manager.pythonEnvironments.ensure = async assets => {
    calls++;
    return assets.map(asset => status(asset, true));
  };
  await assert.rejects(
    f.manager.prepareRuntime({ ...installed, location: f.source }, { scope: 'viewer' }),
    /active installed Pack/,
  );
  const replaced = structuredClone(installed);
  replaced.pythonEnvironments[0].platforms[
    `${process.platform}-${process.arch}`
  ].interpreter.sha256 = 'c'.repeat(64);
  await assert.rejects(
    f.manager.prepareRuntime(replaced, { scope: 'viewer' }),
    /declaration identity mismatch/,
  );
  assert.equal(calls, 0);
  await f.manager.prepareRuntime(installed, { scope: 'viewer', recheck: true });
  assert.equal(calls, 1);
  const manifest = path.join(installed.location, 'bundle.json');
  fs.appendFileSync(manifest, '\n');
  await assert.rejects(
    f.manager.prepareRuntime(installed, { scope: 'viewer' }),
    /resource changed/,
  );
  assert.equal(calls, 1, 'a changed installed manifest never reaches preparation');
  assert.deepEqual(f.manager.list(), []);
  await f.manager.install(f.entry(bytes), { bytes, allowUnsigned: true });
  fs.unlinkSync(path.join(installed.location, '.hpack-integrity.json'));
  await assert.rejects(
    f.manager.prepareRuntime(installed, { scope: 'viewer' }),
    /integrity-verified installed Pack/,
  );
  assert.match(f.manager.scan().errors[0].message, /integrity receipt/);
});

test('fresh viewer-only installation activates without Docker and preserves the old Pack on viewer failure', async t => {
  const f = await containerFixture(t);
  f.bundle.pythonEnvironments = [pythonDeclaration()];
  f.update('1.0.0');
  const selected = await f.selected(),
    calls = [];
  f.manager.containerImages.preflight = async () => {
    calls.push('container');
    throw Error('Docker is offline');
  };
  f.manager.runtimeAssets.ensure = async () => {
    calls.push('native');
    throw Error('Native app must not be prepared');
  };
  f.manager.pythonEnvironments.ensure = async assets => {
    calls.push('python');
    return assets.map(asset => status(asset, true));
  };
  await assert.rejects(f.manager.install(selected, { prepareRuntime: true }), /Docker is offline/);
  assert.deepEqual(
    f.manager.list(),
    [],
    'full preparation cannot activate an unready first install',
  );
  await f.manager.install(selected, { prepareRuntime: true, runtimeScope: 'viewer' });
  assert.deepEqual(calls, ['container', 'python']);
  assert.equal(f.manager.list()[0].version, '1.0.0');
  f.update('1.1.0');
  f.manager.pythonEnvironments.ensure = async () => {
    throw Error('Python download failed');
  };
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true, runtimeScope: 'viewer' }),
    /Python download failed/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
  for (const options of [{ runtimeScope: 'viewer' }, { prepareRuntime: true, runtimeScope: 'all' }])
    await assert.rejects(f.manager.install(selected, options), /Viewer-only installation requires/);
});

test('catalog summaries advertise only current-platform viewer availability without executable recipes', t => {
  const f = fixture(t),
    bytes = f.build();
  const catalog = new PackCatalog({
    directory: f.manager.directory,
    platform: `${process.platform}-${process.arch}`,
  });
  const entry = f.entry(bytes);
  entry.pythonEnvironments[0].probe = 'print("private recipe details")';
  const summary = catalog.summaries([entry])[0];
  assert.equal(summary.viewerAvailable, true);
  assert.equal(Object.hasOwn(summary, 'pythonEnvironments'), false);
  assert.equal(JSON.stringify(summary).includes('official.example'), false);
  assert.equal(JSON.stringify(summary).includes('private recipe details'), false);
  assert.equal(catalog.summaries([{ ...entry, pythonEnvironments: [] }])[0].viewerAvailable, false);
  const otherPlatform = process.platform === 'win32' ? 'linux-x64' : 'win32-x64';
  const unsupported = new PackCatalog({ directory: f.manager.directory, platform: otherPlatform });
  assert.equal(unsupported.summaries([entry])[0].viewerAvailable, false);
});

test('viewer-only preparation skips unrelated native and container preflight while default preparation retains both', async t => {
  const f = await containerFixture(t);
  f.bundle.pythonEnvironments = [pythonDeclaration()];
  f.update('1.0.0');
  const installed = await f.manager.install(await f.selected());
  const order = [],
    controller = new AbortController();
  const onProgress = () => {};
  f.manager.containerImages.preflight = async () => {
    order.push('container-preflight');
    throw Error('Docker is offline');
  };
  f.manager.runtimeAssets.ensure = async () => {
    order.push('native');
  };
  f.manager.pythonEnvironments.ensure = async (assets, options) => {
    order.push('python');
    assert.deepEqual(assets, f.bundle.pythonEnvironments);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.onProgress, onProgress);
    assert.equal(options.recheck, true);
    return assets.map(asset => status(asset, true));
  };
  const prepared = await f.manager.prepareRuntime(installed, {
    scope: 'viewer',
    recheck: true,
    signal: controller.signal,
    onProgress,
  });
  assert.deepEqual(order, ['python']);
  assert.equal(prepared[0].viewer, 'layout');
  await assert.rejects(f.manager.prepareRuntime(installed), /Docker is offline/);
  assert.deepEqual(order, ['python', 'container-preflight']);
  f.manager.containerImages.preflight = async () => {
    order.push('container-preflight');
  };
  f.manager.containerImages.ensure = async () => {
    order.push('container');
    return [];
  };
  await f.manager.prepareRuntime(installed, {
    recheck: true,
    signal: controller.signal,
    onProgress,
  });
  assert.deepEqual(order.slice(-4), ['container-preflight', 'native', 'python', 'container']);
});

test('viewer readiness never promotes external engineering prerequisites or unready native assets', t => {
  const f = fixture(t),
    asset = f.bundle.pythonEnvironments[0];
  f.manager.pythonEnvironments.status = () => [status(asset, true)];
  let summary = describeInstalled(f.manager, f.bundle);
  assert.equal(summary.runtimeState, 'external-dependencies');
  assert.deepEqual(summary.runtimeAssets, []);
  assert.equal(summary.viewerState, 'ready');
  assert.deepEqual(summary.viewerAssets, [status(asset, true)]);
  f.manager.runtimeAssets.status = () => [{ id: 'native-tool', ready: false }];
  summary = describeInstalled(f.manager, f.bundle);
  assert.equal(summary.runtimeState, 'needs-preparation');
  assert.equal(summary.viewerState, 'ready');
  f.manager.pythonEnvironments.status = () => [status(asset, false)];
  summary = describeInstalled(f.manager, f.bundle);
  assert.equal(summary.viewerState, 'needs-preparation');
  f.manager.runtimeAssets.status = () => {
    throw Error('viewer status accessed native assets');
  };
  f.manager.containerImages.status = () => {
    throw Error('viewer status accessed container assets');
  };
  assert.deepEqual(f.manager.runtimeStatus(f.bundle, { scope: 'viewer' }), [status(asset, false)]);
});

test('Python download and installation estimates are additive without creating environments', t => {
  const f = fixture(t);
  const entry = { size: 100, installedSize: 200, pythonEnvironments: f.bundle.pythonEnvironments };
  const estimate = f.manager.estimate(entry);
  assert.equal(estimate.downloadBytes, 130);
  assert.equal(estimate.installedBytes, 1200);
  assert.equal(estimate.estimated, false);
  assert.ok(estimate.requiredBytes >= 1330);
  assert.equal(fs.existsSync(f.manager.directory), false);
});
