const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { KiCadRuntimeManager } = require('../src/kicad/runtime.cjs');

// Harness-authored transfer-contract bytes, with no component geometry. These
// are neither an official KiCad asset/checksum nor GPU/engineering evidence.
const STEP_BYTES = Buffer.from(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Harness transport contract fixture'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);
const CONTRACT_LICENSE = {
  spdx: 'MIT',
  url: 'test-fixture://transport-contract-license',
  notice: 'Harness-authored transfer contract fixture; not an official KiCad model.',
  exception: 'No additional exception for these Harness-authored test bytes.',
};
const SOURCE_REF = '${KICAD10_3DMODEL_DIR}/HarnessContract.3dshapes/transfer-only.step';
const BOARD = `(kicad_pcb (version 20241229) (generator harness_contract_fixture)
  (footprint "HarnessTransferContract" (layer "F.Cu") (at 10 10)
    (uuid "90c31943-d012-4678-a13d-342470f64eb7")
    (model "${SOURCE_REF}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))))`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

function setup(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-model-contract-')));
  const root = path.join(temporary, 'project');
  const cache = path.join(temporary, 'test-data-library-cache');
  fs.mkdirSync(root);
  fs.mkdirSync(cache);
  const source = path.join(root, 'transfer-only.kicad_pcb');
  const cachedFile = path.join(cache, 'transfer-only.step');
  fs.writeFileSync(source, BOARD);
  const calls = { resolve: [], plan: [], ensure: [], ensureOptions: [], fetch: [] };
  const hooks = {};
  const metadata = {
    sourceRef: SOURCE_REF,
    sha256: digest(STEP_BYTES),
    size: STEP_BYTES.length,
    libraryId: 'harness-transfer-contract',
    version: 'test-only-1',
  };
  const summary = () => ({
    libraries: [
      {
        id: metadata.libraryId,
        version: metadata.version,
        label: 'Harness transport contract fixture',
        origin: 'Harness-authored test bytes, not official KiCad',
        catalogSha256: digest('Harness-authored transport fixture catalog'),
        revision: 'test-only-1',
        license: structuredClone(CONTRACT_LICENSE),
        ...structuredClone(hooks.libraryMetadata || {}),
      },
    ],
  });
  const provider = {
    async resolve(request) {
      calls.resolve.push(request);
      return {
        resources:
          request.references.includes(SOURCE_REF) && fs.existsSync(cachedFile)
            ? [{ ...metadata, root: cache, path: cachedFile }]
            : [],
        summary: summary(),
      };
    },
    async plan(request) {
      calls.plan.push(request);
      return {
        resources: request.references.includes(SOURCE_REF) ? [{ ...metadata, cached: false }] : [],
        summary: summary(),
      };
    },
    async ensure(request, options) {
      calls.ensure.push(request);
      calls.ensureOptions.push(options);
      options.onProgress?.({ phase: 'downloading', bytes: 0 });
      await hooks.beforeDownload?.(request, options);
      // This injected fetch has no external I/O. Its own checksum is above;
      // no official URL or official checksum is replaced to make tests pass.
      calls.fetch.push('test-fixture://transfer-only.step');
      const response = new Response(STEP_BYTES);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(digest(bytes), metadata.sha256);
      fs.writeFileSync(cachedFile, bytes);
      options.onProgress?.({ phase: 'ready', bytes: bytes.length });
    },
  };
  const manager = new KiCadRuntimeManager({ modelProvider: provider });
  t.after(() => {
    manager.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return {
    manager,
    provider,
    calls,
    hooks,
    root,
    source,
    cache,
    cachedFile,
    metadata,
    open: () => manager.open(source, digest(fs.readFileSync(source)), root),
    response: (view, resource = 'manifest.json') =>
      manager.handle(new Request(view.url.replace('index.html', resource))),
  };
}

test('fixed STEP-reference contract plans without fetching and acquires only on explicit preparation', async t => {
  const f = setup(t);
  const original = fs.readFileSync(f.source);
  const view = await f.open();
  assert.equal(view.modelDownloads.downloadFiles, 1);
  assert.equal(view.modelDownloads.downloadBytes, STEP_BYTES.length);
  assert.equal(f.calls.ensure.length, 0);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(fs.existsSync(f.cachedFile), false);
  assert.deepEqual(f.calls.plan[0].references, [SOURCE_REF]);
  assert.equal(f.calls.plan[0].sha256, digest(original));
  assert.equal(f.calls.plan[0].root, f.root);
  assert.equal((await (await f.response(view)).json()).models[0].status, 'missing');

  const progress = [];
  const result = await f.manager.prepareModels(view.token, {
    onProgress: value => progress.push(value),
  });
  assert.equal(result.token, view.token);
  assert.equal(result.modelDownloads.downloadFiles, 0);
  assert.equal(f.calls.ensure.length, 1);
  assert.deepEqual(f.calls.ensure[0].references, [SOURCE_REF]);
  assert.deepEqual(f.calls.ensureOptions[0].expectedLibraries[0].license, CONTRACT_LICENSE);
  assert.equal(f.calls.fetch.length, 1);
  assert.ok(progress.some(item => item.phase === 'downloading'));
  const manifest = await (await f.response(view)).json();
  assert.equal(manifest.models[0].status, 'ready');
  assert.equal(manifest.models[0].sha256, digest(STEP_BYTES));
  assert.equal(manifest.models[0].libraryId, f.metadata.libraryId);
  const bytes = Buffer.from(await (await f.response(view, 'models/0')).arrayBuffer());
  assert.deepEqual(bytes, STEP_BYTES);
  assert.deepEqual(fs.readFileSync(f.source), original);

  const warm = await f.open();
  assert.equal(warm.modelDownloads.downloadFiles, 0);
  assert.equal((await (await f.response(warm)).json()).models[0].status, 'ready');
  assert.equal(f.calls.ensure.length, 1);
  assert.equal(f.calls.fetch.length, 1, 'opening with verified cache causes no new acquisition');
});

test('project-local STEP takes priority over a different approved cache model', async t => {
  const f = setup(t);
  fs.writeFileSync(f.cachedFile, STEP_BYTES);
  const local = path.join(f.root, '3dmodels/HarnessContract.3dshapes/transfer-only.step');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const localBytes = Buffer.from(
    'Harness-authored local transport fixture, not a renderable model',
  );
  fs.writeFileSync(local, localBytes);
  const view = await f.open();
  assert.equal(view.modelDownloads.downloadFiles, 0);
  assert.equal(f.calls.resolve.length, 0, 'fully local models require no provider lookup');
  assert.equal(f.calls.plan.length, 0);
  await f.manager.prepareModels(view.token);
  assert.equal(f.calls.ensure.length, 0);
  assert.equal(f.calls.fetch.length, 0);
  const manifest = await (await f.response(view)).json();
  assert.equal(manifest.models[0].sha256, digest(localBytes));
  assert.equal(manifest.models[0].libraryId, undefined);
});

test('cancelled preparation cannot publish late results or progress even when the provider ignores abort', async t => {
  const f = setup(t),
    entered = deferred(),
    release = deferred();
  f.hooks.beforeDownload = async () => {
    entered.resolve();
    await release.promise;
  };
  const view = await f.open();
  const controller = new AbortController(),
    progress = [];
  const pending = f.manager.prepareModels(view.token, {
    signal: controller.signal,
    onProgress: value => progress.push(value.phase),
  });
  await entered.promise;
  await assert.rejects(f.manager.prepareModels(view.token), /already being prepared/);
  controller.abort();
  release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(progress, ['downloading'], 'late ready progress is suppressed');
  assert.equal((await (await f.response(view)).json()).models[0].status, 'missing');
  const retried = await f.manager.prepareModels(view.token);
  assert.equal(retried.modelDownloads.downloadFiles, 0);
  assert.equal((await (await f.response(view)).json()).models[0].status, 'ready');
});

test('a changed board snapshot rejects in-flight model attachment and requires reopening', async t => {
  const f = setup(t),
    entered = deferred(),
    release = deferred();
  f.hooks.beforeDownload = async () => {
    entered.resolve();
    await release.promise;
  };
  const view = await f.open();
  const pending = f.manager.prepareModels(view.token);
  await entered.promise;
  fs.appendFileSync(f.source, '\n');
  release.resolve();
  await assert.rejects(pending, /source changed/);
  assert.equal((await f.response(view)).status, 409);
  await assert.rejects(f.manager.prepareModels(view.token), /source changed/);
  const fresh = await f.open();
  assert.equal((await (await f.response(fresh)).json()).models[0].status, 'ready');
});

test('closing one retained view prevents ignored-abort downloads from reviving its session', async t => {
  const f = setup(t),
    entered = deferred(),
    release = deferred();
  f.hooks.beforeDownload = async () => {
    entered.resolve();
    await release.promise;
  };
  const previous = await f.open();
  const pending = f.manager.prepareModels(previous.token);
  await entered.promise;
  const current = await f.open();
  f.manager.close(previous.token);
  release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await f.response(previous)).status, 404);
  assert.equal((await (await f.response(current)).json()).models[0].status, 'missing');
  assert.notEqual(current.token, previous.token);
});

test('a failed provider transfer leaves preparation retryable without publishing a ready model', async t => {
  const f = setup(t);
  f.hooks.beforeDownload = () => {
    throw Error('Harness fixture transfer failed');
  };
  const view = await f.open();
  await assert.rejects(f.manager.prepareModels(view.token), /fixture transfer failed/);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal((await (await f.response(view)).json()).models[0].status, 'missing');
  delete f.hooks.beforeDownload;
  await f.manager.prepareModels(view.token);
  assert.equal(f.calls.ensure.length, 2);
  assert.deepEqual(f.calls.ensureOptions[1].expectedLibraries[0].license, CONTRACT_LICENSE);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal((await (await f.response(view)).json()).models[0].status, 'ready');
});

function writeContractBoard(f, references) {
  fs.writeFileSync(
    f.source,
    `(kicad_pcb (version 20241229) (generator harness_contract_fixture)
    (footprint "HarnessTransferContract" (layer "F.Cu") (at 10 10)
      (uuid "90c31943-d012-4678-a13d-342470f64eb7")
      ${references.map(reference => `(model "${reference}")`).join('\n')}))`,
  );
}

test('local unique models consume the same file budget as planned external downloads', async t => {
  const f = setup(t);
  const localReferences = Array.from({ length: 64 }, (_, index) => `models/contract-${index}.step`);
  fs.mkdirSync(path.join(f.root, 'models'));
  for (const [index, reference] of localReferences.entries())
    fs.writeFileSync(
      path.join(f.root, reference),
      `Harness-authored unique transfer-only local fixture ${index}`,
    );
  writeContractBoard(f, [...localReferences, SOURCE_REF]);
  const view = await f.open();
  assert.equal(f.calls.plan.length, 1);
  assert.deepEqual(
    f.calls.plan[0].references,
    [SOURCE_REF],
    'the missing model is offered by the provider',
  );
  assert.equal(
    view.modelDownloads.downloadFiles,
    0,
    '64 existing unique local models exhaust the shared budget',
  );
  assert.equal(
    view.modelDownloads.unavailableFiles,
    1,
    'the excluded external model remains visible as unavailable',
  );
  const manifest = await (await f.response(view)).json();
  assert.equal(manifest.models.filter(model => model.status === 'ready').length, 64);
  assert.equal(manifest.models.length, 65);
  assert.equal(manifest.models.at(-1).status, 'missing');
  await f.manager.prepareModels(view.token);
  assert.equal(f.calls.ensure.length, 0, 'budget-excluded references never reach acquisition');
  assert.equal(f.calls.fetch.length, 0);
  assert.equal((await (await f.response(view)).json()).modelDownloads.unavailableFiles, 1);
});

test('more than 256 source references stay counted as unavailable while provider requests remain bounded', async t => {
  const f = setup(t);
  const references = [
    SOURCE_REF,
    ...Array.from(
      { length: 256 },
      (_, index) => '${KICAD10_3DMODEL_DIR}/HarnessContract.3dshapes/unmatched-' + index + '.step',
    ),
  ];
  writeContractBoard(f, references);
  const view = await f.open();
  assert.equal(references.length, 257);
  assert.ok(f.calls.resolve.length > 0 && f.calls.plan.length > 0);
  for (const request of [...f.calls.resolve, ...f.calls.plan])
    assert.ok(
      request.references.length <= 256,
      'provider input stays bounded independently of source inventory',
    );
  assert.equal(f.calls.resolve[0].references.length, 256);
  assert.equal(view.modelDownloads.downloadFiles, 1);
  assert.equal(
    view.modelDownloads.unavailableFiles,
    256,
    'the 257th reference is not silently discarded',
  );
  const before = await (await f.response(view)).json();
  assert.equal(before.models.length, 256, 'the exposed resource list is bounded');
  assert.equal(before.modelDownloads.unavailableFiles, 256);
  await f.manager.prepareModels(view.token);
  assert.deepEqual(f.calls.ensure[0].references, [SOURCE_REF]);
  const after = await (await f.response(view)).json();
  assert.equal(after.models.filter(model => model.status === 'ready').length, 1);
  assert.equal(after.modelDownloads.downloadFiles, 0);
  assert.equal(
    after.modelDownloads.unavailableFiles,
    256,
    'warm content does not erase overflow or unmatched references',
  );
});

test('retained A-B-A views can prepare independently and closing B preserves A', async t => {
  const f = setup(t);
  const a = await f.open();
  const second = path.join(f.root, 'second-contract.kicad_pcb');
  fs.writeFileSync(second, BOARD.replace('HarnessTransferContract', 'SecondTransferContract'));
  const b = await f.manager.open(second, digest(fs.readFileSync(second)), f.root);
  assert.notEqual(a.token, b.token);
  assert.equal((await f.response(a)).status, 200, 'opening B does not expire retained A');
  assert.equal((await f.response(b)).status, 200);
  await f.manager.prepareModels(a.token);
  assert.equal((await (await f.response(a)).json()).models[0].status, 'ready');
  assert.equal(
    (await (await f.response(b)).json()).models[0].status,
    'missing',
    'preparing A does not silently replace B snapshot',
  );
  await f.manager.prepareModels(b.token);
  assert.equal((await (await f.response(b)).json()).models[0].status, 'ready');
  assert.equal(f.calls.ensure.length, 1, 'B explicitly resolves the cache prepared by A');
  f.manager.close(b.token);
  assert.equal((await f.response(b)).status, 404);
  assert.equal((await f.response(a)).status, 200);
  await f.manager.prepareModels(a.token);
  assert.equal(f.calls.ensure.length, 1, 'retained A remains usable after closing B');
});

test('changing catalog identity requires reopening even when the model checksum is unchanged', async t => {
  const changes = {
    catalogSha256: digest('Harness-authored replacement catalog'),
    revision: 'replacement-test-revision',
    license: { spdx: 'MIT', url: 'test-fixture://replacement-license' },
    origin: 'Harness-authored replacement origin',
    label: 'Replacement transport fixture catalog',
  };
  for (const [field, replacement] of Object.entries(changes)) {
    await t.test(field, async t => {
      const f = setup(t);
      f.hooks.libraryMetadata = {
        catalogSha256: digest('Harness-authored initial catalog'),
        revision: 'initial-test-revision',
        license: { spdx: 'MIT', url: 'test-fixture://initial-license' },
        origin: 'Harness-authored initial origin',
        label: 'Initial transport fixture catalog',
      };
      const view = await f.open();
      const modelChecksum = f.metadata.sha256;
      f.hooks.libraryMetadata = { ...f.hooks.libraryMetadata, [field]: replacement };
      await assert.rejects(f.manager.prepareModels(view.token), {
        message: 'Component model download plan changed. Reopen the document.',
      });
      assert.equal(
        f.metadata.sha256,
        modelChecksum,
        'catalog identity is independent of model bytes',
      );
      assert.equal(f.calls.ensure.length, 0, 'changed catalog is rejected before acquisition');
      assert.equal(f.calls.fetch.length, 0);
      assert.equal((await (await f.response(view)).json()).models[0].status, 'missing');
    });
  }
});
