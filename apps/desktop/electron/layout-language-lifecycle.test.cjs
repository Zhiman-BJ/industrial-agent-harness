const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  hookHost,
  loadComponent,
  nodes,
  meta,
} = require('../../../packages/viewer-builtin/tests/layout-test-host.cjs');
const streaming = require('../../../packages/viewer-builtin/src/layout/layout-streaming.ts');
const sceneMath = require('../../../packages/viewer-builtin/src/layout/layout-scene.ts');
const core = import('../src/i18n/core.ts');

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
};

// Real component effects and real desktop translations, with explicit graphics,
// timers and host-IPC doubles. This does not claim native UI or GPU acceptance.
function graphicsDoubles() {
  const listeners = new Map(),
    timers = new Map(),
    residents = new Map();
  const images = [],
    requests = [],
    cancellations = [],
    draws = [],
    observers = [];
  const counts = { scenes: 0, disposals: 0, timers: 0, listeners: 0 };
  let timerId = 0;
  const element = { clientWidth: 800, clientHeight: 600 };
  const surface = {
    width: 800,
    height: 600,
    dataset: {},
    addEventListener(name, callback) {
      counts.listeners++;
      assert.equal(listeners.has(name), false, `duplicate ${name} listener`);
      listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      assert.equal(listeners.get(name), callback);
      listeners.delete(name);
    },
  };
  const renderer = {
    draw(camera, spacing, visible, theme, selectedLayer) {
      draws.push({
        camera: structuredClone(camera),
        spacing,
        visible: [...visible],
        theme,
        selectedLayer,
      });
    },
    viewBox: () => meta.bbox,
    reframe: (camera, patch) => ({ ...camera, ...patch }),
    put(resource) {
      resource.image?.close();
      residents.set(resource.key, resource);
    },
    remove: key => residents.delete(key),
    dispose() {
      assert.equal(residents.size, 0, 'dispose must follow resident-cache cleanup');
      counts.disposals++;
    },
  };
  const globals = {
    window: {
      viewerHost: {
        layoutTilesCancel(request) {
          cancellations.push(structuredClone(request));
          return Promise.resolve();
        },
        async layoutTile(request) {
          requests.push(structuredClone(request));
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
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    createImageBitmap: async () => {
      const image = {
        width: 1,
        height: 1,
        closes: 0,
        close() {
          this.closes++;
        },
      };
      images.push(image);
      return image;
    },
    OffscreenCanvas: class {
      getContext() {
        return {
          drawImage() {},
          getImageData: () => ({ data: new Uint8Array([255, 255, 255, 255]) }),
        };
      }
    },
    setTimeout(callback, delay) {
      counts.timers++;
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
  };
  return {
    globals,
    element,
    surface,
    renderer,
    listeners,
    timers,
    residents,
    images,
    requests,
    cancellations,
    draws,
    observers,
    counts,
  };
}

test('20 English/Chinese round trips preserve the ready 3D scene, moved camera and selected layer without native work', async () => {
  const { translate } = await core;
  const doubles = graphicsDoubles();
  const host = hookHost({ div: doubles.element, canvas: doubles.surface });
  let locale = 'en',
    navigation;
  const props = {
    meta,
    box: meta.bbox,
    visible: ['1/0'],
    theme: '02_blueprint',
    spacing: 1,
    active: true,
    selectedLayer: '1/0',
    viewPreset: 'isometric',
    onSelectLayer() {
      assert.fail('language changes must not change selection');
    },
    onReturnTo2D() {
      assert.fail('language changes must not change viewing mode');
    },
    onViewBox() {},
  };
  const { Layout3DViewport } = loadComponent(
    'Layout3DViewport.tsx',
    host,
    {
      '../text': { useDisplayText: () => ({ t: (key, values) => translate(locale, key, values) }) },
      '../navigation': {
        useViewNavigation(value) {
          navigation = value;
        },
        wheelZoomFactor: () => 1,
      },
      './layout-scene': sceneMath,
      './layout-streaming': streaming,
      './layout-stream-scene': {
        createLayoutStreamScene() {
          doubles.counts.scenes++;
          return doubles.renderer;
        },
      },
    },
    doubles.globals,
  );
  function render() {
    const tree = host.render(Layout3DViewport, props);
    host.mountEffects();
    return tree;
  }
  async function plan() {
    const pending = [...doubles.timers].filter(([, timer]) => timer.delay === 120);
    assert.equal(pending.length, 1);
    doubles.timers.delete(pending[0][0]);
    pending[0][1].callback();
    await flush();
  }
  render();
  await plan();
  render();
  assert.equal(navigation.ready, true);
  assert.equal(doubles.residents.size, 1);
  const initial = doubles.draws.at(-1).camera;
  const key = doubles.listeners.get('keydown');
  key({ key: 'ArrowRight', shiftKey: false, preventDefault() {} });
  key({ key: 'ArrowUp', shiftKey: true, preventDefault() {} });
  await plan();
  render();
  const moved = structuredClone(doubles.draws.at(-1));
  assert.notEqual(moved.camera.yaw, initial.yaw);
  assert.notEqual(moved.camera.panY, initial.panY);
  assert.equal(moved.selectedLayer, '1/0');
  const baseline = {
    requests: doubles.requests.length,
    cancellations: doubles.cancellations.length,
    counters: { ...doubles.counts },
    observers: doubles.observers.length,
    resource: [...doubles.residents.values()][0],
    bitmap: doubles.images[0],
    listeners: new Map(doubles.listeners),
  };
  const instruction =
    '3D layout: click to select a layer, drag to rotate, Shift-drag to pan; Home fits.';
  assert.notEqual(translate('zh-CN', instruction), translate('en', instruction));
  for (let cycle = 0; cycle < 20; cycle++) {
    for (const language of ['zh-CN', 'en']) {
      locale = language;
      const tree = render();
      const canvas = nodes(tree).find(node => node.type === 'canvas');
      assert.equal(canvas.props['aria-label'], translate(language, instruction));
      const overview = nodes(tree).find(
        node =>
          node.props.children === translate(language, 'Overview pixels · zoom in for exact detail'),
      );
      assert.ok(overview, `status text did not switch to ${language}`);
      assert.equal(navigation.ready, true);
      assert.deepEqual(doubles.draws.at(-1), moved);
      assert.equal(props.selectedLayer, '1/0');
      assert.deepEqual(doubles.counts, baseline.counters);
      assert.equal(doubles.requests.length, baseline.requests);
      assert.equal(doubles.cancellations.length, baseline.cancellations);
      assert.equal(doubles.observers.length, baseline.observers);
      assert.deepEqual(doubles.listeners, baseline.listeners);
      assert.equal(doubles.timers.size, 0);
      assert.equal(doubles.residents.size, 1);
      assert.equal([...doubles.residents.values()][0], baseline.resource);
      assert.equal(doubles.images.length, 1);
      assert.equal(doubles.images[0], baseline.bitmap);
      assert.equal(doubles.images[0].closes, 1);
    }
  }
  assert.equal(doubles.counts.scenes, 1);
  host.unmount();
  assert.equal(doubles.residents.size, 0);
  assert.equal(doubles.listeners.size, 0);
  assert.equal(doubles.timers.size, 0);
  assert.ok(doubles.observers.every(observer => observer.disconnected));
  assert.equal(doubles.counts.disposals, 1);
  assert.equal(doubles.images[0].closes, 1);
});
