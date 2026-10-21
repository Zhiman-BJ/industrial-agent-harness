const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PackManager, createArchive, digest } = require('../../pack-manager/src/index.cjs');

const installed = path.join(__dirname, 'installed.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-python-viewer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function declaration(id = 'fixture-python') {
  return {
    id,
    label: 'Fixture viewer',
    version: '1.0.0',
    purpose: 'viewer',
    viewer: 'drawing',
    environment: 'INDUSTRIAL_HARNESS_FIXTURE_PYTHON',
    pythonVersion: '3.12.15',
    modules: ['fixture'],
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
            name: 'fixture',
            version: '1.0.0',
            filename: 'fixture-1.0.0-py3-none-any.whl',
            url: 'https://official.example/fixture.whl',
            sha256: 'b'.repeat(64),
            size: 10,
          },
        ],
        installedSize: 1024,
      },
    },
  };
}
function read(config) {
  const env = { ...process.env };
  delete env.INDUSTRIAL_HARNESS_PACK_STORE;
  if (config.store) env.INDUSTRIAL_HARNESS_PACK_STORE = config.store;
  // Discovery overrides and a project-selected executable are not authority.
  env.INDUSTRIAL_HARNESS_FIXTURE_PYTHON = process.execPath;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const config = JSON.parse(fs.readFileSync(0, 'utf8'));
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '@zhiman-bj/industrial-domain-packs') return { consumerMetadata: () => ({capabilities: [], skills: [], domains: []}) };
      if (request === './packs.cjs' && path.dirname(parent.filename) === path.dirname(config.installed))
        return { loadDomainPacks: () => config.packs || [] };
      if (request === './distribution.cjs' && path.dirname(parent.filename) === path.dirname(config.installed))
        return { distributionDomain: config.distributionDomain || null };
      return original.call(this, request, parent, isMain);
    };
    const api = require(config.installed);
    global.fetch = () => { throw Error('Resolution must stay offline'); };
    const results = config.domains.map(domain => ({ declarations: api.installedPythonEnvironments(domain),
      resolved: api.resolveViewerPython(domain, 'drawing') || null }));
    process.stdout.write(JSON.stringify(results));
  `,
    ],
    { env, encoding: 'utf8', input: JSON.stringify({ ...config, installed }), timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

test('source Viewer Python declarations require the active domain and respect the distribution binding', t => {
  setup(t);
  const a = declaration(),
    b = declaration('unrelated-python');
  const packs = [
    { domain: 'alpha', pythonEnvironments: [a] },
    { domain: 'beta', pythonEnvironments: [b] },
  ];
  const result = read({ packs, domains: [null, '', ' ', 'unknown', 'alpha'] });
  assert.deepEqual(result.slice(0, 4), Array(4).fill({ declarations: [], resolved: null }));
  assert.deepEqual(result[4], { declarations: [a], resolved: null });
  assert.deepEqual(read({ packs, domains: ['alpha'], distributionDomain: 'beta' }), [
    { declarations: [], resolved: null },
  ]);
});

test('managed Viewer Python comes only from the integrity-checked installed Pack', async t => {
  const root = setup(t),
    store = path.join(root, 'store'),
    source = path.join(root, 'pack');
  fs.mkdirSync(source);
  const asset = declaration();
  const bundle = {
    schemaVersion: 1,
    domain: 'alpha',
    version: '1.0.0',
    coreApi: 1,
    label: 'Fixture',
    emoji: '',
    capabilities: [],
    skills: [],
    providerPacks: [],
    pythonEnvironments: [asset],
  };
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  const bytes = createArchive(source),
    manager = new PackManager({ directory: store });
  await manager.install(
    {
      domain: bundle.domain,
      version: bundle.version,
      sha256: digest(bytes),
      size: bytes.length,
      platforms: [`${process.platform}-${process.arch}`],
      pythonEnvironments: [asset],
    },
    { bytes, allowUnsigned: true },
  );
  assert.deepEqual(
    read({
      store,
      domains: ['alpha', 'beta'],
      packs: [{ domain: 'alpha', pythonEnvironments: [declaration('override-python')] }],
    }),
    [
      { declarations: [asset], resolved: null },
      { declarations: [], resolved: null },
    ],
  );
  const location = manager.list()[0].location;
  bundle.pythonEnvironments[0].probe = 'print("untrusted replacement")';
  fs.writeFileSync(path.join(location, 'bundle.json'), JSON.stringify(bundle));
  assert.deepEqual(read({ store, domains: ['alpha'] }), [{ declarations: [], resolved: null }]);
});
