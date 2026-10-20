const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { KiCadRuntimeManager } = require('../src/kicad/runtime.cjs');
const { MODEL_LIMITS } = require('../src/kicad/model-resources.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t, refs, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-model-resources-')));
  const manager = new KiCadRuntimeManager(options);
  t.after(() => {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, bytes) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  const text =
    '(kicad_pcb (version 20240108) (footprint "test" ' +
    refs.map(ref => '(model ' + JSON.stringify(ref) + ')').join(' ') +
    '))';
  const board = write('board.kicad_pcb', text);
  const open = () => manager.open(board, hash(text), root);
  const request = (view, resource) =>
    manager.handle(new Request(view.url.replace('index.html', resource)));
  return { root, board, write, open, request, manager };
}

test('only board-referenced project models are hash-bound and served through opaque URLs', async t => {
  const f = fixture(t, [
    '${KIPRJMOD}/models/resistor.step',
    '${KICAD10_3DMODEL_DIR}/DIP.3dshapes/DIP.wrl',
  ]);
  f.write('models/resistor.step', 'ISO-10303-21; source STEP');
  f.write('3dmodels/DIP.3dshapes/DIP.wrl', '#VRML V2.0 utf8\nShape {}');
  f.write('models/unreferenced.step', 'not disclosed');
  const view = await f.open();
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.equal(manifest.boardSha256, hash(fs.readFileSync(f.board)));
  assert.equal(manifest.models.length, 2);
  assert.deepEqual(
    manifest.models.map(entry => entry.status),
    ['ready', 'ready'],
  );
  assert.deepEqual(
    manifest.models.map(entry => entry.format),
    ['step', 'wrl'],
  );
  assert.equal(manifest.models[0].sha256, hash('ISO-10303-21; source STEP'));
  assert.equal(
    JSON.stringify(manifest).includes(f.root),
    false,
    'canonical host paths stay private',
  );
  assert.equal(
    await (await f.request(view, manifest.models[0].url)).text(),
    'ISO-10303-21; source STEP',
  );
  assert.equal((await f.request(view, 'models/unreferenced.step')).status, 404);
  assert.equal((await f.request(view, 'models/2')).status, 404);
  assert.equal((await f.request(view, 'models/00')).status, 404);
  const changed = f.write('models/resistor.step', 'changed STEP');
  assert.ok(changed);
  assert.equal((await f.request(view, 'models/0')).status, 409);
  assert.equal((await f.request(view, 'manifest.json')).status, 409);
});

test('missing and unsupported references keep 2D board access and explicit model status', async t => {
  const refs = [
    'missing.wrl',
    'https://example.com/part.step',
    '/etc/passwd',
    '../escape.step',
    '${SECRET}/part.step',
    'part.obj',
    'C:\\part.step',
  ];
  const f = fixture(t, refs);
  const view = await f.open();
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.equal(manifest.models.length, refs.length);
  assert.equal(manifest.models[0].status, 'missing');
  assert.equal(manifest.models[0].reason, 'missing-file');
  assert.ok(manifest.models.slice(1).every(entry => entry.status === 'unavailable'));
  assert.ok(manifest.models.every(entry => !entry.url && !entry.sha256));
  assert.equal((await f.request(view, 'source/0')).status, 200);
});

test('a symlink escaping the project and an oversized model are omitted before serving', async t => {
  const f = fixture(t, ['external.step', 'big.step']);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-model-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'secret.step');
  fs.writeFileSync(target, 'outside project');
  fs.symlinkSync(target, path.join(f.root, 'external.step'));
  const large = f.write('big.step', '');
  fs.truncateSync(large, MODEL_LIMITS.fileBytes + 1);
  const view = await f.open();
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.deepEqual(
    manifest.models.map(entry => entry.reason),
    ['outside-project', 'file-limit'],
  );
  assert.equal((await f.request(view, 'models/0')).status, 404);
  assert.equal((await f.request(view, 'models/1')).status, 404);
});

test('replaced model symlinks cannot serve a different snapshot or revive a stale session', async t => {
  const f = fixture(t, ['model.step']);
  f.write('first.step', 'same source bytes');
  f.write('second.step', 'same source bytes');
  fs.symlinkSync('first.step', path.join(f.root, 'model.step'));
  const view = await f.open();
  fs.unlinkSync(path.join(f.root, 'model.step'));
  fs.symlinkSync('second.step', path.join(f.root, 'model.step'));
  assert.equal((await f.request(view, 'models/0')).status, 409);
  const next = await f.open();
  f.manager.close(view.token);
  assert.equal((await f.request(view, 'models/0')).status, 404);
  assert.equal((await f.request(next, 'models/0')).status, 200);
});

function externalResource(t, sourceRef, contents = 'verified external STEP') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-model-cache-')));
  const file = path.join(root, 'cached.step');
  fs.writeFileSync(file, contents);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    sourceRef,
    path: file,
    root,
    sha256: hash(contents),
    size: Buffer.byteLength(contents),
    libraryId: 'test-models',
    version: 'test-1',
  };
}

test('host-approved cached resources bind exact references and provenance while local project models take priority', async t => {
  const localRef = '${KIPRJMOD}/models/local.step';
  const externalRef = '${KICAD10_3DMODEL_DIR}/Test.3dshapes/remote.step';
  const external = externalResource(t, externalRef);
  const calls = [];
  const f = fixture(t, [localRef, externalRef], {
    modelProvider: {
      resolve(context) {
        calls.push(context);
        return { resources: [external, { ...external, sourceRef: localRef }] };
      },
      plan() {
        throw Error('No download plan is needed for cached models.');
      },
      ensure() {
        throw Error('Opening a board never downloads models.');
      },
    },
  });
  f.write('models/local.step', 'project-local model');
  const view = await f.open();
  assert.deepEqual(calls[0].references, [externalRef]);
  assert.equal(calls[0].sha256, hash(fs.readFileSync(f.board)));
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.deepEqual(
    manifest.models.map(entry => entry.status),
    ['ready', 'ready'],
  );
  assert.equal(await (await f.request(view, 'models/0')).text(), 'project-local model');
  assert.equal(await (await f.request(view, 'models/1')).text(), 'verified external STEP');
  assert.equal(manifest.models[1].libraryId, 'test-models');
  assert.equal(manifest.models[1].version, 'test-1');
  assert.ok(!JSON.stringify(manifest).includes(external.root));
  assert.ok(!JSON.stringify(manifest).includes(f.root));
  fs.writeFileSync(external.path, 'tampered external STEP');
  assert.equal((await f.request(view, 'models/1')).status, 409);
  assert.equal((await f.request(view, 'manifest.json')).status, 409);
});

test('external resources reject wrong hashes, sizes and cache-root escapes without exposing host paths', async t => {
  for (const failure of ['hash', 'size', 'root']) {
    const ref = `models/${failure}.step`;
    const resource = externalResource(t, ref);
    if (failure === 'hash') resource.sha256 = '0'.repeat(64);
    if (failure === 'size') resource.size++;
    if (failure === 'root') {
      resource.root = path.join(resource.root, 'allowed');
      fs.mkdirSync(resource.root);
    }
    const f = fixture(t, [ref], { modelProvider: { resolve: () => ({ resources: [resource] }) } });
    const view = await f.open();
    const manifest = await (await f.request(view, 'manifest.json')).json();
    assert.equal(manifest.models[0].status, 'unavailable');
    assert.equal((await f.request(view, 'models/0')).status, 404);
    assert.ok(!JSON.stringify(manifest).includes(resource.path));
    assert.equal((await f.request(view, 'source/0')).status, 200);
  }
});

test('cached model symlink retargeting is rejected even when the new file has the same bytes', async t => {
  const ref = 'missing.step';
  const resource = externalResource(t, ref);
  const original = resource.path;
  const target = path.join(resource.root, 'same-bytes.step');
  fs.copyFileSync(original, target);
  const link = path.join(resource.root, 'model.step');
  fs.symlinkSync(original, link);
  resource.path = link;
  const f = fixture(t, [ref], { modelProvider: { resolve: () => ({ resources: [resource] }) } });
  const view = await f.open();
  assert.equal((await f.request(view, 'models/0')).status, 200);
  fs.unlinkSync(link);
  fs.symlinkSync(target, link);
  assert.equal((await f.request(view, 'models/0')).status, 409);
});

test('a cached STEP is never substituted by changing an unmatched source WRL extension', async t => {
  const ref = '${KICAD8_3DMODEL_DIR}/Test.3dshapes/part.wrl';
  const resource = externalResource(t, ref.replace('.wrl', '.step'));
  const f = fixture(t, [ref], { modelProvider: { resolve: () => ({ resources: [resource] }) } });
  const view = await f.open();
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.equal(manifest.models[0].sourceRef, ref);
  assert.equal(manifest.models[0].status, 'missing');
  assert.equal((await f.request(view, 'models/0')).status, 404);
});

test('content-addressed cache files without extensions retain their exact referenced parser format', async t => {
  for (const [suffix, format] of [
    ['step', 'step'],
    ['wrl', 'wrl'],
  ]) {
    const ref = '${KICAD10_3DMODEL_DIR}/Test.3dshapes/part.' + suffix;
    const resource = externalResource(
      t,
      ref,
      suffix === 'wrl' ? '#VRML V2.0 utf8\nShape {}' : 'ISO-10303-21; test cache',
    );
    const cached = path.join(resource.root, resource.sha256);
    fs.renameSync(resource.path, cached);
    resource.path = cached;
    resource.catalogPath = 'Test.3dshapes/part.' + suffix;
    const f = fixture(t, [ref], { modelProvider: { resolve: () => ({ resources: [resource] }) } });
    const view = await f.open();
    const manifest = await (await f.request(view, 'manifest.json')).json();
    assert.equal(manifest.models[0].status, 'ready');
    assert.equal(manifest.models[0].format, format);
    assert.equal((await f.request(view, 'models/0')).status, 200);
  }
});

test('external cached resources share the same unique-file budget as project-local models', async t => {
  const refs = Array.from(
    { length: MODEL_LIMITS.files },
    (_, index) => `models/local-${index}.step`,
  );
  const external = externalResource(t, 'remote.step');
  const f = fixture(t, [...refs, external.sourceRef], {
    modelProvider: { resolve: () => ({ resources: [external] }) },
  });
  for (let index = 0; index < refs.length; index++)
    f.write(refs[index], `unique local source ${index}`);
  const view = await f.open();
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.equal(
    manifest.models.filter(entry => entry.status === 'ready').length,
    MODEL_LIMITS.files,
  );
  assert.equal(manifest.models.at(-1).status, 'unavailable');
  assert.equal(manifest.models.at(-1).reason, 'total-limit');
  assert.equal(view.modelDownloads.unavailableFiles, 1);
});
