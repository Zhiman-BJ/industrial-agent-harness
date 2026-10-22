const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWindowLifecycle } = require('./window-lifecycle.cjs');

function fixture() {
  const state = { window: undefined, created: 0, quitting: false };
  const lifecycle = createWindowLifecycle({
    getWindow: () => state.window,
    isQuitting: () => state.quitting,
    createWindow: () => {
      state.created++;
      state.window = {
        destroyed: false,
        minimized: false,
        visible: true,
        focused: true,
        isDestroyed() {
          return this.destroyed;
        },
        isMinimized() {
          return this.minimized;
        },
        restore() {
          this.minimized = false;
        },
        show() {
          this.visible = true;
        },
        focus() {
          this.focused = true;
        },
      };
      return state.window;
    },
  });
  return { state, lifecycle };
}

test('activation recreates a destroyed window and reuses an existing window', async () => {
  const { state, lifecycle } = fixture();
  for (let cycle = 0; cycle < 3; cycle++) {
    const window = await lifecycle.open();
    assert.equal(state.created, cycle + 1);
    assert.equal(await lifecycle.open(), window);
    assert.equal(state.created, cycle + 1);
    window.destroyed = true;
  }
});

test('activation restores and focuses a minimized or hidden window', async () => {
  const { state, lifecycle } = fixture();
  const window = await lifecycle.open();
  window.minimized = true;
  window.visible = false;
  window.focused = false;
  assert.equal(await lifecycle.open(), window);
  assert.equal(window.minimized, false);
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);
  assert.equal(state.created, 1);
});

test('repeated activation shares one pending window creation', async () => {
  let resolve;
  let created = 0;
  const pending = new Promise(done => {
    resolve = done;
  });
  const lifecycle = createWindowLifecycle({
    getWindow: () => undefined,
    isQuitting: () => false,
    createWindow: () => {
      created++;
      return pending;
    },
  });
  const first = lifecycle.open();
  const second = lifecycle.open();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(created, 1);
  const window = {};
  resolve(window);
  assert.equal(await first, window);
});

test('a failed load can be retried by a later activation', async () => {
  let attempts = 0;
  const window = {};
  const lifecycle = createWindowLifecycle({
    getWindow: () => undefined,
    isQuitting: () => false,
    createWindow: () => {
      if (++attempts === 1) throw Error('renderer load failed');
      return window;
    },
  });
  await assert.rejects(lifecycle.open(), /renderer load failed/);
  assert.equal(await lifecycle.open(), window);
  assert.equal(attempts, 2);
});

test('quitting prevents both reactivation and a queued window creation', async () => {
  const { state, lifecycle } = fixture();
  const opening = lifecycle.open();
  state.quitting = true;
  assert.equal(await opening, null);
  assert.equal(await lifecycle.open(), null);
  assert.equal(state.created, 0);
});
