const test = require('node:test');
const assert = require('node:assert/strict');
const { hookHost, loadComponent, nodes, meta } = require('./layout-test-host.cjs');
const streaming = require('../src/layout/layout-streaming.ts');

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
};
function harness(options = {}) {
  const listeners = new Map(),
    timers = new Map(),
    resident = new Map();
  const bitmaps = [],
    cancellations = [],
    requests = [],
    disposed = [];
  let timerId = 0,
    peakTriangles = 0,
    observerCount = 0,
    latestNavigation;
  const source = options.meta || meta;
  const element = { clientWidth: 800, clientHeight: 600 };
  const surface = {
    width: 800,
    height: 600,
    dataset: {},
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  const renderer = {
    draw() {},
    viewBox() {
      return options.region || source.bbox;
    },
    reframe(camera, patch) {
      return { ...camera, ...patch };
    },
    put(resource) {
      resource.image?.close();
      resident.set(resource.key, { triangles: (resource.positions?.length || 0) / 9 });
      peakTriangles = Math.max(
        peakTriangles,
        [...resident.values()].reduce((sum, item) => sum + item.triangles, 0),
      );
    },
    remove(key) {
      resident.delete(key);
    },
    dispose() {
      disposed.push(resident.size);
    },
  };
  const host = hookHost({ div: element, canvas: surface });
  const globals = {
    window: {
      viewerHost: {
        layoutTilesCancel(request) {
          cancellations.push(request);
          return Promise.resolve();
        },
        async layoutTile(request) {
          requests.push(request);
          if (options.response) return options.response(request);
          return {
            ...request,
            mode: 'overview',
            png: 'AA==',
            shapeCount: 0,
            triangleCount: 0,
            limits: { maxShapes: 2000, maxTriangles: 20000, maxSeconds: 2 },
          };
        },
      },
    },
    ResizeObserver: class {
      observe() {
        observerCount++;
      }
      disconnect() {
        observerCount--;
      }
    },
    createImageBitmap: async () => {
      const bitmap = {
        width: 1,
        height: 1,
        closes: 0,
        close() {
          this.closes++;
        },
      };
      bitmaps.push(bitmap);
      if (options.decode) return options.decode(bitmap);
      return bitmap;
    },
    OffscreenCanvas: class {
      getContext() {
        if (options.noContext) return null;
        return {
          drawImage() {},
          getImageData() {
            if (options.readbackError) throw Error('Image readback failed');
            return { data: new Uint8Array([255, 255, 255, 255]) };
          },
        };
      }
    },
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const { Layout3DViewport } = loadComponent(
    'Layout3DViewport.tsx',
    host,
    {
      '../navigation': {
        useViewNavigation(value) {
          latestNavigation = value;
        },
        wheelZoomFactor() {
          return 1;
        },
      },
      './layout-scene': require('../src/layout/layout-scene.ts'),
      './layout-streaming': streaming,
      './layout-stream-scene': { createLayoutStreamScene: () => renderer },
    },
    globals,
  );
  let props = {
    meta: source,
    box: source.bbox,
    visible: source.layers.map(layer => layer.key),
    theme: '02_blueprint',
    spacing: 1,
    active: true,
    selectedLayer: null,
    viewPreset: 'isometric',
    onSelectLayer() {},
    onReturnTo2D() {},
    onViewBox() {},
  };
  function render(patch = {}) {
    props = { ...props, ...patch };
    const tree = host.render(Layout3DViewport, props);
    host.mountEffects();
    return tree;
  }
  async function plan() {
    const entries = [...timers.entries()].filter(([, timer]) => timer.delay === 120);
    assert.equal(entries.length, 1);
    timers.delete(entries[0][0]);
    entries[0][1].callback();
    await flush();
  }
  render();
  return {
    host,
    surface,
    listeners,
    timers,
    resident,
    bitmaps,
    cancellations,
    requests,
    disposed,
    render,
    plan,
    peakTriangles: () => peakTriangles,
    observers: () => observerCount,
    navigation: () => latestNavigation,
  };
}

test('overview readback failures close the decoded bitmap and leave no resident resource', async () => {
  for (const options of [{ readbackError: true }, { noContext: true }]) {
    const view = harness(options);
    await view.plan();
    const tree = view.render();
    assert.equal(view.bitmaps.length, 1);
    assert.equal(view.bitmaps[0].closes, 1, 'decoded bitmap leaked after canvas readback failure');
    assert.equal(view.resident.size, 0);
    assert.equal(view.surface.dataset.failedTiles, '1');
    assert.equal(nodes(tree).find(node => node.props['data-state']).props['data-state'], 'error');
    assert.equal(view.navigation().ready, false);
    view.host.unmount();
    assert.equal(view.listeners.size, 0);
    assert.equal(view.timers.size, 0);
    assert.equal(view.observers(), 0);
  }
});

test('context loss drops resident resources, disables navigation, and cancels late decoding', async () => {
  const view = harness();
  await view.plan();
  view.render();
  assert.equal(view.resident.size, 1);
  let prevented = 0;
  view.listeners.get('webglcontextlost')({
    preventDefault() {
      prevented++;
    },
  });
  const tree = view.render();
  assert.equal(prevented, 1);
  assert.equal(view.resident.size, 0, 'unrecoverable context retained its resident cache');
  assert.equal(view.surface.dataset.cpuBytes, '0');
  assert.equal(view.surface.dataset.gpuBytes, '0');
  assert.equal(view.navigation().ready, false);
  assert.equal(nodes(tree).find(node => node.props['data-state']).props['data-state'], 'error');
  view.host.unmount();
  assert.equal(view.listeners.size, 0);
  assert.equal(view.observers(), 0);
  assert.deepEqual(view.disposed, [0]);

  let resolveBitmap;
  const late = harness({
    decode: bitmap =>
      new Promise(resolve => {
        resolveBitmap = () => resolve(bitmap);
      }),
  });
  await late.plan();
  assert.equal(late.bitmaps.length, 1);
  late.listeners.get('webglcontextlost')({ preventDefault() {} });
  resolveBitmap();
  await flush();
  assert.equal(late.bitmaps[0].closes, 1);
  assert.equal(late.resident.size, 0);
  late.host.unmount();
});

test('repeated mounted 2D/3D transitions reuse bounded resources and remount cleanup is complete', async () => {
  for (let cycle = 0; cycle < 3; cycle++) {
    const view = harness();
    await view.plan();
    assert.equal(view.resident.size, 1);
    for (let transition = 0; transition < 5; transition++) {
      view.render({ active: false });
      await view.plan();
      assert.equal(view.navigation().ready, false);
      view.render({ active: true });
      await view.plan();
      assert.equal(view.resident.size, 1);
      assert.equal(view.requests.length, 1, 'cached overview was needlessly requested again');
    }
    const generations = view.cancellations.map(request => request.generation);
    assert.ok(generations.every((value, index) => !index || value > generations[index - 1]));
    view.host.unmount();
    assert.equal(view.resident.size, 0);
    assert.equal(view.listeners.size, 0);
    assert.equal(view.timers.size, 0);
    assert.equal(view.observers(), 0);
    assert.deepEqual(view.disposed, [0]);
    assert.equal(view.bitmaps[0].closes, 1);
  }
});

test('actual viewport admission retains all overview layers when exact tiles reach the triangle budget', async () => {
  const positions = Buffer.alloc(20000 * 9 * 8).toString('base64');
  const source = {
    ...meta,
    layers: [1, 2, 3, 4].map(layer => ({ key: layer + '/0', name: String(layer) })),
  };
  const view = harness({
    meta: source,
    region: [0, 0, 100, 100],
    response: request =>
      request.mode === 'overview'
        ? {
            ...request,
            mode: 'overview',
            png: 'AA==',
            triangleCount: 0,
            limits: { maxTriangles: 20000 },
          }
        : {
            ...request,
            mode: 'exact',
            positions,
            encoding: 'f64le-xyz',
            triangleCount: 20000,
            limits: { maxTriangles: 20000 },
          },
  });
  await view.plan();
  assert.equal(view.requests.length, 20);
  assert.equal(view.surface.dataset.overviewLayers, '4');
  assert.equal(view.surface.dataset.overviewLayersRequested, '4');
  assert.equal(view.surface.dataset.budgetTiles, '4');
  assert.equal(view.peakTriangles(), 240000);
  assert.ok(
    Number(view.surface.dataset.cpuBytes) <= streaming.DEFAULT_LAYOUT_CACHE_LIMITS.cpuBytes,
  );
  assert.ok(
    Number(view.surface.dataset.gpuBytes) <= streaming.DEFAULT_LAYOUT_CACHE_LIMITS.gpuBytes,
  );
  assert.equal([...view.resident.keys()].filter(key => key.startsWith('root:')).length, 4);
  view.host.unmount();
  assert.equal(view.resident.size, 0);
});
