const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RasterService } = require('../src/layout/raster.cjs');

const available = { skip: !process.env.KLAYOUT_PYTHON };
async function fixture(t, shapes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-geometry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'geometry.gds');
  const generated = spawnSync(
    process.env.KLAYOUT_PYTHON,
    [
      '-c',
      `
import sys
import klayout.db as db
layout = db.Layout()
layout.dbu = 0.001
top = layout.create_cell('TOP')
layer = layout.layer(1, 0)
${shapes}
layout.write(sys.argv[1])
`,
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const original = fs.readFileSync(file);
  const service = new RasterService(process.env.KLAYOUT_PYTHON);
  t.after(() => service.close());
  const loaded = await service.call({ op: 'load', path: file, token: 'geometry-test' });
  return {
    service,
    loaded,
    original,
    file,
    geometry: (box = loaded.bbox, visible = ['1/0']) =>
      service.call({
        op: 'geometry',
        token: loaded.token,
        box,
        visible,
      }),
  };
}

function triangles(layer) {
  assert.equal(layer.triangles.length % 9, 0);
  return Array.from({ length: layer.triangles.length / 9 }, (_, i) =>
    layer.triangles.slice(i * 9, i * 9 + 9),
  );
}
function horizontalArea(items, z) {
  return items
    .filter(v => v[2] === z && v[5] === z && v[8] === z)
    .reduce(
      (sum, v) => sum + ((v[3] - v[0]) * (v[7] - v[1]) - (v[6] - v[0]) * (v[4] - v[1])) / 2,
      0,
    );
}

test('GDS holes keep their empty area and only their true boundary walls', available, async t => {
  const subject = await fixture(
    t,
    `
donut = db.Polygon(db.Box(0, 0, 10000, 10000))
donut.insert_hole(db.Box(2000, 2000, 8000, 8000))
top.shapes(layer).insert(donut)
`,
  );
  const result = await subject.geometry();
  assert.equal(result.token, subject.loaded.token);
  assert.deepEqual(result.box, subject.loaded.bbox);
  assert.equal(result.shapeCount, 1);
  const mesh = triangles(result.layers[0]);
  assert.equal(horizontalArea(mesh, 1), 64);
  assert.equal(horizontalArea(mesh, 0), -64);
  const walls = mesh.filter(v => !(v[2] === v[5] && v[5] === v[8]));
  assert.equal(walls.length, 16, 'only four outer and four inner wall segments');
  assert.equal(result.triangleCount, mesh.length);
  assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  const clipped = await subject.geometry([0, 0, 5, 10]);
  const cut = triangles(clipped.layers[0]);
  assert.equal(horizontalArea(cut, 1), 32);
  for (const v of cut)
    for (let i = 0; i < 9; i += 3) {
      assert.ok(v[i] >= 0 && v[i] <= 5);
      assert.ok(v[i + 1] >= 0 && v[i + 1] <= 10);
    }
});

test(
  'hierarchy rotation, paths, hidden layers and offscreen geometry use real coordinates',
  available,
  async t => {
    const subject = await fixture(
      t,
      `
child = layout.create_cell('CHILD')
child.shapes(layer).insert(db.Box(0, 0, 1000, 2000))
top.insert(db.CellInstArray(child.cell_index(), db.Trans(1, False, 20000, 0)))
other = layout.layer(2, 0)
top.shapes(other).insert(db.Path([db.Point(0, 12000), db.Point(10000, 12000)], 500))
`,
    );
    const result = await subject.geometry([0, 0, 21, 14], ['1/0', '2/0']);
    assert.equal(result.shapeCount, 2);
    const rectangle = triangles(result.layers.find(layer => layer.key === '1/0'));
    assert.equal(horizontalArea(rectangle, 1), 2);
    for (const v of rectangle)
      for (let i = 0; i < 9; i += 3) {
        assert.ok(v[i] >= 18 && v[i] <= 20);
        assert.ok(v[i + 1] >= 0 && v[i + 1] <= 1);
      }
    assert.equal(horizontalArea(triangles(result.layers.find(layer => layer.key === '2/0')), 1), 5);
    assert.deepEqual((await subject.geometry([0, 0, 21, 14], [])).layers, []);
    assert.deepEqual((await subject.geometry([0, 0, 10, 10], ['1/0'])).layers, []);
  },
);

test(
  'geometry rejects stale identity and malformed bounds while preserving 2D rendering',
  available,
  async t => {
    const subject = await fixture(t, 'top.shapes(layer).insert(db.Box(0, 0, 1000, 1000))');
    await assert.rejects(
      subject.service.call({
        op: 'geometry',
        token: 'stale',
        box: [0, 0, 1, 1],
        visible: ['1/0'],
      }),
      /selection changed/,
    );
    for (const box of [
      [0, 0, 0, 1],
      [0, 0, 1e100, 1],
      [0, 0, null, 1],
      [0, 0, 0.0001, 0.0001],
    ])
      await assert.rejects(subject.geometry(box), /viewport|Viewport/);
    await assert.rejects(subject.geometry([0, 0, 1, 1], ['9/9']), /Unknown layout layer/);
    await assert.rejects(subject.geometry([0, 0, 1, 1], Array(257).fill('1/0')), /visible layers/);
    const raster = await subject.service.call({
      op: 'render',
      token: subject.loaded.token,
      box: subject.loaded.bbox,
      width: 128,
      height: 128,
      visible: ['1/0'],
      quality: 'fine',
    });
    assert.equal(
      Buffer.from(raster.png, 'base64').subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
    );
    assert.equal((await subject.geometry()).shapeCount, 1);
  },
);

test(
  'dense view is rejected without returning partial geometry and a smaller view recovers',
  available,
  async t => {
    const subject = await fixture(
      t,
      `
for i in range(5001):
    top.shapes(layer).insert(db.Box(i * 2, 0, i * 2 + 1, 1))
`,
    );
    await assert.rejects(subject.geometry(), /Layout geometry limit reached/);
    const smaller = await subject.geometry([0, 0, 0.003, 0.001]);
    assert.equal(smaller.shapeCount, 2);
    assert.equal(smaller.triangleCount, 24);
  },
);

test('actual Sobel crop has the same per-layer XY regions as the source GDS', available, () => {
  const gds = path.resolve(__dirname, '../../../examples/chip-sobel/outputs/sobel_layout.gds');
  const original = fs.readFileSync(gds);
  const result = spawnSync(
    process.env.KLAYOUT_PYTHON,
    [
      '-c',
      `
import json, math, sys
import klayout.db as db
sys.path.insert(0, sys.argv[1])
from geometry import extract_geometry
layout = db.Layout()
layout.read(sys.argv[2])
cell = layout.top_cell()
dbu = layout.dbu
box = [120.7355, 120.7355, 129.2645, 129.2645]
clip = db.Box(math.ceil(box[0] / dbu), math.ceil(box[1] / dbu), math.floor(box[2] / dbu), math.floor(box[3] / dbu))
indices = {f'{layout.get_info(i).layer}/{layout.get_info(i).datatype}': i for i in layout.layer_indices()}
geometry = extract_geometry(layout, cell, {'token': 'sobel-oracle', 'box': box, 'visible': list(indices)})
meshes = {item['key']: item['triangles'] for item in geometry['layers']}
for key, index in indices.items():
    expected = (db.Region(cell.begin_shapes_rec_overlapping(index, clip)) & db.Region(clip)).merged()
    projected = db.Region()
    vertices = meshes.get(key, [])
    for offset in range(0, len(vertices), 9):
        triangle = vertices[offset:offset + 9]
        if triangle[2] == triangle[5] == triangle[8] == 1:
            projected.insert(db.Polygon([db.Point(round(triangle[j] / dbu), round(triangle[j + 1] / dbu)) for j in (0, 3, 6)]))
    projected.merge()
    assert (expected - projected).is_empty(), f'{key}: missing source geometry'
    assert (projected - expected).is_empty(), f'{key}: extra projected geometry'
print(json.dumps({'layers': len(indices), 'shapes': geometry['shapeCount']}))
`,
      path.resolve(__dirname, '../src/layout'),
      gds,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const checked = JSON.parse(result.stdout);
  assert.equal(checked.layers, 22);
  assert.ok(checked.shapes > 1000);
  assert.deepEqual(fs.readFileSync(gds), original);
});
