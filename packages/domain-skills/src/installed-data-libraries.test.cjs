const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PackManager, createArchive, digest } = require('../../pack-manager/src/index.cjs');

const installedFile = path.join(__dirname, 'installed.cjs');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-data-libraries-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeCatalog(directory, id = 'fixture-models') {
  const catalog = {
    schemaVersion: 1,
    id,
    version: '1.0.0',
    baseUrl: 'https://models.example/fixed/',
    source: { revision: 'a'.repeat(40) },
    license: { spdx: 'CC-BY-SA-4.0', url: 'https://models.example/license' },
    files: [{ path: 'Family/model.step', size: 14, sha256: digest('fixture model\n') }],
  };
  const bytes = Buffer.from(JSON.stringify(catalog));
  const relative = 'models/catalog.json';
  const file = path.join(directory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return {
    catalog,
    file,
    library: {
      id,
      version: catalog.version,
      label: 'Fixture models',
      baseUrl: catalog.baseUrl,
      catalog: relative,
      catalogSha256: digest(bytes),
      referencePrefixes: ['${FIXTURE_MODELS}/'],
    },
  };
}

function sourcePack(domain, library) {
  return {
    schemaVersion: 1,
    id: `${domain}-pack`,
    domain,
    version: '1.0.0',
    runtime: { entry: 'runtime/index.cjs' },
    capabilities: [],
    provider: {
      id: `${domain}.provider`,
      packId: `${domain}-pack`,
      domain,
      version: '1.0.0',
      transport: 'runtime',
      packDirectory: `${domain}-data-test`,
      directoryEnv: 'FIXTURE_DATA_OWNER_ROOT',
      resourceRoots: ['runtime'],
      sourceFiles: { 'runtime/index.cjs': digest('fixture runtime') },
      sourceSha256: digest('fixture inventory'),
      tools: [],
    },
    ...(library ? { dataLibraries: [library] } : {}),
  };
}

// Keep owner metadata and distribution binding isolated in a fresh process.
// The actual Pack validator, source directory resolution, PackManager, and
// data-library binding reader are never mocked.
function readInstalled({
  domains,
  packs = [],
  directories = {},
  store,
  distributionDomain = null,
}) {
  const environment = {
    ...process.env,
    FIXTURE_DATA_OWNER_ROOT: path.join(os.tmpdir(), 'untrusted-model-override'),
    INDUSTRIAL_HARNESS_MODEL_CATALOG: path.join(os.tmpdir(), 'untrusted-catalog.json'),
  };
  delete environment.INDUSTRIAL_HARNESS_PACK_STORE;
  if (store) environment.INDUSTRIAL_HARNESS_PACK_STORE = store;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
        const fs = require('node:fs');
        const path = require('node:path');
        const Module = require('node:module');
        const config = JSON.parse(fs.readFileSync(0, 'utf8'));
        const sourceCalls = [];
        const owner = {
          consumerMetadata: () => ({ capabilities: [], skills: [], domains: [] }),
          hostPacks: () => config.packs,
          sourceDirectory(id) {
            sourceCalls.push(id);
            if (!config.directories[id]) throw Error('Unexpected source Pack lookup: ' + id);
            return config.directories[id];
          },
        };
        const originalLoad = Module._load;
        Module._load = function(request, parent, isMain) {
          if (request === '@zhiman-bj/industrial-domain-packs') return owner;
          if (request === './distribution.cjs' &&
              path.dirname(parent.filename) === path.dirname(config.installedFile))
            return { distributionDomain: config.distributionDomain };
          return originalLoad.call(this, request, parent, isMain);
        };
        const { installedDataLibraries } = require(config.installedFile);
        const results = config.domains.map(domain => {
          try { return { bindings: installedDataLibraries(domain) }; }
          catch (error) { return { error: String(error.message) }; }
        });
        process.stdout.write(JSON.stringify({ results, sourceCalls }));
      `,
    ],
    {
      input: JSON.stringify({
        installedFile,
        domains,
        packs,
        directories,
        distributionDomain,
      }),
      encoding: 'utf8',
      env: environment,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

async function installBundle(directory, store, domain, library) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      domain,
      label: 'Data library fixture',
      emoji: '🧪',
      version: '1.0.0',
      coreApi: 1,
      capabilities: [],
      skills: [],
      providerPacks: [],
      ...(library ? { dataLibraries: [library] } : {}),
    }),
  );
  const bytes = createArchive(directory);
  const manager = new PackManager({ directory: store });
  await manager.install(
    {
      domain,
      version: '1.0.0',
      sha256: digest(bytes),
      size: bytes.length,
      platforms: [`${process.platform}-${process.arch}`],
    },
    { bytes, allowUnsigned: true },
  );
  return { manager, location: manager.list().find(bundle => bundle.domain === domain).location };
}

test('source data libraries use the selected owner directory and ignore resource environment overrides', t => {
  const directory = setup(t);
  const source = path.join(directory, 'owner');
  const { catalog, library } = writeCatalog(source);
  const pack = sourcePack('fixture-a', library);
  const unrelated = sourcePack('fixture-b', {
    ...library,
    catalog: 'missing/catalog.json',
  });
  const { results, sourceCalls } = readInstalled({
    domains: ['fixture-a'],
    packs: [pack, unrelated],
    directories: { [pack.id]: source },
  });
  assert.equal(results[0].bindings.length, 1);
  assert.equal(results[0].bindings[0].library.id, library.id);
  assert.deepEqual(results[0].bindings[0].catalog, catalog);
  assert.deepEqual(sourceCalls, [pack.id]);
});

test('source data libraries require a project domain and obey the packaged distribution binding', t => {
  const directory = setup(t);
  const { library } = writeCatalog(directory);
  const pack = sourcePack('fixture-a', library);
  const options = { packs: [pack], directories: { [pack.id]: directory } };
  const unbound = readInstalled({ ...options, domains: [null, '', ' ', 'unknown-domain'] });
  assert.deepEqual(unbound.results, Array(4).fill({ bindings: [] }));
  assert.deepEqual(unbound.sourceCalls, []);
  const excluded = readInstalled({
    ...options,
    domains: ['fixture-a'],
    distributionDomain: 'fixture-b',
  });
  assert.deepEqual(excluded.results, [{ bindings: [] }]);
  assert.deepEqual(excluded.sourceCalls, []);
});

test('source catalog tampering and missing catalogs are rejected by the real binding reader', t => {
  const directory = setup(t);
  const { file, library } = writeCatalog(directory);
  const pack = sourcePack('fixture-a', library);
  const options = {
    domains: ['fixture-a'],
    packs: [pack],
    directories: { [pack.id]: directory },
  };
  fs.appendFileSync(file, '\n');
  assert.match(readInstalled(options).results[0].error, /catalog|hash|digest|integrity/i);
  fs.unlinkSync(file);
  assert.ok(readInstalled(options).results[0].error);
});

test('managed data libraries read the verified bundle root and isolate domains and distributions', async t => {
  const directory = setup(t);
  const store = path.join(directory, 'store');
  const sourceA = path.join(directory, 'a');
  const sourceB = path.join(directory, 'b');
  const first = writeCatalog(sourceA, 'fixture-models-a');
  const second = writeCatalog(sourceB, 'fixture-models-b');
  await installBundle(sourceA, store, 'fixture-a', first.library);
  await installBundle(sourceB, store, 'fixture-b', second.library);
  const { results, sourceCalls } = readInstalled({
    store,
    domains: ['fixture-a', 'fixture-b', 'unknown-domain', null],
    // A managed store must never fall through to source declarations.
    packs: [sourcePack('fixture-a', first.library)],
  });
  assert.deepEqual(results[0].bindings[0].catalog, first.catalog);
  assert.deepEqual(results[1].bindings[0].catalog, second.catalog);
  assert.equal(results[0].bindings.length, 1);
  assert.equal(results[1].bindings.length, 1);
  assert.deepEqual(results.slice(2), [{ bindings: [] }, { bindings: [] }]);
  assert.deepEqual(sourceCalls, []);
  const scoped = readInstalled({
    store,
    domains: ['fixture-a', 'fixture-b'],
    distributionDomain: 'fixture-a',
  });
  assert.equal(scoped.results[0].bindings.length, 1);
  assert.deepEqual(scoped.results[1], { bindings: [] });
});

test('managed catalog corruption is excluded by PackManager integrity without source fallback', async t => {
  const directory = setup(t);
  const store = path.join(directory, 'store');
  const source = path.join(directory, 'source');
  const { library } = writeCatalog(source);
  const { manager, location } = await installBundle(source, store, 'fixture-a', library);
  fs.appendFileSync(path.join(location, library.catalog), '\n');
  assert.equal(manager.scan().errors.length, 1);
  const pack = sourcePack('fixture-a', library);
  const { results, sourceCalls } = readInstalled({
    store,
    domains: ['fixture-a'],
    packs: [pack],
    directories: { [pack.id]: source },
  });
  assert.deepEqual(results, [{ bindings: [] }]);
  assert.deepEqual(sourceCalls, []);
});

test('source and managed Packs without data-library declarations remain compatible', async t => {
  const directory = setup(t);
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const pack = sourcePack('fixture-a');
  for (const declaration of [undefined, []]) {
    const { results, sourceCalls } = readInstalled({
      domains: ['fixture-a'],
      packs: [{ ...pack, dataLibraries: declaration }],
      // Legacy Packs need no model directory resolution at all.
    });
    assert.deepEqual(results, [{ bindings: [] }]);
    assert.deepEqual(sourceCalls, []);
  }
  const store = path.join(directory, 'store');
  await installBundle(source, store, 'fixture-a');
  assert.deepEqual(readInstalled({ store, domains: ['fixture-a'] }).results, [{ bindings: [] }]);
});
