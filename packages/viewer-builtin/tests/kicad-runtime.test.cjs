const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {KiCadRuntimeManager, isKiCadFile, inspectSource, limits} = require('../src/kicad/runtime.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const board = '(kicad_pcb (version 20211014) (generator pcbnew))';
const schematic = '(kicad_sch (version 20211123) (generator eeschema))';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kicad-'));
  const manager = new KiCadRuntimeManager();
  t.after(() => {manager.close(); fs.rmSync(root, {recursive: true, force: true});});
  const write = (name, content) => {const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, content); return file;};
  return {root, manager, write, open: file => manager.open(file, hash(fs.readFileSync(file)), root)};
}
const request = (manager, url) => manager.handle(new Request(url));

test('PCB and schematic files use KiCad; legacy files and project settings do not', () => {
  assert.ok(isKiCadFile('board.kicad_pcb'));
  assert.ok(isKiCadFile('sheet.kicad_sch'));
  for (const file of ['board.brd', 'sheet.sch', 'project.kicad_pro', 'file.html']) assert.equal(isKiCadFile(file), false);
});

test('real upstream KiCad geometry sources pass guards and are served unchanged', async t => {
  const {write, open, manager} = setup(t);
  for (const [name, type] of [['pads.kicad_pcb', 'board'], ['symbols.kicad_sch', 'schematic']]) {
    const data = fs.readFileSync(path.join(__dirname, '../fixtures/kicad', name));
    const view = await open(write(name, data));
    assert.equal(view.document, type);
    const response = await request(manager, view.url.replace('index.html', 'source/0'));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    const html = await request(manager, view.url);
    assert.match(html.headers.get('Content-Security-Policy'), /connect-src 'self'/);
    assert.doesNotMatch(await html.text(), /kicad_pcb|kicad_sch/);
  }
});

test('sheet hierarchy includes only referenced, bounded companions and rejects changes', async t => {
  const {write, open, manager} = setup(t);
  const root = write('main.kicad_sch', '(kicad_sch (version 20211123) (sheet (property "Sheetfile" "sub/child.kicad_sch")))');
  const child = write('sub/child.kicad_sch', schematic);
  write('unrelated.kicad_sch', schematic);
  const view = await open(root);
  const manifestUrl = view.url.replace('index.html', 'manifest.json');
  const manifest = await (await request(manager, manifestUrl)).json();
  assert.deepEqual(manifest.sources.map(item => item.name), ['main.kicad_sch', 'sub/child.kicad_sch']);
  assert.equal(manifest.sources[1].sha256, hash(schematic));
  fs.writeFileSync(child, schematic.replace('eeschema', 'changed'));
  assert.equal((await request(manager, manifestUrl)).status, 409);
  assert.equal((await request(manager, view.url.replace('index.html', 'source/0'))).status, 409);
});

test('source hash mismatch, missing sheets, path escape and symlink escape fail closed', async t => {
  const {root, write, open, manager} = setup(t);
  const file = write('board.kicad_pcb', board);
  await assert.rejects(manager.open(file, 'wrong', root), /changed/);
  const reference = name => write('main.kicad_sch', `(kicad_sch (version 20211123) (sheet (property "Sheetfile" "${name}")))`);
  await assert.rejects(open(reference('missing.kicad_sch')), /ENOENT/);
  await assert.rejects(open(reference('../outside.kicad_sch')), /outside/);
  await assert.rejects(open(reference('https://example.com/a.kicad_sch')), /Unsupported/);
  await assert.rejects(open(reference('main.kicad_sch')), /Cyclic/);
  fs.symlinkSync(__filename, path.join(root, 'external.kicad_sch'));
  await assert.rejects(open(reference('external.kicad_sch')), /outside/);
  await assert.rejects(manager.open(__filename, hash(fs.readFileSync(__filename)), root), /Choose/);
});

test('replaced companion symlink cannot substitute the original source', async t => {
  const {write, open, manager} = setup(t);
  const target = write('target.kicad_sch', schematic);
  const main = write('main.kicad_sch', '(kicad_sch (version 20211123) (sheet (property "Sheetfile" "child.kicad_sch")))');
  const child = write('child.kicad_sch', schematic);
  const view = await open(main);
  fs.unlinkSync(child); fs.symlinkSync(target, child);
  assert.equal((await request(manager, view.url)).status, 409);
});

test('sessions restrict methods, resources, origins and lifetime', async t => {
  const {write, open, manager} = setup(t);
  const file = write('board.kicad_pcb', board);
  const first = await open(file);
  assert.equal((await request(manager, first.url.replace('app://kicad', 'app://viewer'))).status, 403);
  assert.equal((await manager.handle(new Request(first.url, {method: 'POST'}))).status, 403);
  for (const resource of ['source/1', 'source/00', '%2e%2e%2fsecret', 'vendor/LICENSE.md', 'anything.js']) assert.equal((await request(manager, first.url.replace('index.html', resource))).status, 404);
  const second = await open(file);
  assert.equal((await request(manager, first.url)).status, 404);
  manager.close();
  assert.equal((await request(manager, second.url)).status, 404);
});

test('malformed, legacy, deep, oversized and excessive companion inputs are rejected', async t => {
  for (const value of ['()', '(kicad_pcb', '(kicad_pcb (version 20211014)) trailing', '(kicad_pcb (version 20211014) (text "unterminated))', '(kicad_sch (version 20211123))', '(kicad_pcb (version 20171130))']) assert.throws(() => inspectSource(value, '.kicad_pcb'));
  assert.throws(() => inspectSource('(kicad_pcb (version 20211014)' + '(x '.repeat(limits.depth) + ')'.repeat(limits.depth + 1), '.kicad_pcb'), /depth/);
  assert.throws(() => inspectSource('(kicad_pcb (version 20211014) (x ' + 'a '.repeat(limits.tokens) + '))', '.kicad_pcb'), /token/);
  const {write, open} = setup(t);
  const huge = write('huge.kicad_pcb', ''); fs.truncateSync(huge, limits.fileBytes + 1);
  await assert.rejects(open(huge), /file limit/);
  for (let index = 0; index <= limits.files; index++) write(`sheet${index}.kicad_sch`, `(kicad_sch (version 20211123) (sheet (property "Sheetfile" "sheet${index + 1}.kicad_sch")))`);
  await assert.rejects(open(path.join(path.dirname(huge), 'sheet0.kicad_sch')), /file count/);
});

test('vendored offline runtime and font match committed fingerprints', () => {
  const root = path.join(__dirname, '../src/kicad/vendor');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(hash(fs.readFileSync(path.join(root, name))), expected, name);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'kicanvas.js'), 'utf8'), /fonts\.googleapis\.com/);
});
