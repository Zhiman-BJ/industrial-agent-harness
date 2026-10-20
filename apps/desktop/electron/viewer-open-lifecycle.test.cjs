const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ViewerResourceHost } = require('./viewer-resource-host.cjs');

const lifecycleModule = import('../src/components/viewer-open-lifecycle.mjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(hostOptions = {}) {
  const { openViewerLifecycle } = await lifecycleModule;
  const pending = deferred();
  const opened = [];
  const errors = [];
  const released = [];
  const host = {
    open: () => pending.promise,
    releaseViewerResources: request => {
      released.push(request);
    },
    ...hostOptions,
  };
  const lifecycle = openViewerLifecycle(
    host,
    { artifactId: 'artifact-1' },
    {
      onOpened: view => opened.push(view),
      onError: reason => errors.push(reason),
    },
  );
  return { lifecycle, pending, opened, errors, released };
}

test('closing before open resolves releases its late token exactly once', async () => {
  const state = await fixture();
  state.lifecycle.cancel();
  state.lifecycle.cancel();
  state.pending.resolve({ data: { token: 'late-view' } });
  await state.lifecycle.settled;
  state.lifecycle.cancel();
  assert.deepEqual(state.released, [{ token: 'late-view' }]);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.errors, []);
});

test('a fulfilled response closed before a lazy Viewport mounts is still released', async () => {
  const state = await fixture();
  const view = { data: { token: 'uncommitted-view' } };
  state.pending.resolve(view);
  await state.lifecycle.settled;
  assert.deepEqual(state.opened, [view]);
  assert.deepEqual(state.released, []);
  state.lifecycle.commit({ data: { token: 'a-different-view' } });
  state.lifecycle.cancel();
  state.lifecycle.commit(view);
  assert.deepEqual(state.released, [{ token: 'uncommitted-view' }]);
});

test('a committed Viewer keeps ownership through hidden tabs and parent cleanup', async () => {
  const state = await fixture();
  const view = { data: { token: 'mounted-view' } };
  state.pending.resolve(view);
  await state.lifecycle.settled;
  state.lifecycle.commit(view);
  state.lifecycle.commit(view);
  // Hiding a tab performs no cancellation; even eventual parent cleanup leaves
  // disposal to the mounted Viewer rather than releasing the same token twice.
  assert.deepEqual(state.released, []);
  state.lifecycle.cancel();
  assert.deepEqual(state.released, []);
});

test('StrictMode replacement ignores the first result without cancelling the second', async () => {
  const first = await fixture();
  first.lifecycle.cancel();
  const second = await fixture();
  const view = { data: { token: 'current-view' } };
  second.pending.resolve(view);
  await second.lifecycle.settled;
  second.lifecycle.commit(view);
  first.pending.resolve({ data: { token: 'discarded-view' } });
  await first.lifecycle.settled;
  second.lifecycle.cancel();
  assert.deepEqual(first.opened, []);
  assert.deepEqual(first.released, [{ token: 'discarded-view' }]);
  assert.deepEqual(second.opened, [view]);
  assert.deepEqual(second.released, []);
});

test('cancelled open errors never update the replacement view', async () => {
  const old = await fixture();
  old.lifecycle.cancel();
  const current = await fixture();
  old.pending.reject(Error('old source failed'));
  current.pending.reject(Error('current source failed'));
  await Promise.all([old.lifecycle.settled, current.lifecycle.settled]);
  assert.deepEqual(old.errors, []);
  assert.equal(current.errors.length, 1);
  assert.match(current.errors[0].message, /current source/);
});

test('missing tokens and hosts without release support remain compatible', async () => {
  for (const view of [
    undefined,
    {},
    { data: {} },
    { data: { token: 12 } },
    { data: { token: '' } },
  ]) {
    const state = await fixture();
    state.lifecycle.cancel();
    state.pending.resolve(view);
    await state.lifecycle.settled;
    assert.deepEqual(state.released, []);
  }
  const state = await fixture({ releaseViewerResources: undefined });
  state.lifecycle.cancel();
  state.pending.resolve({ data: { token: 'old-host-view' } });
  await state.lifecycle.settled;
  assert.deepEqual(state.errors, []);
});

test('synchronous open errors and rejected disposal do not escape the lifecycle', async () => {
  const state = await fixture({
    open: () => {
      throw Error('host unavailable');
    },
  });
  await state.lifecycle.settled;
  assert.match(state.errors[0].message, /host unavailable/);
  for (const releaseViewerResources of [
    () => {
      throw Error('host closed');
    },
    () => Promise.reject(Error('host closed')),
  ]) {
    const closed = await fixture({ releaseViewerResources });
    closed.lifecycle.cancel();
    closed.pending.resolve({ data: { token: 'closing-view' } });
    await closed.lifecycle.settled;
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('repeated immediate tab closes free real host bindings before its view limit is reached', async () => {
  const { openViewerLifecycle } = await lifecycleModule;
  const sessions = new Set();
  const resourceHost = new ViewerResourceHost({
    context: () => ({}),
    checked: async () => ({}),
    prepare: async () => ({}),
    release: token => sessions.delete(token),
  });
  for (let i = 0; i < 17; i++) {
    const pending = deferred();
    const token = `view-${i}`;
    const opened = [];
    const errors = [];
    const lifecycle = openViewerLifecycle(
      {
        open: () => {
          assert.ok(sessions.size < 16, 'previous closed tabs must not exhaust the runtime limit');
          sessions.add(token);
          resourceHost.bind(token, {});
          return pending.promise;
        },
        releaseViewerResources: request => resourceHost.release(request),
      },
      { artifactId: `artifact-${i}` },
      {
        onOpened: view => opened.push(view),
        onError: reason => errors.push(reason),
      },
    );
    lifecycle.cancel();
    pending.resolve({ data: { token } });
    await lifecycle.settled;
    assert.equal(resourceHost.bindings.size, 0);
    assert.equal(sessions.size, 0);
    assert.deepEqual(opened, []);
    assert.deepEqual(errors, []);
  }
});
