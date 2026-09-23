const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {renderNetlist} = require('../src/netlist/netlist.cjs');
const {createViewerProtocol} = require('../src/waveform/protocol.cjs');
const root = path.resolve(__dirname, '..');

test('Yosys JSON renders real net connectivity through netlistsvg', async () => {
  const data = await renderNetlist(path.join(root, 'fixtures/counter.json'));
  assert.match(data.svg, /<svg/);
  assert.equal(data.cellCount, 5);
  assert.equal(data.nets.find(net => net.name === 'count')?.bits.length, 8);
  await assert.rejects(renderNetlist(path.join(root, 'fixtures/counter.json'), 'missing'), /modules/);
});

test('waveform assets retain the upstream snapshot hashes', () => {
  const dir = path.join(root, 'src/waveform/surfer');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'ASSET-MANIFEST.json')));
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(dir, asset.file));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
});

test('waveform protocol serves registered files and rejects traversal', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-viewer-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  fs.mkdirSync(path.join(temp, 'dist'));
  fs.writeFileSync(path.join(temp, 'secret.js'), 'secret');
  fs.symlinkSync(path.join(temp, 'secret.js'), path.join(temp, 'dist/escape.js'));
  const protocol = createViewerProtocol(temp);
  const url = protocol.registerWave(path.join(root, 'fixtures/counter.vcd'));
  const response = await protocol.handle({url});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\$timescale/);
  assert.equal((await protocol.handle({url: 'app://viewer/wave/unknown'})).status, 404);
  assert.equal((await protocol.handle({url: 'app://viewer/escape.js'})).status, 403);
  assert.equal((await protocol.handle({url: 'app://other/secret.js'})).status, 403);
  protocol.close();
  assert.equal((await protocol.handle({url})).status, 404);
});

test('KLayout LayoutView renders a bounded GDS viewport when available', {skip: !process.env.KLAYOUT_PYTHON}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-layout-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const fixture = path.join(temp, 'layout.gds');
  const make = spawn(process.env.KLAYOUT_PYTHON, ['-c', `import klayout.db as db; l=db.Layout(); l.dbu=0.001; c=l.create_cell('TOP'); layer=l.layer(1,0); c.shapes(layer).insert(db.Box(0,0,1000,1000)); l.write(${JSON.stringify(fixture)})`]);
  assert.equal(await new Promise(resolve => make.on('exit', resolve)), 0);
  const {RasterService} = require('../src/layout/raster.cjs');
  const service = new RasterService(process.env.KLAYOUT_PYTHON);
  t.after(() => service.close());
  const loaded = await service.call({op: 'load', path: fixture, token: 'fixture'});
  assert.equal(loaded.cell, 'TOP');
  const result = await service.call({op: 'render', token: 'fixture', box: loaded.bbox, width: 128, height: 128, visible: loaded.layers.map(layer => layer.key), quality: 'fine'});
  assert.equal(Buffer.from(result.png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
