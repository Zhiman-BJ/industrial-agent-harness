const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createDocumentPlugins, parseDelimited, parseDocument, limits} = require('../src/documents/service.cjs');
const {createViewerRegistry} = require('../../viewer-core/src/registry.cjs');
const {createAssetPlugins} = require('../src/assets/service.cjs');
const {isYosysNetlist} = require('../src/netlist/netlist.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function setup(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'document-viewer-')));
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const plugins = createDocumentPlugins({projectRoot: () => root});
  function write(name, text) {const file = path.join(root, name); fs.writeFileSync(file, text); return file;}
  function open(name) {const file = path.join(root, name); const id = plugins.find(plugin => plugin.matches(file)).id; return plugins.find(plugin => plugin.id === id).open({file, artifact: {sha256: hash(file)}});}
  return {parent, root, plugins, write, open};
}

test('CSV and TSV preserve Unicode, quoted separators/newlines, escaped quotes, empty cells and numeric/formula strings', () => {
  const input = '\uFEFFname,id,note,formula\r\n中文,00001234567890123456789,"a,b\r\n""quoted""",=SUM(A1)\r\nlast,,,';
  const data = parseDelimited(input, ',');
  assert.deepEqual(data.rows, [['name', 'id', 'note', 'formula'], ['中文', '00001234567890123456789', 'a,b\r\n"quoted"', '=SUM(A1)'], ['last', '', '', '']]);
  assert.equal(data.columns, 4); assert.equal(data.ragged, false);
  assert.deepEqual(parseDelimited('a\tb\n"tab\tinside"\t2\n', '\t').rows, [['a', 'b'], ['tab\tinside', '2']]);
  assert.deepEqual(parseDelimited('', ',').rows, []);
  assert.deepEqual(parseDelimited('a,b\n\nc', ',').rows, [['a', 'b'], [''], ['c']]);
  assert.equal(parseDelimited('a,b\nc', ',').ragged, true);
});

test('malformed and excessive CSV produce a diagnostic without losing the original source', () => {
  for (const text of ['a,"unclosed', 'a,plain"quote', '"a"tail,b']) {
    const data = parseDocument('table', text, '.csv');
    assert.ok(data.error); assert.equal(data.text, text); assert.equal(data.rows, undefined);
  }
  assert.throws(() => parseDelimited(Array(257).fill('x').join(','), ','), /column/);
  assert.throws(() => parseDelimited('x\n'.repeat(limits.rows + 1), ','), /row limit/);
  assert.throws(() => parseDelimited(`${Array(256).fill('x').join(',')}\n`.repeat(1000), ','), /cell limit/);
});

test('JSON/JSON Lines check structure, retain source, mark numeric precision, and identify failing line', () => {
  const text = '\uFEFF{"__proto__":{"polluted":true},"id":9007199254740993,"items":[false,null,"中文"]}';
  const data = parseDocument('json', text, '.json');
  assert.equal(data.error, undefined); assert.ok(data.warning); assert.equal(data.text, text); assert.equal({}.polluted, undefined);
  for (const value of ['null', 'false', '[]', '1', '"hello"']) assert.equal(parseDocument('json', value).error, undefined);
  assert.ok(parseDocument('json', '{bad}').error);
  assert.match(parseDocument('json', '['.repeat(66) + '0' + ']'.repeat(66)).error, /depth/);
  assert.match(parseDocument('json', JSON.stringify(Array(100001).fill(0))).error, /node/);
  assert.equal(parseDocument('jsonl', '\uFEFF{"ok":true}\r\n\n[1,2]\nnull\n').records, 3);
  const invalid = parseDocument('jsonl', '{"ok":true}\n\n{bad}\n');
  assert.match(invalid.error, /Line 3/); assert.equal(invalid.records, undefined, 'never present partial records as complete');
});

test('generic plugins read project-bound snapshots without a domain, preserving BOM and content hash', t => {
  const {write, open} = setup(t);
  for (const [name, text, kind] of [['table.CSV', 'a,b\n1,2', 'table'], ['table.tsv', 'a\tb', 'table'], ['data.json', '{"a":1}', 'json'], ['run.jsonl', '{}\n', 'jsonl'], ['run.ndjson', '[]\n', 'jsonl'], ['README.md', '# Hi', 'markdown'], ['guide.markdown', '## Hi', 'markdown'], ['run.log', '\uFEFFhello\r\n中文', 'text'], ['notes.txt', 'hello', 'text']]) {
    write(name, text); const result = open(name); assert.equal(result.kind, kind); assert.equal(result.data.text, text);
  }
});

test('source hash, sibling-project paths and escaping/replaced symlinks cannot bypass document boundary', t => {
  const {parent, root, write, open, plugins} = setup(t);
  const file = write('data.json', '{}'); const plugin = plugins.find(p => p.id === 'json'); const artifact = {sha256: hash(file)};
  fs.writeFileSync(file, '{"changed":true}'); assert.throws(() => plugin.open({file, artifact}), /changed/);
  const outside = path.join(parent, 'project-other'); fs.mkdirSync(outside); const other = path.join(outside, 'data.json'); fs.writeFileSync(other, '{}');
  assert.throws(() => plugin.open({file: other, artifact: {sha256: hash(other)}}), /outside/);
  fs.symlinkSync(other, path.join(root, 'escape.json')); assert.throws(() => open('escape.json'), /outside/);
  write('safe.json', '{}'); fs.symlinkSync(path.join(root, 'safe.json'), path.join(root, 'link.json')); assert.equal(open('link.json').kind, 'json');
  fs.unlinkSync(path.join(root, 'link.json')); fs.symlinkSync(other, path.join(root, 'link.json')); assert.throws(() => open('link.json'), /outside/);
});

test('binary, non-UTF-8 and excessive document inputs fail explicitly instead of being truncated', t => {
  const {write, open} = setup(t);
  write('nul.txt', Buffer.from([65, 0, 66])); assert.throws(() => open('nul.txt'), /binary/);
  write('bad.txt', Buffer.from([0xc3, 0x28])); assert.throws(() => open('bad.txt'), /UTF-8/);
  write('big.txt', 'x'.repeat(limits.bytes + 1)); assert.throws(() => open('big.txt'), /limit/);
  write('big.md', 'x'.repeat(limits.markdownBytes + 1)); assert.throws(() => open('big.md'), /limit/);
  write('lines.txt', '\n'.repeat(limits.lines)); assert.throws(() => open('lines.txt'), /line limit/);
});

test('specialized JSON wins over generic fallback; config.modules is not inferred as a Yosys netlist', t => {
  const {root, write, plugins} = setup(t);
  const registry = createViewerRegistry([...createAssetPlugins({projectRoot: () => root}), {id: 'netlist', matches: isYosysNetlist, open() {}}, ...plugins]);
  const fixture = path.resolve(__dirname, '../fixtures/counter.json');
  assert.equal(registry.match(fixture), 'netlist');
  assert.equal(registry.match(write('settings.json', '{"modules":["foo"]}')), 'json');
  assert.equal(registry.match(write('settings-map.json', '{"modules":{"foo":{"enabled":true}}}')), 'json');
  assert.equal(registry.match(write('sheet.sprite.json', '{"version":1,"image":"sheet.png"}')), 'sprite');
  assert.equal(registry.match(write('broken.json', '{invalid}')), 'json');
  assert.equal(registry.match(write('script.html', '<script>bad()</script>')), null);
});
