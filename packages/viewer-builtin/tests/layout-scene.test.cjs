const test = require('node:test');
const assert = require('node:assert/strict');
// Node >= 24 (the repository engine) loads this pure, erasable TypeScript directly.
const {
  initialCamera,
  presetCamera,
  projectLayoutVertex,
  pickLayoutLayer,
} = require('../src/layout/layout-scene.ts');

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
}

function triangle(a, b, c) {
  return [a, b, c].flatMap(point => [...point, 0, 0, 1]);
}

function rectangle(left, bottom, right, top, z = 1) {
  return [
    ...triangle([left, bottom, z], [right, bottom, z], [right, top, z]),
    ...triangle([left, bottom, z], [right, top, z], [left, top, z]),
  ];
}

function mesh(key, vertices) {
  return { key, vertices: new Float32Array(vertices) };
}

test('top view aligns the ROI with its 2D extent and preserves XY across layers', () => {
  const camera = presetCamera('top');
  assert.equal(camera.yaw, 0);
  assert.equal(camera.pitch, 0);
  const cases = [
    { aspect: 2, extent: [2, 1], corner: [1, 0.5], expected: [1, 1] },
    { aspect: 1, extent: [2, 1], corner: [1, 0.5], expected: [1, 0.5] },
    { aspect: 0.5, extent: [1, 2], corner: [0.5, 1], expected: [1, 1] },
    { aspect: 2, extent: [1, 2], corner: [0.5, 1], expected: [0.25, 1] },
  ];
  for (const { aspect, extent, corner, expected } of cases) {
    for (const spacing of [0.2, 1, 3]) {
      for (const rank of [0, 3, 7]) {
        for (const z of [0, 1]) {
          const actual = projectLayoutVertex(
            ...corner,
            z,
            camera,
            aspect,
            spacing,
            rank,
            8,
            extent,
          );
          near(actual[0], expected[0], 'top X');
          near(actual[1], expected[1], 'top Y');
        }
      }
    }
  }
  const transformed = projectLayoutVertex(
    0.2,
    -0.1,
    1,
    { ...camera, zoom: 2, panX: 0.1, panY: -0.2 },
    2,
    3,
    7,
    8,
    [2, 1],
  );
  near(transformed[0], 0.5, 'zoomed and panned X');
  near(transformed[1], -0.6, 'zoomed and panned Y');
});

test('projection keeps the expected rotation direction and camera presets independent', () => {
  const top = presetCamera('top');
  const rotated = projectLayoutVertex(0.25, 0.5, 1, { ...top, yaw: Math.PI / 2 }, 1, 1, 0, 1);
  near(rotated[0], -0.5, 'quarter turn X');
  near(rotated[1], 0.25, 'quarter turn Y');
  top.panX = 0.8;
  assert.equal(presetCamera('top').panX, 0);
  assert.equal(presetCamera('isometric').pitch, initialCamera().pitch);
});

test('picking selects the nearest visible layer independently of mesh and visibility order', () => {
  const keys = ['1/0', '4/0', '8/0'];
  const meshes = keys.map(key => mesh(key, rectangle(-0.6, -0.6, 0.6, 0.6)));
  const pick = (items, visible) =>
    pickLayoutLayer(items, keys, presetCamera('top'), 1, 1, visible, 0.5, 0.5);
  for (const order of [meshes, [...meshes].reverse(), [meshes[1], meshes[2], meshes[0]]]) {
    assert.equal(pick(order, keys), '8/0');
    assert.equal(pick(order, [...keys].reverse()), '8/0');
    assert.equal(pick(order, ['4/0', '1/0']), '4/0');
    assert.equal(pick(order, ['1/0']), '1/0');
    assert.equal(pick(order, []), null);
  }
  const unknown = mesh('unregistered', rectangle(-1, -1, 1, 1));
  assert.equal(pick([unknown], ['unregistered']), null);
});

test('picking follows actual triangles, preserving holes and rejecting empty or invalid points', () => {
  const ring = mesh('ring', [
    ...rectangle(-0.8, -0.8, -0.3, 0.8),
    ...rectangle(0.3, -0.8, 0.8, 0.8),
    ...rectangle(-0.3, -0.8, 0.3, -0.3),
    ...rectangle(-0.3, 0.3, 0.3, 0.8),
  ]);
  const degenerate = mesh('line', triangle([-1, 0, 1], [0, 0, 1], [1, 0, 1]));
  const pick = (x, y) =>
    pickLayoutLayer(
      [ring, degenerate],
      ['ring', 'line'],
      presetCamera('top'),
      1,
      1,
      ['ring', 'line'],
      x,
      y,
    );
  // With a square top-view ROI, world XY maps directly to these canvas coordinates.
  for (const point of [
    [0.5, 0.5],
    [0.55, 0.6],
    [0.95, 0.5],
    [0.01, 0.01],
  ]) {
    assert.equal(pick(...point), null, `empty canvas point ${point}`);
  }
  for (const point of [
    [0.75, 0.5],
    [0.25, 0.5],
    [0.5, 0.25],
    [0.5, 0.75],
  ]) {
    assert.equal(pick(...point), 'ring', `ring canvas point ${point}`);
  }
  for (const point of [
    [-0.1, 0.5],
    [1.1, 0.5],
    [0.5, -0.1],
    [0.5, 1.1],
    [NaN, 0.5],
    [0.5, Infinity],
  ]) {
    assert.equal(pick(...point), null);
  }
});

test('picking remains attached to geometry after rotation, pan, zoom, and aspect changes', () => {
  const vertices = triangle([-0.5, -0.4, 1], [0.7, -0.3, 1], [0.1, 0.6, 1]);
  const target = mesh('target', vertices);
  const cameras = [
    presetCamera('top'),
    { ...presetCamera('top'), yaw: Math.PI / 2, panX: 0.2, panY: -0.15 },
    initialCamera(),
    { ...initialCamera(), yaw: 1.8, pitch: 1.3, zoom: 1.5, panX: -0.15, panY: 0.2 },
    { ...initialCamera(), yaw: -2.4, pitch: 0.3, zoom: 0.6, panX: 0.3, panY: -0.2 },
  ];
  for (const camera of cameras) {
    for (const aspect of [0.6, 1, 2]) {
      for (const spacing of [0.2, 3]) {
        // A triangle's barycenter is strictly inside its projected area, independent of camera.
        const center = projectLayoutVertex(0.1, -1 / 30, 1, camera, aspect, spacing, 0, 1);
        const x = (center[0] + 1) / 2,
          y = (1 - center[1]) / 2;
        assert.equal(
          pickLayoutLayer([target], ['target'], camera, aspect, spacing, ['target'], x, y),
          'target',
        );
      }
    }
  }
});
