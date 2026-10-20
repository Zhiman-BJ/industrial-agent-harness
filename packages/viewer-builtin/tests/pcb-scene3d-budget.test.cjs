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
  )
  .replace(
    "'./geometry3d.js'",
    JSON.stringify(pathToFileURL(path.join(directory, 'geometry3d.js')).href),
  );
const scene = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const three = import(pathToFileURL(path.join(directory, 'vendor/three/three.module.js')).href);
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

const boardRing = (low, high, hole = false) => ({
  hole,
  points: [
    [low, low],
    [high, low],
    [high, high],
    [low, high],
    [low, low],
  ],
});
function substrateTopArea(group, top = 0.8) {
  let total = 0;
  for (const mesh of group.children) {
    const positions = mesh.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i += 9)
      if ([i + 2, i + 5, i + 8].every(index => Math.abs(positions[index] - top) < 1e-6))
        total += area(positions.subarray(i, i + 9));
  }
  return total;
}

test('nested material islands retain both substrate bodies and drill only their own material regions', async () => {
  const { buildPcbSubstrate } = await scene;
  const { Raycaster, Vector3 } = await three;
  for (const drilled of [false, true]) {
    const counters = substrateCounters(),
      materials = new Set(),
      geometries = new Set();
    const body = buildPcbSubstrate(
      {
        board: { outline: [boardRing(0, 30), boardRing(5, 25, true), boardRing(10, 20)] },
        holes: drilled
          ? [drill({ center: [2, 2] }), drill({ center: [15, 15] }), drill({ center: [7, 7] })]
          : [],
      },
      1.6,
      layers,
      materials,
      geometries,
      counters,
    );
    try {
      assert.equal(
        body.children.length,
        2,
        'the surrounding board and nested island remain present',
      );
      assert.equal(counters.omittedBoardBodies, 0);
      assert.notEqual(counters.boardTopologyIncomplete, true);
      assert.ok(Math.abs(substrateTopArea(body) - (600 - (drilled ? Math.PI / 2 : 0))) < 0.05);
      body.updateMatrixWorld(true);
      const hit = (x, y) =>
        new Raycaster(new Vector3(x, -y, 10), new Vector3(0, 0, -1)).intersectObjects(body.children)
          .length > 0;
      assert.equal(hit(2, 2), !drilled, 'ordinary board drill is physically open');
      assert.equal(hit(7, 7), false, 'parent cutout remains empty');
      assert.equal(hit(12, 12), true, 'nested island retains material');
      assert.equal(hit(15, 15), !drilled, 'island drill is physically open');
    } finally {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    }
  }
});

test('deeper cutouts belong to their nearest material island rather than every surrounding ring', async () => {
  const { buildPcbSubstrate } = await scene;
  const counters = substrateCounters(),
    materials = new Set(),
    geometries = new Set();
  const body = buildPcbSubstrate(
    {
      // Source order need not be nesting order.
      board: {
        outline: [
          boardRing(12, 18, true),
          boardRing(0, 30),
          boardRing(10, 20),
          boardRing(5, 25, true),
        ],
      },
      holes: [drill({ center: [11, 11] }), drill({ center: [15, 15] })],
    },
    1.6,
    layers,
    materials,
    geometries,
    counters,
  );
  try {
    assert.equal(body.children.length, 2);
    assert.equal(counters.omittedBoardBodies, 0);
    assert.notEqual(counters.boardTopologyIncomplete, true);
    assert.ok(Math.abs(substrateTopArea(body) - (564 - Math.PI / 4)) < 0.03);
  } finally {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
});

test('a drill crossing a cutout or outer edge still conservatively omits the affected substrate', async () => {
  const { buildPcbSubstrate } = await scene;
  for (const center of [
    [5, 15],
    [0, 15],
  ]) {
    const counters = substrateCounters(),
      materials = new Set(),
      geometries = new Set();
    const body = buildPcbSubstrate(
      {
        board: { outline: [boardRing(0, 30), boardRing(5, 25, true), boardRing(10, 20)] },
        holes: [drill({ center })],
      },
      1.6,
      layers,
      materials,
      geometries,
      counters,
    );
    try {
      assert.equal(body.children.length, 1, 'the unaffected island remains available');
      assert.equal(counters.omittedBoardBodies, 1);
      assert.equal(counters.boardTopologyIncomplete, true);
      assert.ok(Math.abs(substrateTopArea(body) - 100) < 1e-6);
    } finally {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    }
  }
});

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

const modelHash = 'a'.repeat(64);
const triangleMesh = (overrides = {}) => ({
  positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [0.8, 0.2, 0.1],
  ...overrides,
});
const modelPlacement = (index, overrides = {}) => ({
  id: `model-${index}`,
  footprintId: `footprint-${index}`,
  reference: `U${index}`,
  modelHash,
  side: 'front',
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index, -5, 0.8, 1],
  ...overrides,
});

test('real component meshes merge by source material, share hash geometry across sides, and charge every instance', async () => {
  const { planPcbComponents } = await scene;
  const result = await planPcbComponents(
    {
      assets: [{ sha256: modelHash, meshes: [triangleMesh(), triangleMesh()] }],
      placements: [
        modelPlacement(1),
        modelPlacement(2),
        modelPlacement(3, {
          side: 'back',
          // The native bottom transform has positive determinant; the renderer must
          // retain this exact matrix instead of applying another Y reflection.
          matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 3, -5, -0.8, 1],
        }),
      ],
    },
    { triangleBudget: 6 },
  );
  assert.equal(result.stats.renderedModels, 3);
  assert.equal(result.stats.modelTriangles, 6);
  assert.equal(result.stats.modelInstances, 3);
  assert.equal(result.stats.modelBatches, 2);
  assert.equal(result.stats.uniqueModels, 1);
  assert.equal(result.stats.modelGeometryBytes, 168);
  assert.equal(result.stats.modelInstanceBytes, 3 * 64);
  assert.deepEqual(Array.from(result.batches[0].mesh.indices), [0, 1, 2, 3, 4, 5]);
  assert.equal(result.batches[0].mesh.positions, result.batches[1].mesh.positions);
  assert.equal(result.batches[0].mesh.positions[2], 1);
  assert.deepEqual(
    result.batches[1].placements[0].matrix,
    [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 3, -5, -0.8, 1],
  );
});

test('component triangle and draw-call limits admit entire placements instead of partial bodies', async () => {
  const { planPcbComponents } = await scene;
  const components = {
    assets: [
      { sha256: modelHash, meshes: [triangleMesh(), triangleMesh({ color: [0.1, 0.2, 0.3] })] },
    ],
    placements: [modelPlacement(1), modelPlacement(2), modelPlacement(3)],
  };
  const triangleLimited = await planPcbComponents(components, { triangleBudget: 5 });
  assert.equal(triangleLimited.stats.renderedModels, 2);
  assert.equal(triangleLimited.stats.omittedModels, 1);
  assert.equal(triangleLimited.stats.modelTriangles, 4);
  assert.equal(triangleLimited.batches.length, 2);
  for (const batch of triangleLimited.batches) assert.equal(batch.placements.length, 2);
  const batchLimited = await planPcbComponents(components, { maxBatches: 1 });
  assert.equal(batchLimited.stats.renderedModels, 0);
  assert.equal(batchLimited.stats.omittedModels, 3);
  assert.equal(batchLimited.stats.modelGeometryBytes, 0);
  assert.deepEqual(batchLimited.batches, []);
});

test('oversized component buffers are rejected from lengths before inspecting their invalid values', async () => {
  const { planPcbComponents } = await scene;
  const result = await planPcbComponents(
    {
      assets: [
        {
          sha256: modelHash,
          meshes: [
            triangleMesh({
              positions: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]),
              indices: new Uint32Array(300000),
            }),
          ],
        },
      ],
      placements: [modelPlacement(1)],
    },
    { triangleBudget: 10 },
  );
  assert.equal(result.stats.omittedModels, 1);
  assert.equal(result.stats.failedModels, 0);
  assert.deepEqual(result.batches, []);
});

test('component buffer validation and positive native transforms prevent invalid GPU submissions', async () => {
  const { planPcbComponents } = await scene;
  const cases = [
    { mesh: triangleMesh({ indices: new Uint32Array([0, 1, 3]) }) },
    { mesh: triangleMesh({ positions: new Float32Array([NaN, 0, 1, 1, 0, 1, 0, 1, 1]) }) },
    { mesh: triangleMesh({ normals: new Float32Array(1) }) },
    {
      placement: modelPlacement(1, {
        matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 1, -5, 0.8, 1],
      }),
    },
    {
      placement: modelPlacement(1, { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, -5, 0.8, 1] }),
    },
  ];
  for (const item of cases) {
    const result = await planPcbComponents({
      assets: [{ sha256: modelHash, meshes: [item.mesh || triangleMesh()] }],
      placements: [item.placement || modelPlacement(1)],
    });
    assert.equal(result.stats.failedModels, 1);
    assert.equal(result.stats.renderedModels, 0);
    assert.deepEqual(result.batches, []);
  }
});

test('per-face colors and source opacity are retained while final instance opacity forms separate batches', async () => {
  const { planPcbComponents } = await scene;
  const colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const result = await planPcbComponents({
    assets: [
      { sha256: modelHash, meshes: [triangleMesh({ colors, opacity: 0.5, doubleSided: true })] },
    ],
    placements: [modelPlacement(1), modelPlacement(2, { opacity: 0.4 })],
  });
  assert.equal(result.batches.length, 2);
  assert.equal(result.batches[0].mesh.colors, colors);
  assert.equal(result.batches[0].mesh.positions, result.batches[1].mesh.positions);
  assert.deepEqual(
    result.batches.map(batch => batch.opacity),
    [0.5, 0.2],
  );
  assert.ok(result.batches.every(batch => batch.doubleSided));
  assert.equal(result.stats.modelGeometryBytes, 120);
});

test('unique component GPU memory is charged once per hash and does not bypass capacity with new hashes', async () => {
  const { planPcbComponents } = await scene;
  const otherHash = 'b'.repeat(64);
  const result = await planPcbComponents(
    {
      assets: [
        { sha256: modelHash, meshes: [triangleMesh()] },
        // Its bytes exceed the remaining shared capacity. NaN would be a
        // validation failure if values were scanned before admission.
        {
          sha256: otherHash,
          meshes: [triangleMesh({ positions: new Float32Array([NaN, 0, 1, 1, 0, 1, 0, 1, 1]) })],
        },
      ],
      placements: [
        modelPlacement(1),
        modelPlacement(2),
        modelPlacement(3, { modelHash: otherHash }),
      ],
      missingModels: 2,
      failedModels: 1,
    },
    { maxGeometryBytes: 84 },
  );
  assert.equal(result.stats.renderedModels, 2);
  assert.equal(result.stats.modelGeometryBytes, 84);
  assert.equal(result.stats.uniqueModels, 1);
  assert.equal(result.stats.omittedModels, 1);
  assert.equal(result.stats.missingModels, 2);
  assert.equal(result.stats.failedModels, 1);
});

test('component planning yields and aborts without returning partially built instances', async () => {
  const { planPcbComponents } = await scene;
  const controller = new AbortController();
  const building = planPcbComponents(
    {
      assets: [{ sha256: modelHash, meshes: [triangleMesh()] }],
      placements: Array.from({ length: 200 }, (_, index) => modelPlacement(index)),
    },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(building, { name: 'AbortError' });
});

test('repeated invalid assets cannot consume an unlimited component validation scan budget', async () => {
  const { planPcbComponents } = await scene;
  const otherHash = 'b'.repeat(64);
  const invalid = () => triangleMesh({ indices: new Uint32Array([0, 1, 999]) });
  const result = await planPcbComponents(
    {
      assets: [
        { sha256: modelHash, meshes: [invalid()] },
        { sha256: otherHash, meshes: [invalid()] },
      ],
      placements: [modelPlacement(1), modelPlacement(2, { modelHash: otherHash })],
    },
    { maxInspectionBytes: 84 },
  );
  assert.equal(result.stats.failedModels, 1);
  assert.equal(result.stats.omittedModels, 1);
  assert.equal(result.stats.renderedModels, 0);
  assert.deepEqual(result.batches, []);
});
