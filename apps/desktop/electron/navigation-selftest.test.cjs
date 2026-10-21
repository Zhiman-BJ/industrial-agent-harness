const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForFittedView, measureStableLayout } = require('./navigation-selftest.cjs');
const { verifyWheel } = require('./navigation-selftest.cjs');

test('PCB 3D wheel input exceeds the unchanged visible zoom threshold using real OrbitControls', async t => {
  const { PerspectiveCamera } = await import(
    '../../../packages/viewer-builtin/src/kicad/vendor/three/three.module.js'
  );
  const { OrbitControls } = await import(
    '../../../packages/viewer-builtin/src/kicad/vendor/three/controls/OrbitControls.js'
  );
  const originalDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    globalThis.document = originalDocument;
  });
  const listeners = new Map();
  const element = {
    style: {},
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const camera = new PerspectiveCamera(38, 4 / 3, 0.01, 10000);
  camera.position.set(0, 0, 10);
  const controls = new OrbitControls(camera, element);
  t.after(() => controls.dispose());
  const fit = () => {
    camera.position.set(0, 0, 10);
    controls.update();
  };
  const measure = async () => Math.round((10 / camera.position.distanceTo(controls.target)) * 100);
  const dispatch = async (deltaY, ctrlKey) => {
    let consumed = false;
    listeners.get('wheel')({
      deltaY,
      ctrlKey,
      deltaMode: 0,
      clientX: 400,
      clientY: 300,
      preventDefault() {
        consumed = true;
      },
      stopPropagation() {},
    });
    return consumed;
  };
  await dispatch(-60, false);
  assert.ok((await measure()) < 105, 'the old input cannot satisfy a >5% rendered-scale check');
  await verifyWheel({ webContents: { executeJavaScript: async () => fit() } }, measure, dispatch, {
    deltaY: -120,
  });
});

function clock() {
  let time = 0;
  return {
    now: () => time,
    pause: async () => {
      time += 100;
    },
  };
}

test('Fit baseline refits when canvas resizes without changing the previous zoom', async () => {
  let samples = 0,
    width = 337,
    scale = 6.08742774566474,
    refits = 0;
  const read = async () => {
    if (++samples === 4) width = 450; // Native resize preserves the old camera zoom.
    return { scale, ready: true, layoutKey: [width, 609] };
  };
  const result = await waitForFittedView(
    read,
    async () => {
      refits++;
      scale = (6.08742774566474 * width) / 337;
    },
    clock(),
  );
  assert.equal(refits, 1);
  assert.ok(Math.abs(result.scale - 8.128612716763007) < 1e-12);
  assert.equal(await measureStableLayout(read, result), result.scale);
  width = 500;
  await assert.rejects(measureStableLayout(read, result), /layout changed during navigation/);
  assert.equal(refits, 1, 'a post-baseline resize never silently resets tested navigation');
});

test('unstable layout times out within the same deadline instead of retrying indefinitely', async () => {
  let width = 100,
    refits = 0;
  await assert.rejects(
    waitForFittedView(
      async () => ({ scale: 1, layoutKey: ++width }),
      async () => {
        refits++;
      },
      clock(),
    ),
    /baseline did not settle/,
  );
  assert.ok(refits > 0 && refits <= 150, 'all refits share the original 15-second deadline');
});

test('a not-ready viewport is refitted before it can establish a stable baseline', async () => {
  let samples = 0,
    scale = 1,
    refits = 0;
  const result = await waitForFittedView(
    async () => ({ scale, ready: ++samples > 2, layoutKey: [400, 600] }),
    async () => {
      refits++;
      scale = 2;
    },
    clock(),
  );
  assert.equal(result.scale, 2);
  assert.equal(refits, 1);
});
