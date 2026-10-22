const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { presetCamera } = require('../src/layout/layout-scene.ts');
// Transpile the module's extensionless browser import; no WebGL driver is exercised here.
const compiled = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/layout/layout-stream-scene.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const sceneExports = {};
new Function('require', 'exports', compiled)(id => {
  assert.equal(id, './layout-scene');
  return require('../src/layout/layout-scene.ts');
}, sceneExports);
const { createLayoutStreamScene, subtractCoverage } = sceneExports;

function graphics(options = {}) {
  let next = 0,
    boundBuffer;
  const created = [],
    deleted = [],
    uploads = [],
    draws = [];
  const uniforms = new Map();
  const resource = kind => {
    const item = { id: ++next, kind };
    created.push(item);
    return item;
  };
  const gl = {};
  for (const [index, key] of [
    'VERTEX_SHADER',
    'FRAGMENT_SHADER',
    'COMPILE_STATUS',
    'LINK_STATUS',
    'ARRAY_BUFFER',
    'STATIC_DRAW',
    'DYNAMIC_DRAW',
    'TEXTURE_2D',
    'UNPACK_FLIP_Y_WEBGL',
    'TEXTURE_WRAP_S',
    'TEXTURE_WRAP_T',
    'CLAMP_TO_EDGE',
    'TEXTURE_MIN_FILTER',
    'TEXTURE_MAG_FILTER',
    'LINEAR',
    'RGBA',
    'UNSIGNED_BYTE',
    'FLOAT',
    'TRIANGLES',
    'COLOR_BUFFER_BIT',
    'DEPTH_BUFFER_BIT',
    'DEPTH_TEST',
    'BLEND',
    'SRC_ALPHA',
    'ONE_MINUS_SRC_ALPHA',
  ].entries())
    gl[key] = index + 1;
  Object.assign(gl, {
    NO_ERROR: 0,
    createProgram: () => resource('program'),
    createShader: () => resource('shader'),
    createBuffer: () => resource('buffer'),
    createTexture: () => resource('texture'),
    deleteProgram: item => deleted.push(item),
    deleteShader: item => deleted.push(item),
    deleteBuffer: item => deleted.push(item),
    deleteTexture: item => deleted.push(item),
    getShaderParameter: () => !options.compileFailure,
    getProgramParameter: () => !options.linkFailure,
    getAttribLocation: (_program, name) => ({ position: 0, normal: 1, uv: 2 })[name],
    getUniformLocation: (_program, name) => name,
    getError: () => 0,
    bindBuffer: (_target, item) => {
      boundBuffer = item;
    },
    bufferData: (_target, values, usage) =>
      uploads.push({ buffer: boundBuffer, values: new Float32Array(values), usage }),
  });
  for (const key of [
    'shaderSource',
    'compileShader',
    'attachShader',
    'linkProgram',
    'bindTexture',
    'pixelStorei',
    'texParameteri',
    'texImage2D',
    'enableVertexAttribArray',
    'vertexAttribPointer',
    'viewport',
    'clearColor',
    'clear',
    'useProgram',
    'enable',
    'blendFunc',
    'uniform4f',
    'uniform3f',
    'uniform2f',
    'uniform1f',
    'drawArrays',
  ])
    gl[key] = () => {};
  gl.uniform4f = (name, ...values) => uniforms.set(name, values);
  gl.uniform2f = (name, ...values) => uniforms.set(name, values);
  gl.drawArrays = () => draws.push(Object.fromEntries(uniforms));
  const canvas = {
    width: 400,
    height: 400,
    dataset: {},
    getContext: type => {
      assert.equal(type, 'webgl');
      return gl;
    },
  };
  return { canvas, gl, created, deleted, uploads, draws };
}

function exact(key, layer, box, points) {
  return { key, layer, box, mode: 'exact', positions: new Float64Array(points.flat()) };
}
function overview(key, box, mask = new Uint8Array([255, 255, 255, 255])) {
  const image = {
    closed: 0,
    close() {
      this.closed++;
    },
  };
  return { key, layer: '1/0', box, mode: 'overview', mask, width: 2, height: 2, image };
}

test('coarse coverage subtraction preserves the uncovered area without overlap or artificial geometry', () => {
  const original = [0, 0, 10, 10];
  for (const cut of [
    [2, 3, 8, 7],
    [-2, -2, 12, 12],
    [8, -2, 12, 3],
    [10, 0, 12, 10],
  ]) {
    const result = subtractCoverage([original], cut);
    for (const rectangle of result)
      assert.ok(rectangle[2] > rectangle[0] && rectangle[3] > rectangle[1]);
    for (let x = 0.5; x < 10; x++)
      for (let y = 0.5; y < 10; y++) {
        const covered = result.filter(b => x > b[0] && x < b[2] && y > b[1] && y < b[3]).length;
        const removed = x > cut[0] && x < cut[2] && y > cut[1] && y < cut[3];
        assert.equal(covered, removed ? 0 : 1, `coverage at ${x},${y} for ${cut}`);
      }
  }
});

test('adjacent exact tiles retain local precision and meet in a shared camera-relative frame', () => {
  const mock = graphics();
  const scene = createLayoutStreamScene(mock.canvas, [100, 200, 120, 210], ['1/0']);
  scene.put(
    exact(
      'left',
      '1/0',
      [100, 200, 110, 210],
      [
        [100, 200, 1],
        [110, 200, 1],
        [110, 210, 1],
      ],
    ),
  );
  scene.put(
    exact(
      'right',
      '1/0',
      [110, 200, 120, 210],
      [
        [110, 200, 1],
        [120, 200, 1],
        [110, 210, 1],
      ],
    ),
  );
  const xyz = values => [0, 8, 16].map(offset => Array.from(values.slice(offset, offset + 3)));
  assert.deepEqual(xyz(mock.uploads[0].values), [
    [-0.5, -0.5, 1],
    [0.5, -0.5, 1],
    [0.5, 0.5, 1],
  ]);
  assert.deepEqual(xyz(mock.uploads[1].values), [
    [-0.5, -0.5, 1],
    [0.5, -0.5, 1],
    [-0.5, 0.5, 1],
  ]);
  scene.draw(presetCamera('top'), 1, ['1/0'], '02_blueprint', null, new Set(['left', 'right']));
  assert.deepEqual(
    mock.draws.map(draw => draw.origin),
    [
      [-0.5, 0],
      [0.5, 0],
    ],
  );
  const relative = (tile, vertex) => {
    const point = xyz(mock.uploads[tile].values)[vertex];
    return point.slice(0, 2).map((value, axis) => value + mock.draws[tile].origin[axis]);
  };
  assert.deepEqual(relative(0, 1), relative(1, 0));
  assert.deepEqual(relative(0, 2), relative(1, 2));
  assert.deepEqual(Array.from(mock.uploads[0].values.slice(6, 8)), [0, 0]);
  scene.dispose();
});

test('incremental replacement and removal release each GPU resource and decoded bitmap exactly once', () => {
  const mock = graphics();
  const scene = createLayoutStreamScene(mock.canvas, [-1, -1, 1, 1], ['1/0']);
  const tile = exact(
    'mesh',
    '1/0',
    [-1, -1, 1, 1],
    [
      [-1, -1, 1],
      [1, -1, 1],
      [0, 1, 1],
    ],
  );
  assert.deepEqual(scene.put(tile), { cpuBytes: 96, gpuBytes: 96, triangles: 1 });
  const mask = overview('root:mask', [-1, -1, 1, 1]);
  assert.deepEqual(scene.put(mask), { cpuBytes: 4, gpuBytes: 16, triangles: 0 });
  assert.equal(mask.image.closed, 1);
  scene.put(tile);
  scene.remove('root:mask');
  scene.remove('root:mask');
  assert.equal(scene.has('root:mask'), false);
  scene.dispose();
  assert.equal(mask.image.closed, 1);
  assert.equal(new Set(mock.deleted).size, mock.deleted.length);
  assert.deepEqual(new Set(mock.deleted), new Set(mock.created));
});

test('overview masks return approximate hits while exact and empty coverage supersede coarse pixels', () => {
  const mock = graphics();
  const scene = createLayoutStreamScene(mock.canvas, [-1, -1, 1, 1], ['1/0']);
  const mask = overview('root:mask', [-1, -1, 1, 1], new Uint8Array([255, 0, 0, 255]));
  scene.put(mask);
  const active = new Set(['root:mask']);
  const pick = (x, y, visible = ['1/0']) =>
    scene.pick(presetCamera('top'), 1, visible, x, y, active);
  assert.deepEqual(pick(0.25, 0.25), { layer: '1/0', precision: 'overview' });
  assert.equal(pick(0.75, 0.25), null);
  scene.put(
    exact(
      'fine',
      '1/0',
      [0, -1, 1, 0],
      [
        [0.1, -0.1, 1],
        [0.9, -0.1, 1],
        [0.1, -0.9, 1],
      ],
    ),
  );
  active.add('fine');
  assert.deepEqual(pick(0.65, 0.65), { layer: '1/0', precision: 'exact' });
  assert.equal(
    pick(0.95, 0.95),
    null,
    'empty exact triangle area must not fall through to the overview',
  );
  scene.put({ key: 'empty', layer: '1/0', box: [-1, 0, 0, 1], mode: 'empty' });
  active.add('empty');
  assert.equal(pick(0.25, 0.25), null, 'verified empty tile replaces its coarse coverage');
  assert.equal(pick(0.65, 0.65, []), null);
  scene.draw(presetCamera('top'), 1, ['1/0'], '02_blueprint', null, active);
  const plane = mock.uploads.find(upload => upload.usage === mock.gl.DYNAMIC_DRAW);
  assert.ok(plane);
  for (let i = 0; i < plane.values.length; i += 8) {
    const x = plane.values[i],
      y = plane.values[i + 1];
    assert.equal(plane.values[i + 6], (x + 1) / 2);
    assert.equal(plane.values[i + 7], (1 - y) / 2);
  }
  scene.dispose();
});

test('shader initialization failure releases partial resources', () => {
  for (const failure of [{ compileFailure: true }, { linkFailure: true }]) {
    const mock = graphics(failure);
    assert.throws(
      () => createLayoutStreamScene(mock.canvas, [-1, -1, 1, 1], ['1/0']),
      /initialize/,
    );
    assert.deepEqual(new Set(mock.deleted), new Set(mock.created));
  }
});

test('isometric layer separation, clipping, and exact/overview picking stay coherent at extreme zoom', () => {
  const mock = graphics();
  const layers = ['1/0', '2/0'];
  const world = [-1, -1, 1, 1];
  const scene = createLayoutStreamScene(mock.canvas, world, layers);
  scene.put(
    exact('lower', '1/0', world, [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ]),
  );
  scene.put({ ...overview('upper', world), layer: '2/0' });
  const active = new Set(['lower', 'upper']);
  let baselineSeparation;
  const baselineDepths = [];
  for (const zoom of [1, 4096, 65536]) {
    const camera = { ...presetCamera('isometric'), zoom, panX: 0.12, panY: -0.08 };
    const start = mock.draws.length;
    scene.draw(camera, 1.5, layers, '02_blueprint', null, active);
    const draws = mock.draws.slice(start);
    assert.equal(draws.length, 2);
    // Read actual draw uniforms and independently project the world origin as the shader does.
    const projected = (draw, z) => {
      const [yaw, pitch, scale, depthCenter] = draw.camera;
      const [aspect, panX, panY, depthZoom] = draw.frame;
      const [offset, thickness] = draw.layer;
      assert.ok(Number.isFinite(yaw) && aspect > 0);
      const height = offset + z * thickness;
      // Both resources share the world-center origin. Exact tiles carry the focus
      // offset in this uniform; overview planes bake the same offset into vertices.
      const [worldX, worldY] = draws[0].origin;
      const rx = Math.cos(yaw) * worldX - Math.sin(yaw) * worldY;
      const ry = Math.sin(yaw) * worldX + Math.cos(yaw) * worldY;
      return [
        (rx * scale) / aspect + panX,
        (Math.cos(pitch) * ry + Math.sin(pitch) * height) * scale + panY,
        (Math.sin(pitch) * (ry - depthCenter) - Math.cos(pitch) * height) * depthZoom * 0.05,
      ];
    };
    const separation = projected(draws[1], 0.5)[1] - projected(draws[0], 0.5)[1];
    if (zoom === 1) baselineSeparation = separation;
    assert.ok(baselineSeparation > 0.1, 'layers must remain visibly separated');
    assert.ok(
      Math.abs(separation - baselineSeparation) < 1e-12,
      `zoom ${zoom} must not multiply the illustrative Z separation`,
    );
    for (const [index, z, precision] of [
      [0, 1, 'exact'],
      [1, 0.5, 'overview'],
    ]) {
      const [x, y, depth] = projected(draws[index], z);
      assert.ok(
        Math.abs(x) < 1 && Math.abs(y) < 1 && Math.abs(depth) < 1,
        `layer ${index} stays inside the screen and clip depth at zoom ${zoom}`,
      );
      if (zoom === 1) baselineDepths[index] = depth;
      assert.ok(Math.abs(depth - baselineDepths[index]) < 1e-12);
      assert.deepEqual(scene.pick(camera, 1.5, [layers[index]], (x + 1) / 2, (1 - y) / 2, active), {
        layer: layers[index],
        precision,
      });
      const box = scene.viewBox(camera, 1.5, [layers[index]]);
      assert.ok(
        box[0] <= 0 && box[1] <= 0 && box[2] >= 0 && box[3] >= 0,
        `the requested view must contain the picked world origin at zoom ${zoom}`,
      );
    }
  }
  scene.dispose();
});

test('a remote one-DBU line remains distinct in float32 GPU inputs after a high-zoom camera rebase', () => {
  const mock = graphics();
  const world = [0, 0, 1e9, 1e9],
    tile = [1e9 - 1, 1e9 - 1, 1e9, 1e9];
  const center = 1e9 - 0.5,
    dbu = 0.001,
    zoom = 1e9;
  const left = center - dbu / 2,
    right = center + dbu / 2;
  const bottom = center - 0.02,
    top = center + 0.02;
  const scene = createLayoutStreamScene(mock.canvas, world, ['1/0']);
  scene.put(
    exact('remote', '1/0', tile, [
      [left, bottom, 1],
      [right, bottom, 1],
      [right, top, 1],
      [left, bottom, 1],
      [right, top, 1],
      [left, top, 1],
    ]),
  );
  const scale = 2 / 1e9;
  const normalizedCenter = (center - 5e8) * scale;
  const camera = {
    ...presetCamera('top'),
    zoom,
    panX: -normalizedCenter * zoom,
    panY: -normalizedCenter * zoom,
  };
  const active = new Set(['remote']);
  scene.draw(camera, 1, ['1/0'], '02_blueprint', null, active);
  const draw = mock.draws[0],
    values = mock.uploads[0].values,
    f = Math.fround;
  // This fixture would collapse if XY were first stored as global normalized float32.
  assert.equal(f((left - 5e8) * scale), f((right - 5e8) * scale));
  const screenX = offset => f(f(f(values[offset]) + f(draw.origin[0])) * f(draw.camera[2]));
  const width = screenX(8) - screenX(0);
  const expected = (right - left) * scale * zoom;
  assert.ok(width > 0.001 && width < 0.003, 'the one-DBU line must retain a nonzero screen width');
  assert.ok(
    Math.abs(width - expected) / expected < 1e-6,
    'float32 projection retains the source width',
  );
  assert.deepEqual(
    draw.frame.slice(1, 3),
    [0, 0],
    'large pan is removed before float32 projection',
  );
  assert.deepEqual(scene.pick(camera, 1, ['1/0'], 0.5, 0.5, active), {
    layer: '1/0',
    precision: 'exact',
  });
  const box = scene.viewBox(camera, 1, ['1/0']);
  assert.ok(box[0] <= left && box[1] <= bottom && box[2] >= right && box[3] >= top);
  scene.dispose();
});

test('reframing preserves a remote world focus through zoom, rotation, top view, spacing and resize', () => {
  const mock = graphics();
  const world = [0, 0, 1e9, 1e9],
    target = [8e8, 2e8];
  const box = [target[0] - 1e4, target[1] - 1e4, target[0] + 1e4, target[1] + 1e4];
  const scene = createLayoutStreamScene(mock.canvas, world, ['1/0']);
  scene.put(
    exact('remote', '1/0', box, [
      [box[0], box[1], 1],
      [box[2], box[1], 1],
      [box[2], box[3], 1],
      [box[0], box[1], 1],
      [box[2], box[3], 1],
      [box[0], box[3], 1],
    ]),
  );
  let camera = { ...presetCamera('isometric'), zoom: 4096 };
  let spacing = 1;
  // Set the initial camera from a known source point without calling focusAt.
  const x = 0.6,
    y = -0.6,
    scale = (1.6 / 2.85) * camera.zoom;
  camera.panX = -(Math.cos(camera.yaw) * x - Math.sin(camera.yaw) * y) * scale;
  camera.panY =
    -Math.cos(camera.pitch) * (Math.sin(camera.yaw) * x + Math.cos(camera.yaw) * y) * scale;
  const active = new Set(['remote']);
  const check = label => {
    scene.draw(camera, spacing, ['1/0'], '02_blueprint', null, active);
    const draw = mock.draws.at(-1);
    // The known tile center must be the floating origin, independently of the
    // inverse-camera helper used by reframe and focusAt.
    assert.ok(
      draw.origin.every(value => Math.abs(value) < 1e-14),
      `${label}: GPU origin drift`,
    );
    const [yaw, pitch, zoomScale] = draw.camera;
    const [aspect] = draw.frame;
    const [ox, oy] = draw.origin;
    const [offset, thickness] = draw.layer;
    const px = ((Math.cos(yaw) * ox - Math.sin(yaw) * oy) * zoomScale) / aspect;
    const py =
      (Math.cos(pitch) * (Math.sin(yaw) * ox + Math.cos(yaw) * oy) +
        Math.sin(pitch) * (offset + thickness)) *
      zoomScale;
    assert.deepEqual(
      scene.pick(camera, spacing, ['1/0'], (px + 1) / 2, (1 - py) / 2, active),
      { layer: '1/0', precision: 'exact' },
      `${label}: drawing and picking disagree`,
    );
    const view = scene.viewBox(camera, spacing, ['1/0']);
    assert.ok(
      view[0] < target[0] && view[1] < target[1] && view[2] > target[0] && view[3] > target[1],
      `${label}: visible tile requests drifted away from the source point`,
    );
    if (camera.view === 'top') {
      assert.ok(Math.abs((view[0] + view[2]) / 2 - target[0]) < 1e-5);
      assert.ok(Math.abs((view[1] + view[3]) / 2 - target[1]) < 1e-5);
    }
  };
  check('initial');
  camera = scene.reframe(camera, { zoom: 2 ** 20 }, spacing);
  check('zoom');
  camera = scene.reframe(camera, { yaw: 0.9, pitch: 1.2 }, spacing);
  check('rotation');
  camera = scene.reframe(camera, {}, spacing, 3);
  spacing = 3;
  check('spacing');
  camera = scene.reframe(camera, { view: 'top', yaw: 0, pitch: 0 }, spacing);
  check('top view');
  const retainedFocus = scene.focus(camera, spacing);
  mock.canvas.width = 1000;
  mock.canvas.height = 350;
  camera = scene.focusAt(camera, retainedFocus, spacing);
  check('resize');
  scene.dispose();
});
