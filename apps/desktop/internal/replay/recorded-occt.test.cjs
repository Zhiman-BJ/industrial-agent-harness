'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const directory = path.resolve(__dirname, '../../../../packages/viewer-builtin/src/kicad');
const { recordedOcctGlue, OCCT_GLUE_SHA256 } = require(path.join(directory, 'recorded-occt.cjs'));
const { createReadOnlyKiCadViewer } = require(path.join(directory, 'recorded-plugin.cjs'));
const vendor = path.join(directory, 'vendor/occt-import');
const original = fs.readFileSync(path.join(vendor, 'occt-import-js.js'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function cubeStep() {
  const bytes = zlib.gunzipSync(
    fs.readFileSync(path.join(vendor, 'source/occt-import-js-c2148e5.tar.gz')),
  );
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const name = bytes
      .subarray(offset, offset + 100)
      .toString()
      .split('\0')[0];
    const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString(), 8);
    if (name.endsWith('/test/testfiles/simple-basic-cube/cube.stp'))
      return bytes.subarray(offset + 512, offset + 512 + size);
    if (!name) break;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Pinned source archive is missing its STEP fixture.');
}

function workerFactory(glue) {
  const context = vm.createContext(
    {
      console,
      TextDecoder,
      TextEncoder,
      importScripts() {
        throw Error('Unexpected external script request.');
      },
      fetch() {
        throw Error('Unexpected network request.');
      },
      self: { location: { href: 'app://kicad/test/vendor/occt-import/occt-import-js.js' } },
    },
    { codeGeneration: { strings: false, wasm: true } },
  );
  new vm.Script(glue).runInContext(context);
  return context.occtimportjs;
}

test('replay static STEP glue rejects source drift even after its cache is populated', () => {
  assert.equal(hash(original), OCCT_GLUE_SHA256);
  const adapted = recordedOcctGlue(original);
  assert.notEqual(adapted, original.toString());
  assert.doesNotMatch(adapted, /newFunc\(|\bFunction\s*\(|\beval\s*\(/);
  assert.throws(() => recordedOcctGlue(Buffer.concat([original, Buffer.from('\n')])), /integrity/);
  assert.equal(recordedOcctGlue(original), adapted);
  assert.equal(hash(fs.readFileSync(path.join(vendor, 'occt-import-js.js'))), OCCT_GLUE_SHA256);
});

test('real bounded STEP parsing works with string compilation disabled and preserves original geometry', async () => {
  const source = fs.readFileSync(path.join(directory, 'component-wasm.js'));
  const { boundPcbStepWasm } = await import(
    'data:text/javascript;base64,' + source.toString('base64')
  );
  const wasmBinary = await boundPcbStepWasm(
    fs.readFileSync(path.join(vendor, 'occt-import-js.wasm')),
  );
  const options = { wasmBinary, print() {}, printErr() {} };
  const adapted = await workerFactory(recordedOcctGlue(original))(options);
  const upstream = await require(path.join(vendor, 'occt-import-js.js'))(options);
  const input = cubeStep();
  const parseOptions = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.05,
    angularDeflection: 0.4,
  };
  const expected = upstream.ReadStepFile(input, parseOptions);
  const actual = adapted.ReadStepFile(input, parseOptions);
  assert.equal(actual.success, true);
  assert.equal(actual.meshes[0].index.array.length / 3, 12);
  assert.deepEqual(structuredClone(actual), expected);
  // Conversion/destructor paths must remain usable for repeated parse calls.
  assert.deepEqual(structuredClone(adapted.ReadStepFile(input, parseOptions)), expected);
  assert.equal(adapted.ReadStepFile(Buffer.from('invalid STEP'), parseOptions).success, false);
});

test('recorded protocol authorizes first, keeps strict CSP and expires adapted glue with its native token', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-occt-')));
  const source = Buffer.from('(kicad_pcb (version 20240108))');
  const file = path.join(root, 'board.kicad_pcb');
  fs.writeFileSync(file, source);
  const viewer = createReadOnlyKiCadViewer();
  t.after(() => {
    viewer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const opened = await viewer.plugin.open({ file, root, artifact: { sha256: hash(source) } });
  const url = opened.data.url.replace('index.html', 'vendor/occt-import/occt-import-js.js');
  const response = await viewer.handle(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), recordedOcctGlue(original));
  assert.match(
    response.headers.get('Content-Security-Policy'),
    /script-src 'self' 'wasm-unsafe-eval';/,
  );
  assert.doesNotMatch(
    response.headers.get('Content-Security-Policy'),
    /(?:^|\s)'unsafe-eval'(?:\s|;)/,
  );
  assert.equal((await viewer.handle(new Request(url, { method: 'POST' }))).status, 403);
  assert.equal(
    (await viewer.handle(new Request(url.replace('app://kicad/', 'https://kicad/')))).status,
    403,
  );
  const unchanged = await viewer.handle(
    new Request(opened.data.url.replace('index.html', 'component-worker.js')),
  );
  assert.deepEqual(
    Buffer.from(await unchanged.arrayBuffer()),
    fs.readFileSync(path.join(directory, 'component-worker.js')),
  );
  fs.appendFileSync(file, '\n');
  assert.equal((await viewer.handle(new Request(url))).status, 409);
  viewer.close(opened.data.token);
  assert.equal((await viewer.handle(new Request(url))).status, 404);
});
