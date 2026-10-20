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
