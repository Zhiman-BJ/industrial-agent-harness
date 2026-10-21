const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  DataLibraryManager,
  DataLibraryRegistry,
  readDataLibraryBindings,
  validateDataLibraries,
  PackManager,
  createArchive,
  decodeArchive,
  digest,
} = require('./index.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-library-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const context = {
    root: project,
    source: path.join(project, 'board.file'),
    sha256: 'a'.repeat(64),
  };
  return { root, context };
}
function binding(id, prefix, contents = { 'Family/Body.step': Buffer.from('model bytes') }) {
  const library = {
    id,
    version: '1.0.0',
    label: id,
    baseUrl: `https://models.example/${id}/fixed/`,
    catalog: `resources/${id}.json`,
    referencePrefixes: [prefix],
  };
  const catalog = {
    schemaVersion: 1,
    id,
    version: library.version,
    baseUrl: library.baseUrl,
    source: { revision: 'b'.repeat(40) },
    license: { spdx: 'CC-BY-SA-4.0', url: 'https://models.example/license' },
    files: Object.entries(contents).map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: hash(bytes),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(catalog));
  library.catalogSha256 = hash(bytes);
  return { library, catalog, bytes, contents };
}
function writeBinding(root, item) {
  const file = path.join(root, item.library.catalog);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, item.bytes);
  return file;
}

test('schema 2 API catalogs survive verified archive decoding and explicit registry acquisition', async t => {
  const { root, context } = fixture(t);
  const item = binding('api-models', '${API}/');
  item.library.baseUrl = 'https://models.example/api/v4/';
  item.library.download = {
    type: 'gitlab-repository-files',
    project: 'public/models',
    ref: 'b'.repeat(40),
  };
  Object.assign(item.catalog, {
    schemaVersion: 2,
    baseUrl: item.library.baseUrl,
    download: { ...item.library.download },
  });
  item.bytes = Buffer.from(JSON.stringify(item.catalog));
  item.library.catalogSha256 = hash(item.bytes);
  const source = path.join(root, 'source');
  writeBinding(source, item);
  fs.writeFileSync(
    path.join(source, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      domain: 'sample',
      version: '1.0.0',
      coreApi: 1,
      label: 'Sample',
      emoji: '',
      capabilities: [],
      skills: [],
      providerPacks: [],
      dataLibraries: [item.library],
    }),
  );
  assert.deepEqual(
    decodeArchive(createArchive(source)).bundle.dataLibraries[0].download,
    item.library.download,
  );
  const bindings = readDataLibraryBindings([item.library], { directory: source });
  const calls = [];
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async url => {
      calls.push(url);
      return new Response(item.contents['Family/Body.step']);
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => bindings });
  const request = { ...context, references: ['${API}/Family/Body.step'] };
  const approved = registry.plan(request);
  assert.equal(calls.length, 0);
  const result = await registry.ensure(request, {
    expectedResources: approved.resources,
    expectedLibraries: approved.summary.libraries,
  });
  assert.equal(result.resources.length, 1);
  assert.deepEqual(calls, [
    'https://models.example/api/v4/projects/public%2Fmodels/repository/files/Family%2FBody.step/raw?ref=' +
      'b'.repeat(40),
  ]);
});

test('catalog bytes are digest-bound and ordinary files inside the trusted owner', t => {
  const { root } = fixture(t);
  const item = binding('models', '${LIB}/');
  const file = writeBinding(root, item);
  const resolved = readDataLibraryBindings([item.library], { directory: root });
  assert.deepEqual(resolved[0].catalog, item.catalog);
  assert.deepEqual(
    readDataLibraryBindings([item.library], {
      files: [{ path: item.library.catalog, bytes: item.bytes }],
    }),
    resolved,
  );
  fs.appendFileSync(file, ' ');
  assert.throws(() => readDataLibraryBindings([item.library], { directory: root }), /digest/);
  assert.throws(() => readDataLibraryBindings([item.library], { files: [] }), /missing/);
  fs.rmSync(file);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, item.bytes);
  fs.symlinkSync(outside, file);
  assert.throws(() => readDataLibraryBindings([item.library], { directory: root }), /symbolic/);
  assert.throws(
    () => validateDataLibraries([{ ...item.library, catalog: '../outside.json' }]),
    /Unsafe/,
  );
});

test('resolve and plan stay offline; explicit ensure downloads exact catalog paths and reuses content', async t => {
  const { root, context } = fixture(t);
  const item = binding('models', '${LIB}/');
  item.library.referencePrefixes.push('${ALIAS}/');
  const requests = [];
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async url => {
      requests.push(url);
      return new Response(item.contents['Family/Body.step']);
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [item] });
  const request = {
    ...context,
    references: [
      '${LIB}/Family/Body.step',
      '${ALIAS}/Family/Body.step',
      '${LIB}/Family/Body.wrl',
      './local.step',
    ],
  };
  const plan = registry.plan(request);
  assert.equal(plan.resources.length, 2);
  assert.equal(plan.resources[0].cached, false);
  assert.equal(plan.resources[0].path, undefined);
  assert.equal(plan.summary.downloadFiles, 1);
  assert.equal(plan.summary.downloadBytes, item.contents['Family/Body.step'].length);
  assert.equal(plan.summary.unavailableFiles, 2);
  assert.equal(plan.summary.libraries[0].origin, 'https://models.example');
  assert.equal(plan.summary.libraries[0].license.spdx, 'CC-BY-SA-4.0');
  assert.deepEqual(registry.resolve(request).resources, []);
  assert.deepEqual(requests, []);
  const completed = await registry.ensure(request);
  assert.deepEqual(requests, ['https://models.example/models/fixed/Family/Body.step']);
  assert.equal(completed.resources.length, 2);
  assert.equal(completed.summary.downloadFiles, 0);
  assert.equal(completed.resources[0].root, manager.directory);
  assert.equal(completed.resources[0].path, completed.resources[1].path);
  assert.equal(path.basename(completed.resources[0].path), hash(item.contents['Family/Body.step']));
  await registry.ensure(request, { offline: true });
  assert.equal(requests.length, 1);
  fs.writeFileSync(completed.resources[0].path, 'corrupt');
  assert.equal(registry.resolve(request).resources.length, 0);
  await assert.rejects(registry.ensure(request, { offline: true }), /not cached/);
  assert.equal(requests.length, 1);
});

test('all libraries share one preview budget and unsupported entries are not downloaded', async t => {
  const { root, context } = fixture(t);
  const one = binding('one', '${ONE}/', { 'a.step': Buffer.from('aaaa') });
  const two = binding('two', '${TWO}/', {
    'b.step': Buffer.from('bbbb'),
    'large.step': Buffer.alloc(20),
  });
  let requests = 0;
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async () => {
      requests++;
      return new Response(Buffer.from('aaaa'));
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [one, two] });
  const request = {
    ...context,
    references: ['${ONE}/a.step', '${TWO}/b.step', '${TWO}/large.step'],
  };
  const options = { limits: { files: 1, fileBytes: 8, totalBytes: 8 } };
  const plan = registry.plan(request, options);
  assert.equal(plan.resources.length, 1);
  assert.equal(plan.summary.downloadBytes, 4);
  assert.equal(plan.summary.unavailableFiles, 2);
  assert.ok(plan.unavailable.every(entry => entry.reason === 'preview-budget'));
  const result = await registry.ensure(request, options);
  assert.equal(result.resources.length, 1);
  assert.equal(requests, 1);
  assert.throws(() => registry.plan(request, { limits: { files: 65 } }), /only reduce/);
});

test('different declared paths with identical bytes share the cache and count once', async t => {
  const { root, context } = fixture(t);
  const contents = Buffer.from('same');
  const one = binding('one', '${ONE}/', { 'a.step': contents, 'b.step': contents });
  const two = binding('two', '${TWO}/', { 'c.step': contents });
  let requests = 0;
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async () => {
      requests++;
      return new Response(contents);
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [one, two] });
  const request = { ...context, references: ['${ONE}/a.step', '${ONE}/b.step', '${TWO}/c.step'] };
  const plan = registry.plan(request, { limits: { files: 1 } });
  assert.equal(plan.resources.length, 3);
  assert.equal(plan.summary.downloadFiles, 1);
  assert.equal(plan.summary.downloadBytes, 4);
  const result = await registry.ensure(request, { limits: { files: 1 } });
  assert.equal(result.resources.length, 3);
  assert.equal(requests, 1);
});

test('a catalog switch after planning rejects the whole request before any download', async t => {
  const { root, context } = fixture(t);
  const one = binding('one', '${ONE}/');
  let two = binding('two', '${TWO}/');
  let requests = 0;
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async () => {
      requests++;
      throw Error('must not fetch');
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [one, two] });
  const request = {
    ...context,
    references: ['${ONE}/Family/Body.step', '${TWO}/Family/Body.step'],
  };
  const plan = registry.plan(request);
  const expected = {
    expectedResources: plan.resources,
    expectedLibraries: plan.summary.libraries,
  };
  two = binding('two', '${TWO}/', { 'Family/Body.step': Buffer.from('changed model') });
  await assert.rejects(registry.ensure(request, expected), {
    message: 'Component model download plan changed. Reopen the document.',
  });
  assert.equal(requests, 0);
  two = binding('two', '${TWO}/', { 'Family/Other.step': Buffer.from('other model') });
  await assert.rejects(registry.ensure(request, expected), /download plan changed/);
  assert.equal(requests, 0);
});

test('every displayed library identity field is bound before downloading', async t => {
  const changes = {
    catalogSha256: item => (item.library.catalogSha256 = 'c'.repeat(64)),
    revision: item => (item.catalog.source.revision = 'c'.repeat(40)),
    origin: item =>
      (item.library.baseUrl = item.catalog.baseUrl = 'https://other.example/models/fixed/'),
    license: item => (item.catalog.license.spdx = 'MIT'),
    label: item => (item.library.label = 'Changed label'),
    id: item => (item.library.id = item.catalog.id = 'changed'),
    version: item => (item.library.version = item.catalog.version = '2.0.0'),
    referencePrefix: item => (item.library.referencePrefixes = ['${OTHER}/']),
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async t => {
      const { root, context } = fixture(t);
      const item = binding('models', '${LIB}/');
      let requests = 0;
      const manager = new DataLibraryManager({
        directory: path.join(root, 'cache'),
        fetch: async () => {
          requests++;
          throw Error('must not fetch');
        },
      });
      const registry = new DataLibraryRegistry({ manager, libraries: () => [item] });
      const request = { ...context, references: ['${LIB}/Family/Body.step'] };
      const plan = registry.plan(request);
      change(item);
      await assert.rejects(
        registry.ensure(request, {
          expectedResources: plan.resources,
          expectedLibraries: plan.summary.libraries,
        }),
        { message: 'Component model download plan changed. Reopen the document.' },
      );
      assert.equal(requests, 0);
    });
  }
});

test('every requested model must match the expected resource metadata', async t => {
  const { root, context } = fixture(t);
  const item = binding('models', '${LIB}/');
  let requests = 0;
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async () => {
      requests++;
      throw Error('must not fetch');
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [item] });
  const request = { ...context, references: ['${LIB}/Family/Body.step'] };
  const plan = registry.plan(request);
  for (const [field, value] of Object.entries({
    sourceRef: '${LIB}/Family/Other.step',
    sha256: 'c'.repeat(64),
    size: plan.resources[0].size + 1,
    libraryId: 'other',
    version: '2.0.0',
  })) {
    await assert.rejects(
      registry.ensure(request, {
        expectedResources: [{ ...plan.resources[0], [field]: value }],
        expectedLibraries: plan.summary.libraries,
      }),
      /download plan changed/,
      field,
    );
  }
  for (const options of [
    { expectedResources: plan.resources },
    { expectedLibraries: plan.summary.libraries },
    { expectedResources: [], expectedLibraries: plan.summary.libraries },
    {
      expectedResources: [...plan.resources, ...plan.resources],
      expectedLibraries: plan.summary.libraries,
    },
    {
      expectedResources: plan.resources,
      expectedLibraries: [...plan.summary.libraries, ...plan.summary.libraries],
    },
  ]) {
    await assert.rejects(registry.ensure(request, options), /download plan changed/);
  }
  assert.equal(requests, 0);
});

test('an unchanged plan permits subset downloads, retries and verified offline cache reuse', async t => {
  const { root, context } = fixture(t);
  const one = binding('one', '${ONE}/');
  const two = binding('two', '${TWO}/', { 'Other.step': Buffer.from('other model') });
  let requests = 0;
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async () => {
      if (++requests === 1) throw Error('temporary failure');
      return new Response(one.contents['Family/Body.step']);
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [one, two] });
  const plan = registry.plan({
    ...context,
    references: ['${ONE}/Family/Body.step', '${TWO}/Other.step'],
  });
  const expected = {
    expectedResources: plan.resources,
    expectedLibraries: plan.summary.libraries.map(library => ({
      ...library,
      license: { url: library.license.url, spdx: library.license.spdx },
    })),
  };
  const request = { ...context, references: ['${ONE}/Family/Body.step'] };
  await assert.rejects(registry.ensure(request, expected), /temporary failure/);
  const result = await registry.ensure(request, expected);
  assert.equal(requests, 2);
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].cached, true);
  assert.equal(result.summary.downloadFiles, 0);
  const offline = await registry.ensure(request, { ...expected, offline: true });
  assert.deepEqual(offline, result);
  assert.equal(requests, 2);
});

test('ambiguous prefixes, traversal, stale context and pre-cancelled requests fail safely', async t => {
  const { root, context } = fixture(t);
  const item = binding('models', '${LIB}/');
  let requests = 0;
  const manager = new DataLibraryManager({
    directory: path.join(root, 'cache'),
    fetch: async () => {
      requests++;
      throw Error('must not fetch');
    },
  });
  const registry = new DataLibraryRegistry({ manager, libraries: () => [item] });
  const request = { ...context, references: ['${LIB}/../secret', '${LIB}/Family/Body.step'] };
  assert.equal(registry.plan(request).unavailable[0].reason, 'not-in-catalog');
  assert.throws(() => registry.plan({ ...request, source: path.join(root, 'outside') }), /context/);
  assert.throws(() => registry.plan({ ...request, sha256: 'changed' }), /context/);
  assert.throws(
    () =>
      validateDataLibraries([
        item.library,
        { ...item.library, id: 'other', referencePrefixes: ['${LIB}/Family/'] },
      ]),
    /ambiguous/,
  );
  const controller = new AbortController();
  controller.abort(Error('cancelled'));
  await assert.rejects(registry.ensure(request, { signal: controller.signal }), /cancelled/);
  assert.equal(requests, 0);
});

test('Pack decoding and installed scanning validate the optional catalog without preparing models', async t => {
  const { root } = fixture(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const item = binding('models', '${LIB}/');
  writeBinding(source, item);
  const bundle = {
    schemaVersion: 1,
    domain: 'sample',
    version: '1.0.0',
    coreApi: 1,
    label: 'Sample',
    emoji: '',
    capabilities: [],
    skills: [],
    providerPacks: [],
    dataLibraries: [item.library],
  };
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  const bytes = createArchive(source);
  assert.equal(
    decodeArchive(bytes).bundle.dataLibraries[0].catalogSha256,
    item.library.catalogSha256,
  );
  let requests = 0;
  const manager = new PackManager({
    directory: path.join(root, 'store'),
    dataLibraryOptions: {
      fetch: async () => {
        requests++;
        throw Error('must not fetch');
      },
    },
  });
  await manager.install(
    {
      domain: 'sample',
      version: '1.0.0',
      size: bytes.length,
      sha256: digest(bytes),
      platforms: [`${process.platform}-${process.arch}`],
    },
    { bytes, allowUnsigned: true },
  );
  assert.equal(requests, 0);
  assert.deepEqual(manager.runtimeStatus(manager.list()[0]), []);
  assert.equal(manager.list()[0].dataLibraries.length, 1);
  fs.writeFileSync(path.join(manager.list()[0].location, item.library.catalog), '{}');
  assert.deepEqual(manager.list(), []);
  assert.match(manager.scan().errors[0].message, /changed|digest/);
  fs.writeFileSync(path.join(source, item.library.catalog), '{}');
  assert.throws(() => createArchive(source), /digest/);
});
