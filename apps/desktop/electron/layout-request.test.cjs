const { test } = require('node:test');
const assert = require('node:assert/strict');
const { layoutRequest } = require('./layout-request.cjs');

function fixture() {
  const state = { ownerClosed: false, senderClosed: false, validations: 0, renders: 0 };
  const frame = {};
  const contents = {
    isDestroyed: () => state.senderClosed,
    get mainFrame() {
      assert.equal(state.senderClosed, false, 'must not read a destroyed sender frame');
      return frame;
    },
  };
  const owner = {
    isDestroyed: () => state.ownerClosed,
    get webContents() {
      assert.equal(state.ownerClosed, false, 'must not read a destroyed window');
      return contents;
    },
  };
  return {
    state,
    request: {
      event: { sender: contents, senderFrame: frame },
      getWindow: () => owner,
      validate: async () => {
        state.validations += 1;
      },
      render: async () => {
        state.renders += 1;
        return { triangles: [1, 2, 3] };
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('live layout requests validate both before and after rendering', async () => {
  const { state, request } = fixture();
  assert.deepEqual(await layoutRequest(request), { triangles: [1, 2, 3] });
  assert.equal(state.validations, 2);
  assert.equal(state.renders, 1);
});

test('closed owner and destroyed sender are discarded without touching destroyed frame properties', async () => {
  for (const field of ['ownerClosed', 'senderClosed']) {
    const { state, request } = fixture();
    state[field] = true;
    assert.equal(await layoutRequest(request), undefined);
    assert.equal(state.validations, 0);
    assert.equal(state.renders, 0);
  }
});

test('a close during source validation never starts the renderer', async () => {
  const { state, request } = fixture();
  const pending = deferred();
  request.validate = () => pending.promise;
  const result = layoutRequest(request);
  state.ownerClosed = true;
  pending.resolve();
  assert.equal(await result, undefined);
  assert.equal(state.renders, 0);
});

test('a close during rendering discards both successful and rejected late responses', async () => {
  for (const fails of [false, true]) {
    const { state, request } = fixture();
    const pending = deferred();
    const started = deferred();
    request.render = () => {
      started.resolve();
      return pending.promise;
    };
    const result = layoutRequest(request);
    await started.promise;
    state.ownerClosed = true;
    if (fails) pending.reject(Error('Renderer closed.'));
    else pending.resolve({ triangles: [] });
    assert.equal(await result, undefined);
    assert.equal(state.validations, 1);
  }
});

test('closing during the final source hash check discards its response', async () => {
  const { state, request } = fixture();
  const pending = deferred();
  const started = deferred();
  request.validate = async () => {
    state.validations += 1;
    if (state.validations === 2) {
      started.resolve();
      await pending.promise;
    }
  };
  const result = layoutRequest(request);
  await started.promise;
  state.senderClosed = true;
  pending.resolve();
  assert.equal(await result, undefined);
});

test('live foreign senders, subframes, identity failures and renderer errors still reject', async () => {
  const foreign = fixture();
  foreign.request.event.sender = { isDestroyed: () => false };
  await assert.rejects(layoutRequest(foreign.request), /only available from the workspace/);
  const subframe = fixture();
  subframe.request.event.senderFrame = {};
  await assert.rejects(layoutRequest(subframe.request), /only available from the workspace/);
  for (const stage of ['validate', 'render']) {
    const { request } = fixture();
    request[stage] = async () => {
      throw Error('active source or renderer failure');
    };
    await assert.rejects(layoutRequest(request), /active source or renderer failure/);
  }
});
