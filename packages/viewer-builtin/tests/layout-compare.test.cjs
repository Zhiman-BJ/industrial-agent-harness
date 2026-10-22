const test = require('node:test');
const assert = require('node:assert/strict');
const { hookHost, loadComponent, nodes } = require('./layout-test-host.cjs');

const meta = {
  token: 'test-source',
  cell: 'top',
  bbox: [0, 0, 1000, 1000],
  klayout: 'test',
  layers: [{ key: '1/0', name: '1/0' }],
};

test('Compare uses the latest 3D region immediately, before a render or deferred tile plan', () => {
  const host = hookHost();
  const Raster = () => {},
    Solid = () => {};
  const { LayoutViewport } = loadComponent('LayoutViewport.tsx', host, {
    'lucide-react': { Layers: () => {} },
    '../navigation': { ViewNavigationContext: { Provider: Symbol('navigation') } },
    './LayoutRasterViewport': { LayoutRasterViewport: Raster },
    './Layout3DViewport': { Layout3DViewport: Solid },
  });
  const props = {
    meta,
    onReady() {},
    onError(message) {
      assert.fail(message);
    },
  };
  const shell = LayoutViewport(props);
  let tree = host.render(shell.type, shell.props);
  const regions = [],
    layerSets = [];
  const raster = nodes(tree).find(node => node.type === Raster);
  raster.props.controls.current = {
    box: () => [0, 0, 1000, 1000],
    region: box => regions.push([...box]),
    layers: layers => layerSets.push([...layers]),
  };
  raster.props.onReady();
  tree = host.render(shell.type, shell.props);
  nodes(tree)
    .find(node => node.props['aria-label'] === '2.5D layout')
    .props.onClick();
  tree = host.render(shell.type, shell.props);
  nodes(tree)
    .find(node => node.type === Solid)
    .props.onSelectLayer('1/0');
  tree = host.render(shell.type, shell.props);
  nodes(tree)
    .find(node => node.type === Solid)
    .props.onViewBox([10, 20, 110, 120]);
  tree = host.render(shell.type, shell.props);
  const compare = nodes(tree).find(
    node => node.type === 'button' && node.props.children === 'Compare selected in 2D',
  );
  const current = [410, 520, 430, 560];
  // No re-render or timer advance occurs between the camera update and Compare.
  nodes(tree)
    .find(node => node.type === Solid)
    .props.onViewBox(current);
  compare.props.onClick();
  assert.deepEqual(regions, [current]);
  assert.deepEqual(layerSets.at(-1), ['1/0']);
  tree = host.render(shell.type, shell.props);
  assert.equal(
    nodes(tree).find(node => node.props.className === 'rp-layout-pane').props.hidden,
    false,
  );
});

test('Compare fits a pending ROI after the hidden raster returns at a new aspect ratio', () => {
  const strokes = [],
    observers = [],
    timers = new Map();
  let timerId = 0;
  const element = {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
  };
  const context = { fillRect() {}, drawImage() {}, strokeRect: (...rect) => strokes.push(rect) };
  const surface = { width: 800, height: 600, dataset: {}, getContext: () => context };
  const host = hookHost({ div: element, canvas: surface });
  const { LayoutRasterViewport } = loadComponent(
    'LayoutRasterViewport.tsx',
    host,
    {
      '../navigation': {
        useViewNavigation() {},
        wheelZoomFactor() {
          return 1;
        },
      },
    },
    {
      ResizeObserver: class {
        constructor(callback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
      devicePixelRatio: 1,
      performance: { now: () => 0 },
      setTimeout(callback) {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  const controls = { current: undefined };
  host.render(LayoutRasterViewport, {
    meta,
    controls,
    onReady() {},
    onError(message) {
      assert.fail(message);
    },
  });
  host.mountEffects();
  observers[0]();
  // The 2D canvas is hidden while 3D is resized from landscape to a narrow pane.
  element.clientWidth = 0;
  element.clientHeight = 0;
  const roi = [50, 60, 250, 100];
  controls.current.region(roi);
  observers[0]();
  element.clientWidth = 300;
  element.clientHeight = 900;
  observers[0]();
  const actual = controls.current.box();
  assert.ok(
    actual[0] <= roi[0] && actual[1] <= roi[1] && actual[2] >= roi[2] && actual[3] >= roi[3],
    `visible raster ${actual} clips compared region ${roi}`,
  );
  assert.equal((actual[0] + actual[2]) / 2, (roi[0] + roi[2]) / 2);
  assert.equal((actual[1] + actual[3]) / 2, (roi[1] + roi[3]) / 2);
  const [x, y, width, height] = strokes.at(-1);
  assert.ok(
    x >= -1e-8 &&
      y >= -1e-8 &&
      x + width <= surface.width + 1e-8 &&
      y + height <= surface.height + 1e-8,
    'the compared region outline must remain inside the resized raster',
  );
  host.unmount();
  assert.equal(controls.current, undefined);
  assert.equal(timers.size, 0);
});

test('inspecting a hidden layer describes its visibility accurately without enabling it', () => {
  const host = hookHost();
  const Raster = () => {},
    Solid = () => {};
  const { LayoutViewport } = loadComponent('LayoutViewport.tsx', host, {
    'lucide-react': { Layers: () => {} },
    '../navigation': { ViewNavigationContext: { Provider: Symbol('navigation') } },
    './LayoutRasterViewport': { LayoutRasterViewport: Raster },
    './Layout3DViewport': { Layout3DViewport: Solid },
  });
  const shell = LayoutViewport({
    meta,
    onReady() {},
    onError(message) {
      assert.fail(message);
    },
  });
  let tree = host.render(shell.type, shell.props);
  const raster = nodes(tree).find(node => node.type === Raster);
  raster.props.controls.current = { box: () => meta.bbox, layers() {} };
  raster.props.onReady();
  tree = host.render(shell.type, shell.props);
  nodes(tree)
    .find(node => node.props['aria-label'] === '2.5D layout')
    .props.onClick();
  tree = host.render(shell.type, shell.props);
  nodes(tree)
    .find(node => node.props['aria-label'] === 'Show layer 1/0')
    .props.onChange();
  tree = host.render(shell.type, shell.props);
  nodes(tree)
    .find(node => node.props['data-layer-key'] === '1/0')
    .props.onClick();
  tree = host.render(shell.type, shell.props);
  const solid = nodes(tree).find(node => node.type === Solid);
  assert.equal(solid.props.selectedLayer, '1/0');
  assert.deepEqual(solid.props.visible, []);
  assert.ok(
    nodes(tree).some(
      node => node.props.children === 'Selected layer is hidden. Enable its visibility to show it.',
    ),
  );
  assert.ok(
    !nodes(tree).some(
      node => node.props.children === 'Selected layer highlighted through other layers',
    ),
  );
});

test('the actual 3D pointer handler publishes its new region before the deferred tile plan runs', () => {
  const listeners = new Map(),
    timers = new Map(),
    calls = [];
  let timerId = 0;
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
    setPointerCapture() {},
    focus() {},
  };
  // The first overview has already arrived. Loading behavior is covered separately;
  // this fixture enters the real component's ready interaction state directly.
  const host = hookHost({ div: element, canvas: surface }, value =>
    value === 'loading' ? 'ready' : value,
  );
  const renderer = {
    viewBox(camera) {
      return [camera.panX * 100, camera.panY * 100, camera.panX * 100 + 10, camera.panY * 100 + 20];
    },
    draw(camera) {
      calls.push({ type: 'draw', panX: camera.panX, panY: camera.panY });
    },
    reframe(camera, patch) {
      return { ...camera, ...patch };
    },
    remove() {},
    dispose() {},
  };
  const { Layout3DViewport } = loadComponent(
    'Layout3DViewport.tsx',
    host,
    {
      '../navigation': {
        useViewNavigation() {},
        wheelZoomFactor() {
          return 1;
        },
      },
      './layout-scene': require('../src/layout/layout-scene.ts'),
      './layout-streaming': require('../src/layout/layout-streaming.ts'),
      './layout-stream-scene': { createLayoutStreamScene: () => renderer },
    },
    {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      window: { viewerHost: { layoutTilesCancel: () => Promise.resolve() } },
      setTimeout(callback, delay) {
        timers.set(++timerId, { callback, delay });
        return timerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  host.render(Layout3DViewport, {
    meta,
    box: meta.bbox,
    visible: ['1/0'],
    theme: '02_blueprint',
    spacing: 1,
    active: true,
    selectedLayer: null,
    viewPreset: 'isometric',
    onSelectLayer() {},
    onReturnTo2D() {},
    onViewBox(box) {
      calls.push({ type: 'publish', box: [...box] });
    },
  });
  host.mountEffects();
  calls.length = 0;
  listeners.get('pointerdown')({
    button: 0,
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    shiftKey: true,
  });
  listeners.get('pointermove')({ pointerId: 1, clientX: 180, clientY: 160 });
  // No scheduled callback, React re-render, worker response, or tile load has run.
  assert.deepEqual(calls, [
    { type: 'publish', box: [20, -20, 30, 0] },
    { type: 'draw', panX: 0.2, panY: -0.2 },
  ]);
  assert.deepEqual(JSON.parse(surface.dataset.viewBox), [20, -20, 30, 0]);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 120, 'the tile plan remains deferred');
  host.unmount();
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
});
