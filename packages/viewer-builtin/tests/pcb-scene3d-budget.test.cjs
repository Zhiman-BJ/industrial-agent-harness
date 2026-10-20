const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The production iframe exposes Three under its bounded /three/ route. Resolve
// those same unchanged modules to files for CPU geometry/resource tests, without
// creating a WebGL context or replacing the production mask implementation.
const directory = path.resolve(__dirname, '../src/kicad');
const source = fs
  .readFileSync(path.join(directory, 'scene3d.js'), 'utf8')
  .replace(
    "'./three/three.module.js'",
    JSON.stringify(pathToFileURL(path.join(directory, 'vendor/three/three.module.js')).href),
  )
  .replace(
    "'./three/controls/OrbitControls.js'",
    JSON.stringify(
      pathToFileURL(path.join(directory, 'vendor/three/controls/OrbitControls.js')).href,
    ),
  );
const scene = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const layers = ['F.Cu', 'In1.Cu', 'B.Cu'].map(id => ({ id, name: id }));
const drill = (overrides = {}) => ({
  center: [10, 10],
  size: [1, 1],
  rotation: 0,
  startLayer: 'F.Cu',
  endLayer: 'B.Cu',
  objectId: 'via-1',
  ...overrides,
});

function area(positions) {
  let result = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const [ax, ay, , bx, by, , cx, cy] = positions.subarray(i, i + 9);
    result += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return result;
}

test('drill masks preserve real circular and rotated slot areas in a bounded typed buffer', async () => {
  const { buildDrillMask } = await scene;
  const result = await buildDrillMask(
    [drill(), drill({ center: [20, 20], size: [2, 1], rotation: 37 })],
    layers,
    'F.Cu',
    0.8,
    1000,
  );
  assert.equal(result.complete, true);
  assert.equal(result.contours.length, 2);
  assert.ok(result.positions instanceof Float32Array);
  assert.equal(result.positions.length, result.triangles * 9);
  assert.ok(result.positions.byteLength <= 1000 * 9 * Float32Array.BYTES_PER_ELEMENT);
  assert.ok(Math.abs(area(result.positions) - (Math.PI * 0.5 + 1)) < 0.05);
  for (let i = 2; i < result.positions.length; i += 3)
    assert.ok(Math.abs(result.positions[i] - 0.8) < 1e-6);
});

test('a blind drill masks only the actual copper span', async () => {
  const { buildDrillMask } = await scene;
  const holes = [drill({ endLayer: 'In1.Cu' })];
  const front = await buildDrillMask(holes, layers, 'F.Cu', 0.8, 100);
  const inner = await buildDrillMask(holes, layers, 'In1.Cu', 0, 100);
  const back = await buildDrillMask(holes, layers, 'B.Cu', -0.8, 100);
  assert.equal(front.contours.length, 1);
  assert.equal(inner.contours.length, 1);
  assert.equal(back.complete, true);
  assert.equal(back.contours.length, 0);
  assert.equal(back.positions.byteLength, 0);
});

test('an oversized later drill rejects the whole mask instead of returning partial openings', async () => {
  const { buildDrillMask } = await scene;
  const neverRead = {
    get startLayer() {
      throw Error('Read past the exhausted mask budget');
    },
  };
  const result = await buildDrillMask(
    [drill(), drill({ size: [2000, 2000] }), neverRead],
    layers,
    'F.Cu',
    0.8,
    40,
  );
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'budget');
  assert.equal(result.positions.byteLength, 0);
  assert.deepEqual(result.contours, []);
  assert.equal(result.triangles, 0);
});

test('unsupported drill size or span never silently becomes a complete mask', async () => {
  const { buildDrillMask } = await scene;
  for (const invalid of [drill({ size: [0, 1] }), drill({ endLayer: 'unknown' })]) {
    const result = await buildDrillMask([drill(), invalid], layers, 'F.Cu', 0.8, 1000);
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'unsupported');
    assert.equal(result.positions.byteLength, 0);
    assert.deepEqual(result.contours, []);
  }
});

test('mask construction yields so a closing view can abort before allocating the whole mask', async () => {
  const { buildDrillMask } = await scene;
  const controller = new AbortController();
  const holes = Array.from({ length: 256 }, (_, i) => drill({ center: [i * 2, 10] }));
  const building = buildDrillMask(holes, layers, 'F.Cu', 0.8, 100000, controller.signal);
  controller.abort();
  await assert.rejects(building, { name: 'AbortError' });
});

test('mask point budget rejects pathological detail without returning a partial layer', async () => {
  const { buildDrillMask } = await scene;
  const holes = Array.from({ length: 1600 }, (_, i) =>
    drill({ center: [i * 300, 0], size: [200, 200] }),
  );
  const result = await buildDrillMask(holes, layers, 'F.Cu', 0.8, 1200000);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'budget');
  assert.equal(result.positions.byteLength, 0);
  assert.deepEqual(result.contours, []);
});

test('oversized single lines and polygons are rejected before reading or triangulating their point arrays', async () => {
  const { buildPcbPrimitive } = await scene;
  for (const [kind, length] of [
    ['line', 1000000],
    ['polygon', 65537],
  ]) {
    const points = new Array(length);
    Object.defineProperty(points, '0', {
      get() {
        throw Error('Oversized points were inspected');
      },
    });
    const result = buildPcbPrimitive({ kind, points, width: 0.5 }, 0, 1200000);
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'budget');
    assert.deepEqual(result.positions, []);
  }
});

test('primitive output estimates include every round line cap before applying the remaining scene budget', async () => {
  const { buildPcbPrimitive, primitiveTriangleBudget } = await scene;
  const shape = {
    kind: 'line',
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
    ],
    width: 0.5,
  };
  const bound = primitiveTriangleBudget(shape);
  assert.ok(
    bound > 4,
    'the bound includes endpoint and corner discs, not only the segment rectangles',
  );
  const rejected = buildPcbPrimitive(shape, 0, bound - 1);
  assert.equal(rejected.reason, 'budget');
  assert.deepEqual(rejected.positions, []);
  const accepted = buildPcbPrimitive(shape, 0, bound);
  assert.equal(accepted.complete, true);
  assert.ok(accepted.triangles <= bound);
  assert.equal(accepted.positions.length, accepted.triangles * 9);
});

const substrateInput = holes => ({
  board: {
    outline: [
      {
        hole: false,
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      },
    ],
  },
  holes,
});
const substrateCounters = () => ({ triangles: 0, omittedBoardBodies: 0 });

test('substrate extrusion checks total points and the remaining triangle budget before allocating geometry', async () => {
  const { buildPcbSubstrate } = await scene;
  const points = new Array(32001);
  Object.defineProperty(points, '0', {
    get() {
      throw Error('Oversized outline was inspected');
    },
  });
  const cases = [
    {
      input: { board: { outline: [{ hole: false, points }] }, holes: [] },
      counters: substrateCounters(),
    },
    { input: substrateInput([]), counters: { triangles: 1199990, omittedBoardBodies: 0 } },
  ];
  for (const { input, counters } of cases) {
    const materials = new Set(),
      geometries = new Set();
    const body = buildPcbSubstrate(input, 1.6, layers, materials, geometries, counters);
    assert.equal(body.children.length, 0);
    assert.equal(materials.size, 0);
    assert.equal(geometries.size, 0);
    assert.equal(counters.omittedBoardBodies, 1);
    assert.equal(counters.bodyComplexityLimited, true);
  }
});

test('dense disjoint substrate holes cannot exceed the shared topology operation budget', async () => {
  const { buildPcbSubstrate } = await scene;
  const holes = Array.from({ length: 500 }, (_, index) =>
    drill({
      center: [1 + (index % 25) * 0.003, 1 + Math.floor(index / 25) * 0.003],
      size: [0.0002, 0.0002],
    }),
  );
  const counters = substrateCounters(),
    materials = new Set(),
    geometries = new Set();
  const body = buildPcbSubstrate(
    substrateInput(holes),
    1.6,
    layers,
    materials,
    geometries,
    counters,
  );
  assert.equal(body.children.length, 0);
  assert.equal(counters.omittedBoardBodies, 1);
  assert.equal(counters.bodyComplexityLimited, true);
  assert.ok(counters.topologyOperations <= 8000001);
  assert.equal(materials.size, 0);
  assert.equal(geometries.size, 0);
});
