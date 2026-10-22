const test = require('node:test');
const assert = require('node:assert/strict');
const { hookHost, loadComponent } = require('./layout-test-host.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const meta = {
  token: 'source-one',
  cell: 'test',
  bbox: [0, 0, 1000, 1000],
  klayout: 'test',
  layers: [
    { key: '1/0', name: 'one' },
    { key: '2/0', name: 'two' },
  ],
};

function setup({ active = true, render, decode } = {}) {
  const listeners = new Map(),
    timers = new Map(),
    observers = [],
    calls = [],
    images = [],
    errors = [];
  let nextTimer = 0,
    ready = 0;
  const element = {
    clientWidth: active ? 800 : 0,
    clientHeight: active ? 600 : 0,
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  const context = { fillRect() {}, drawImage() {}, strokeRect() {} };
  const canvas = { width: 800, height: 600, dataset: {}, getContext: () => context };
  const host = hookHost({ div: element, canvas });
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
          this.callback = callback;
          this.disconnected = false;
          observers.push(this);
        }
        observe() {}
        disconnect() {
          this.disconnected = true;
        }
      },
      window: {
        viewerHost: {
          render(request) {
            calls.push(structuredClone(request));
            return render ? render(request) : Promise.resolve({ png: 'AA==', box: request.box });
          },
        },
      },
      createImageBitmap: async () => {
        if (decode) return decode();
        const image = {
          closes: 0,
          close() {
            this.closes++;
          },
        };
        images.push(image);
        return image;
      },
      devicePixelRatio: 1,
      performance: { now: () => 0 },
      setTimeout(callback, delay) {
        timers.set(++nextTimer, { callback, delay });
        return nextTimer;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  const controls = { current: undefined };
  let props = {
    meta,
    active,
    controls,
    onReady() {
      ready++;
    },
    onError(message) {
      errors.push(message);
    },
  };
  function commit(patch = {}) {
    props = { ...props, ...patch };
    host.render(LayoutRasterViewport, props);
    host.mountEffects();
  }
  function resize(width, height) {
    element.clientWidth = width;
    element.clientHeight = height;
    for (const observer of observers) if (!observer.disconnected) observer.callback();
  }
  async function run(delay) {
    const pending = [...timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of pending) if (timers.delete(id)) timer.callback();
    await flush();
  }
  commit();
  if (active) resize(800, 600);
  return {
    host,
    commit,
    resize,
    run,
    controls,
    calls,
    images,
    listeners,
    timers,
    observers,
    errors,
    ready: () => ready,
  };
}

test('hidden raster sends no render requests and resumes with only the final layer, theme and region', async () => {
  const state = setup({ active: false });
  state.controls.current.layers(['1/0']);
  state.controls.current.theme('01_neon');
  state.controls.current.region([0, 0, 400, 400]);
  await state.run(12);
  state.controls.current.layers(['2/0']);
  state.controls.current.theme('03_ember');
  state.controls.current.region([50, 60, 250, 100]);
  await state.run(12);
  await state.run(170);
  await state.run(12);
  assert.equal(
    state.calls.length,
    0,
    `hidden raster issued ${state.calls.length} host render requests`,
  );
  state.commit({ active: true });
  state.resize(300, 900);
  await state.run(12);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0].visible, ['2/0']);
  assert.equal(state.calls[0].theme, '03_ember');
  const box = state.calls[0].box;
  assert.ok(box[0] <= 50 && box[1] <= 60 && box[2] >= 250 && box[3] >= 100);
  assert.equal((box[0] + box[2]) / 2, 150);
  assert.equal((box[1] + box[3]) / 2, 80);
  state.host.unmount();
  assert.equal(state.listeners.size, 0);
  assert.equal(state.timers.size, 0);
  assert.ok(state.observers.every(observer => observer.disconnected));
  assert.ok(state.images.every(image => image.closes === 1));
});

test('an in-flight render completing after unmount cannot publish and closes any late bitmap', async () => {
  const pending = deferred();
  const state = setup({ render: () => pending.promise });
  await state.run(12);
  assert.equal(state.calls.length, 1);
  state.host.unmount();
  assert.equal(state.listeners.size, 0);
  assert.equal(state.timers.size, 0);
  assert.equal(state.controls.current, undefined);
  pending.resolve({ png: 'AA==', box: state.calls[0].box });
  await flush();
  assert.equal(state.ready(), 0);
  assert.deepEqual(state.errors, []);
  assert.ok(state.images.every(image => image.closes === 1));
  assert.equal(state.timers.size, 0);
});

test('a bitmap decode completing after unmount is released exactly once', async () => {
  const decode = deferred();
  const image = {
    closes: 0,
    close() {
      this.closes++;
    },
  };
  const state = setup({ decode: () => decode.promise });
  await state.run(12);
  assert.equal(state.calls.length, 1);
  state.host.unmount();
  decode.resolve(image);
  await flush();
  assert.equal(image.closes, 1);
  assert.equal(state.ready(), 0);
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});

test('hiding during bitmap decoding suppresses late publication and releases the hidden result', async () => {
  const decode = deferred();
  const image = {
    closes: 0,
    close() {
      this.closes++;
    },
  };
  const state = setup({ decode: () => decode.promise });
  await state.run(12);
  state.commit({ active: false });
  state.resize(0, 0);
  decode.resolve(image);
  await flush();
  assert.equal(state.ready(), 0, 'an inactive raster must not publish a newly decoded frame');
  assert.equal(image.closes, 1);
  state.host.unmount();
  assert.equal(state.timers.size, 0);
});
