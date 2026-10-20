const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ViewerResourceHost } = require('./viewer-resource-host.cjs');

const binding = {
  projectId: 'project-1',
  domain: 'example-domain',
  root: '/project-1',
  artifactId: 'board-1',
  sha256: 'source-hash',
  file: '/project-1/design.pcb',
};
function fixture(prepare) {
  const state = {
    context: { ...binding },
    entry: { artifact: { sha256: binding.sha256 }, file: binding.file },
    checks: 0,
  };
  const host = new ViewerResourceHost({
    context: () => state.context,
    checked: async id => {
      assert.equal(id, binding.artifactId);
      state.checks++;
      return state.entry;
    },
    prepare: prepare || (async token => ({ token, ready: true })),
  });
  host.bind('opaque-token', binding);
  return { host, state };
}

test('opening and binding a Viewer does not download; explicit prepare checks its artifact twice', async () => {
  let calls = 0;
  const { host, state } = fixture(async token => {
    calls++;
    return { token, ready: true };
  });
  assert.equal(calls, 0);
  assert.deepEqual(await host.prepare({ token: 'opaque-token' }), {
    token: 'opaque-token',
    ready: true,
  });
  assert.equal(calls, 1);
  assert.equal(state.checks, 2);
});

test('unbound tokens, extra renderer paths and changed projects cannot trigger a download', async () => {
  let calls = 0;
  const { host, state } = fixture(async () => {
    calls++;
  });
  await assert.rejects(host.prepare({ token: 'other' }), /session changed/);
  await assert.rejects(
    host.prepare({ token: 'opaque-token', url: 'https://untrusted.invalid/' }),
    /Invalid/,
  );
  state.context = { ...binding, projectId: 'project-2' };
  await assert.rejects(host.prepare({ token: 'opaque-token' }), /project changed/);
  assert.equal(calls, 0);
});

test('replacement artifact bytes or paths are rejected before downloading', async () => {
  let calls = 0;
  const { host, state } = fixture(async () => {
    calls++;
  });
  state.entry = { artifact: { sha256: 'changed' }, file: binding.file };
  await assert.rejects(host.prepare({ token: 'opaque-token' }), /source changed/);
  state.entry = { artifact: { sha256: binding.sha256 }, file: '/outside/design.pcb' };
  await assert.rejects(host.prepare({ token: 'opaque-token' }), /source changed/);
  assert.equal(calls, 0);
});

test('releasing the Viewer cancels its in-flight work and rejects its stale result', async () => {
  let release;
  let signal;
  const { host } = fixture(async (_token, options) => {
    signal = options.signal;
    await new Promise(resolve => {
      release = resolve;
    });
    return { ready: true };
  });
  const pending = host.prepare({ token: 'opaque-token' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  host.release({ token: 'opaque-token' });
  host.bind('new-token', binding);
  assert.equal(signal.aborted, true);
  release();
  await assert.rejects(pending, /session changed/);
  assert.throws(() => host.cancel({ token: 'opaque-token' }), /session changed/);
});

test('retained Viewer tabs keep independent bindings and release only their own resources', async () => {
  const { host } = fixture();
  host.bind('second-token', binding);
  assert.deepEqual(await host.prepare({ token: 'opaque-token' }), {
    token: 'opaque-token',
    ready: true,
  });
  assert.deepEqual(host.release({ token: 'second-token' }), { released: true });
  assert.deepEqual(await host.prepare({ token: 'opaque-token' }), {
    token: 'opaque-token',
    ready: true,
  });
  assert.deepEqual(host.release({ token: 'second-token' }), { released: false });
});

test('cancel is scoped to the current token and permits a later retry', async () => {
  let release;
  const { host } = fixture(async (_token, { signal }) => {
    await new Promise(resolve => {
      release = resolve;
    });
    signal.throwIfAborted();
    return { ready: true };
  });
  const pending = host.prepare({ token: 'opaque-token' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(host.prepare({ token: 'opaque-token' }), /already downloading/);
  assert.deepEqual(host.cancel({ token: 'opaque-token' }), { cancelled: true });
  release();
  await assert.rejects(pending, /cancelled/);
  const retry = host.prepare({ token: 'opaque-token' });
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await retry, { ready: true });
});

test('a project or artifact replacement during a transfer cannot publish success', async () => {
  const first = fixture(async () => {
    first.state.context = { ...binding, domain: 'other-domain' };
    return {};
  });
  await assert.rejects(first.host.prepare({ token: 'opaque-token' }), /project changed/);
  const second = fixture(async () => {
    second.state.entry = { artifact: { sha256: 'new-hash' }, file: binding.file };
    return {};
  });
  await assert.rejects(second.host.prepare({ token: 'opaque-token' }), /session changed/);
});
