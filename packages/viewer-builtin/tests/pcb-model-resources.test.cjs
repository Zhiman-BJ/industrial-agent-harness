const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { KiCadRuntimeManager } = require('../src/kicad/runtime.cjs');
const { MODEL_LIMITS } = require('../src/kicad/model-resources.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t, refs) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-model-resources-')));
  const manager = new KiCadRuntimeManager();
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
  return { root, board, write, open, request };
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
  assert.equal((await f.request(view, 'models/0')).status, 404);
  assert.equal((await f.request(next, 'models/0')).status, 200);
});
