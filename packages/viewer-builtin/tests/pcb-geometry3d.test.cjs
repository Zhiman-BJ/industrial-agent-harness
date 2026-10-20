const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const geometry = import(pathToFileURL(path.resolve(__dirname, '../src/kicad/geometry3d.js')).href);

const rect = (left, top, right, bottom) => [
  [left, top],
  [right, top],
  [right, bottom],
  [left, bottom],
  [left, top],
];

test('Edge.Cuts joins reversed source segments and classifies cutouts and disjoint board islands', async () => {
  const { stitchOutline } = await geometry;
  const outside = rect(0, 0, 50, 30);
  const paths = outside
    .slice(0, -1)
    .map((point, i) => (i % 2 ? [outside[i + 1], point] : [point, outside[i + 1]]));
  const result = stitchOutline([...paths, rect(4, 4, 8, 9), rect(60, 0, 70, 10)]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.outline.length, 3);
  assert.equal(result.outline.filter(item => item.hole).length, 1);
  assert.equal(result.outline.filter(item => !item.hole).length, 2);
  assert.deepEqual(result.outline.find(item => item.hole).points, rect(4, 4, 8, 9));
});

test('a nested material island is not classified as a second hole', async () => {
  const { stitchOutline } = await geometry;
  const result = stitchOutline([rect(0, 0, 30, 30), rect(5, 5, 25, 25), rect(10, 10, 20, 20)]);
  assert.deepEqual(
    result.outline.map(item => item.hole),
    [false, true, false],
  );
});

test('open, branching, self-intersecting and touching outlines never become board solids', async () => {
  const { stitchOutline } = await geometry;
  for (const paths of [
    [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 10],
      ],
    ],
    [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 10],
      ],
      [
        [10, 0],
        [20, 0],
      ],
    ],
    [
      [
        [0, 0],
        [10, 10],
        [0, 10],
        [10, 0],
        [0, 0],
      ],
    ],
    [rect(0, 0, 10, 10), rect(10, 2, 15, 7)],
  ]) {
    const result = stitchOutline(paths);
    assert.deepEqual(result.outline, []);
    assert.ok(result.warnings.length);
  }
});

test('outline joining allows a micron endpoint gap while preserving source coordinates', async () => {
  const { stitchOutline } = await geometry;
  const result = stitchOutline([
    [
      [0, 0],
      [20, 0],
    ],
    [
      [20.0005, 0],
      [20, 10],
    ],
    [
      [20, 10],
      [0, 10],
    ],
    [
      [0, 10],
      [0, 0],
    ],
  ]);
  assert.equal(result.outline.length, 1);
  assert.deepEqual(result.outline[0].points[0], result.outline[0].points.at(-1));
  assert.ok(result.outline[0].points.some(point => point[0] === 20 && point[1] === 0));
});

test('over-budget outline is explicit and does not substitute its bounding box', async () => {
  const { stitchOutline } = await geometry;
  const result = stitchOutline([rect(0, 0, 20, 10)], 0.001, 4);
  assert.deepEqual(result.outline, []);
  assert.match(result.warnings.join(' '), /budget/);
});

const board = layers => ({
  general: { thickness: 1.6 },
  layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'].map(canonical_name => ({ canonical_name })),
  setup: { stackup: { layers } },
});
const stack = [
  { name: 'F.Mask', type: 'Top Solder Mask', thickness: 0.02 },
  { name: 'F.Cu', thickness: 0.035 },
  { name: 'dielectric 1', thickness: 0.4 },
  { name: 'In1.Cu', thickness: 0.035 },
  { name: 'dielectric 2', thickness: 0.66 },
  { name: 'In2.Cu', thickness: 0.035 },
  { name: 'dielectric 3', thickness: 0.4 },
  { name: 'B.Cu', thickness: 0.035 },
  { name: 'B.Mask', type: 'Bottom Solder Mask', thickness: 0.02 },
];

test('physical Z positions use actual copper and dielectric thickness and exclude solder mask', async () => {
  const { stackupPositions } = await geometry;
  const actual = stackupPositions(board(stack), '(kicad_pcb (general (thickness 1.6)))');
  assert.equal(actual.zMode, 'stackup');
  assert.ok(Math.abs(actual.thickness - 1.6) < 1e-9);
  assert.ok(Math.abs(actual.positions.get('F.Cu').z - 0.7825) < 1e-9);
  assert.ok(Math.abs(actual.positions.get('B.Cu').z + 0.7825) < 1e-9);
  assert.equal(actual.positions.get('In1.Cu').thickness, 0.035);
});

test('missing layer thickness uses schematic spacing without fabricating physical Z', async () => {
  const { stackupPositions } = await geometry;
  const incomplete = stack.map(item => (item.name === 'dielectric 2' ? { name: item.name } : item));
  const actual = stackupPositions(board(incomplete), '(kicad_pcb (general (thickness 1.6)))');
  assert.equal(actual.zMode, 'schematic');
  assert.equal(actual.positions.size, 0);
  assert.equal(actual.thickness, 1.6);
  assert.match(actual.warnings.join(' '), /schematic/);
});

test('the upstream default thickness and quoted pseudo declarations are not engineering facts', async () => {
  const { stackupPositions } = await geometry;
  const source = '(kicad_pcb (property "note" "(general (thickness 1.6))"))';
  const actual = stackupPositions(board([]), source);
  assert.equal(actual.thickness, null);
  assert.equal(actual.zMode, 'schematic');
});

test('a conflicting declared thickness is reported while solid and copper share stackup coordinates', async () => {
  const { stackupPositions } = await geometry;
  const source = board(stack);
  source.general.thickness = 3;
  const actual = stackupPositions(source, '(kicad_pcb (general (thickness 3)))');
  assert.ok(Math.abs(actual.thickness - 1.6) < 1e-9);
  assert.equal(actual.declaredThickness, 3);
  assert.match(actual.warnings.join(' '), /differs/);
});

test('dielectric addsublayer syntax cannot turn a partially parsed thickness into physical Z', async () => {
  const { stackupPositions } = await geometry;
  for (const detail of [
    '(thickness 0.2) addsublayer (thickness 0.3)',
    '(thickness 0.2) (addsublayer (thickness 0.3))',
    '(thickness 0.2) (material "FR4") (thickness 0.3)',
  ]) {
    // The pinned parser retains only the last thickness. Supplying that parsed
    // object must not cause the original richer source to be labelled physical.
    const source = `(kicad_pcb (general (thickness 1.6))
      (setup (stackup (layer "dielectric 1" ${detail}))))`;
    const actual = stackupPositions(board(stack), source);
    assert.equal(actual.zMode, 'schematic');
    assert.equal(actual.positions.size, 0);
    assert.match(actual.warnings.join(' '), /sublayers|repeated layer thickness/);
  }
});

test('quoted sublayer words and thickness in unrelated source fields do not disable valid stackup', async () => {
  const { stackupPositions } = await geometry;
  const source = `(kicad_pcb (general (thickness 1.6))
    (property "note" "addsublayer (thickness 10)")
    (setup (stackup (layer "dielectric 1" (material "addsublayer") (thickness 0.4))))
    (footprint "note" (property "thickness" "thickness")))`;
  assert.equal(stackupPositions(board(stack), source).zMode, 'stackup');
});

test('a physical stackup requires each copper layer exactly once in F-to-In-to-B order', async () => {
  const { stackupPositions } = await geometry;
  const wrongOrder = stack.map(item => ({ ...item }));
  [wrongOrder[3], wrongOrder[5]] = [wrongOrder[5], wrongOrder[3]];
  const duplicate = [...stack.slice(0, 4), { name: 'In1.Cu', thickness: 0.035 }, ...stack.slice(4)];
  const missing = stack.filter(item => item.name !== 'In2.Cu');
  const extra = [...stack.slice(0, 4), { name: 'In3.Cu', thickness: 0.035 }, ...stack.slice(4)];
  for (const layers of [wrongOrder, duplicate, missing, extra]) {
    const actual = stackupPositions(board(layers), '(kicad_pcb (general (thickness 1.6)))');
    assert.equal(actual.zMode, 'schematic');
    assert.equal(actual.positions.size, 0);
    assert.match(actual.warnings.join(' '), /missing, duplicated or out of order/);
  }
});

test('copper physical order is canonical rather than dependent on source layer-list order', async () => {
  const { stackupPositions } = await geometry;
  const input = board(stack);
  input.layers.reverse();
  assert.equal(stackupPositions(input).zMode, 'stackup');
  input.layers.push({ canonical_name: 'F.Cu' });
  assert.equal(stackupPositions(input).zMode, 'schematic');
});

test('unsupported pads are reported even when upstream emits no primitives; counts are per source item', async () => {
  const { capturePcbGeometry } = await geometry;
  class Pad {
    constructor(shape, fields = {}) {
      this.shape = shape;
      this.type = 'thru_hole';
      this.layers = ['*.Cu'];
      Object.assign(this, fields);
    }
  }
  class NullRenderer {
    start_layer() {
      this.activeLayer = { shapes: [] };
    }
    end_layer() {
      return this.activeLayer;
    }
    dispose() {}
  }
  class BoardLayerSet {
    by_name(name) {
      return { name };
    }
    dispose() {}
  }
  class BoardPainter {
    layers_for() {
      return [':Pads:Front', ':Pads:Back'];
    }
    paint_item() {} // Simulates unsupported upstream source producing no draw call.
  }
  const pads = [
    new Pad('unsupported-source-shape'),
    new Pad('roundrect', { chamfer: { top_left: true } }),
    new Pad('circle', { remove_unused_layers: true }),
  ];
  const source = {
    board: {
      layers: [{ name: 'F.Cu' }, { name: 'B.Cu' }],
      *items() {
        yield* pads;
      },
    },
    theme: {},
  };
  const actual = await capturePcbGeometry(source, {
    engine: { NullRenderer, BoardLayerSet, BoardPainter },
  });
  assert.equal(actual.complete, false);
  assert.equal(actual.stats.unsupportedItems, 3, 'a pad visited on two layers counts only once');
  assert.match(actual.warnings.join(' '), /source pad shapes/);
  assert.match(actual.warnings.join(' '), /Chamfered pad/);
  assert.match(actual.warnings.join(' '), /Unused internal/);
});

test('physical copper mapping merges upstream pad and zone paint layers without net labels', async () => {
  const { physicalLayer } = await geometry;
  assert.equal(physicalLayer(':Pads:Front'), 'F.Cu');
  assert.equal(physicalLayer(':In2.Cu:Zones'), 'In2.Cu');
  assert.equal(physicalLayer(':Pads:Front:NetName'), null);
  assert.equal(physicalLayer(':Pad:Holes'), null);
  assert.equal(physicalLayer('F.SilkS'), 'F.SilkS');
});

const transformPoint = (matrix, point) =>
  [0, 1, 2].map(
    row =>
      matrix[row] * point[0] +
      matrix[4 + row] * point[1] +
      matrix[8 + row] * point[2] +
      matrix[12 + row],
  );
const closePoint = (actual, expected) =>
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-9, `${actual} != ${expected}`),
  );

test('native assembly preserves local model Y and only flips footprint board Y', async () => {
  const { componentMatrix } = await geometry;
  const matrix = componentMatrix(
    { at: [4, 6], rotation: 0, side: 'front' },
    { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    2,
  );
  assert.equal(matrix.length, 16);
  closePoint(transformPoint(matrix, [1, 2, 3]), [5, -4, 5]);
  assert.deepEqual([matrix[3], matrix[7], matrix[11], matrix[15]], [0, 0, 0, 1]);
});

test('asymmetric pin-1 placement matches native front/back flip with 90-degree footprint and model rotation', async () => {
  const { componentMatrix } = await geometry;
  const model = { offset: [3, 4, 5], rotation: [0, 0, 90], scale: [2, 3, 4] };
  const component = { at: [10, 20], rotation: 90 };
  const front = componentMatrix({ ...component, side: 'front' }, model, 0.8);
  const back = componentMatrix({ ...component, side: 'back' }, model, -0.8);
  // Expectations are hand derived in native order: scale, negative model
  // rotation, offset, underside flip, positive footprint rotation, translation.
  closePoint(transformPoint(front, [1, 2, 0.5]), [8, -11, 7.8]);
  closePoint(transformPoint(back, [1, 2, 0.5]), [12, -11, -7.8]);
  closePoint(transformPoint(front, [0, 0, 0]), [6, -17, 5.8]);
  closePoint(transformPoint(back, [0, 0, 0]), [14, -17, -5.8]);
});

test('model XYZ rotations apply in native negative-X then negative-Y then negative-Z order', async () => {
  const { componentMatrix } = await geometry;
  const matrix = componentMatrix(
    { at: [2, 7], rotation: 0, side: 'front' },
    { offset: [5, 6, 7], rotation: [90, 90, 90], scale: [2, 3, 4] },
    1,
  );
  closePoint(transformPoint(matrix, [1, 2, 3]), [19, -7, 10]);
});

test('non-finite and unsupported component transforms cannot become plausible default placements', async () => {
  const { componentMatrix } = await geometry;
  const component = { at: [1, 2], rotation: 0, side: 'front' };
  const model = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  for (const [placement, transform, surface] of [
    [{ ...component, side: null }, model, 0.8],
    [{ ...component, at: [NaN, 0] }, model, 0.8],
    [{ ...component, rotation: Infinity }, model, 0.8],
    [component, { ...model, scale: [1, 1] }, 0.8],
    [component, { ...model, offset: [0, NaN, 0] }, 0.8],
    [component, { ...model, error: 'unsupported units' }, 0.8],
    [component, model, null],
  ])
    assert.throws(() => componentMatrix(placement, transform, surface), /Invalid PCB component/);
});

const emptyPaintEngine = {
  NullRenderer: class {
    dispose() {}
  },
  BoardLayerSet: class {
    by_name(name) {
      return { name };
    }
    dispose() {}
  },
  BoardPainter: class {
    layers_for() {
      return [];
    }
    paint_item() {}
  },
};

test('component payload preserves source paths, model indices, transforms, side and distinct source occurrences', async () => {
  const { capturePcbGeometry } = await geometry;
  const offset = [1, 2, 3];
  const footprints = [
    {
      uuid: 'repeated-source-uuid',
      reference: 'U1',
      at: { position: { x: 11, y: 23 }, rotation: 90 },
      layer: 'F.Cu',
      models: [
        { filename: '${KIPRJMOD}/models/not-loaded.step', hide: true },
        {
          filename: '${KICAD10_3DMODEL_DIR}/Package.3dshapes/QFN.step',
          offset: { xyz: offset },
          rotate: { xyz: [10, 20, 30] },
          scale: { xyz: [1, 2, 3] },
          opacity: 0.4,
        },
      ],
    },
    {
      uuid: 'repeated-source-uuid',
      reference: 'U2',
      at: { position: { x: 30, y: 40 }, rotation: -90 },
      layer: 'B.Cu',
      models: [{ filename: './as authored/model.wrl' }],
    },
  ];
  const actual = await capturePcbGeometry(
    { board: { footprints, *items() {} }, theme: {} },
    { engine: emptyPaintEngine },
  );
  const [front, back] = actual.components;
  assert.equal(front.id, front.footprintId);
  assert.equal(front.footprintId, 'repeated-source-uuid');
  assert.notEqual(back.footprintId, front.footprintId);
  assert.deepEqual(front.at, [11, 23]);
  assert.equal(front.rotation, 90);
  assert.equal(front.side, 'front');
  assert.equal(back.side, 'back');
  assert.deepEqual(front.models[0], {
    index: 0,
    path: '${KIPRJMOD}/models/not-loaded.step',
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    hidden: true,
    opacity: 1,
  });
  assert.equal(front.models[1].index, 1, 'hidden models retain their source index');
  assert.equal(front.models[1].path, footprints[0].models[1].filename);
  assert.equal(back.models[0].path, './as authored/model.wrl');
  assert.deepEqual(front.models[1].offset, [1, 2, 3]);
  assert.deepEqual(front.models[1].rotation, [10, 20, 30]);
  assert.deepEqual(front.models[1].scale, [1, 2, 3]);
  assert.equal(front.models[1].opacity, 0.4);
  assert.notEqual(front.models[1].offset, offset);
  assert.equal(actual.objects.filter(item => item.kind === 'Footprint').length, 2);
  assert.match(actual.warnings.join(' '), /repeated object identifiers/);
});

test('invalid source transforms and legacy model-at offsets are explicit rather than guessed', async () => {
  const { capturePcbGeometry } = await geometry;
  const footprints = [
    {
      reference: 'U1',
      at: { position: { x: 0, y: 0 }, rotation: 0 },
      layer: 'F.Cu',
      models: [
        { filename: 'bad.step', offset: { xyz: [0, NaN, 0] } },
        { filename: 'old.wrl' },
        { filename: 'valid.step' },
        { filename: 'bad-opacity.step', opacity: 2 },
      ],
    },
    { reference: 'invalid-side', layer: 'User.Drawings', models: [{ filename: 'source.step' }] },
  ];
  const sourceText = `(kicad_pcb
    (property "note" "(model quoted (at (xyz 1 2 3)))")
    (footprint "U1" (at 0 0)
      (model "bad.step" (offset (xyz 0 nan 0)))
      (model "old.wrl" (at (xyz 1 2 3)))
      (model "valid.step" (offset (xyz 0 0 0)))
      (model "bad-opacity.step" (opacity 2)))
    (footprint "invalid-side" (model "source.step")))`;
  const actual = await capturePcbGeometry(
    { board: { footprints, *items() {} }, theme: {} },
    { engine: emptyPaintEngine, sourceText },
  );
  const [component, invalid] = actual.components;
  assert.match(component.models[0].error, /invalid/);
  assert.match(component.models[1].error, /Legacy model at offsets/);
  assert.equal(component.models[2].error, undefined, 'quoted words do not mark a valid model');
  assert.match(component.models[3].error, /invalid/);
  assert.match(invalid.error, /position, rotation or side/);
  assert.match(actual.warnings.join(' '), /model references are unsupported or invalid/);
});
