const test = require('node:test');
const assert = require('node:assert/strict');
const { releasePreparedSession } = require('../src/remote-preparation-session.cjs');
const { planningGateway } = require('./helpers/planning-gateway.cjs');

function fixture() {
  const binding = {
    key: 'session-key',
    clientSessionId: 'client-session',
    remoteProjectId: 'remote-project',
  };
  const current = {
    id: 'application-session',
    projectId: binding.remoteProjectId,
    domain: 'test',
    clientSessionId: binding.clientSessionId,
    status: 'ready',
    callLocked: false,
  };
  const calls = [];
  const control = { current, binding, identity: 'service-identity', unresolved: false };
  const settings = {
    identity: () => control.identity,
    sessionBinding: () => ({ ...control.binding }),
    project: () => ({ location: 'remote' }),
    assertTaskIdle: () => {
      if (control.unresolved) throw Error('A remote invocation remains active or unknown.');
    },
    client: (input, options) => {
      calls.push({ type: 'client', input, options });
      return {
        currentSession: async ({ signal }) => {
          options.assertCurrent();
          calls.push({ type: 'current', signal });
          if (control.missing) throw Object.assign(Error('Missing'), { code: 'SESSION_NOT_FOUND' });
          await control.beforeCurrent?.();
          return { ...control.current };
        },
        terminateSession: async (id, { signal }) => {
          options.assertCurrent();
          calls.push({ type: 'terminate', id, signal });
          await control.beforeTerminate?.();
          return { ...control.current, status: 'stopped', ...control.stopped };
        },
        close: async () => calls.push({ type: 'close' }),
      };
    },
    sessions: {
      update: (value, patch) => {
        calls.push({ type: 'update', value, patch });
        return { ...value, ...patch };
      },
      renewReleased: (value, id) => calls.push({ type: 'renew', value, id }),
    },
  };
  return {
    calls,
    control,
    release: (options = {}) =>
      releasePreparedSession(settings, '/project', 'test', 'chat', {
        expectedClientSessionId: 'client-session',
        ...options,
      }),
  };
}

test('idle preparation is released with a fresh cleanup signal and renews only after confirmed stop', async () => {
  const f = fixture();
  const cancelled = AbortSignal.abort();
  assert.deepEqual(await f.release({ signal: cancelled }), {
    status: 'released',
    sessionId: 'application-session',
  });
  assert.deepEqual(
    f.calls.map(call => call.type),
    ['client', 'current', 'terminate', 'update', 'renew', 'close'],
  );
  const request = f.calls.find(call => call.type === 'current');
  assert.ok(request.signal instanceof AbortSignal);
  assert.notEqual(request.signal, cancelled);
  assert.equal(request.signal.aborted, false);
  assert.equal(f.calls.find(call => call.type === 'terminate').id, 'application-session');
});

test('missing preparation sessions require no termination or renewal', async () => {
  const f = fixture();
  f.control.missing = true;
  assert.deepEqual(await f.release(), { status: 'absent' });
  assert.deepEqual(
    f.calls.map(call => call.type),
    ['client', 'current', 'close'],
  );
});

test('wrong binding and unresolved work are refused before any network operation', async () => {
  for (const configure of [
    f => (f.control.binding.clientSessionId = 'replacement-client'),
    f => (f.control.unresolved = true),
  ]) {
    const f = fixture();
    configure(f);
    await assert.rejects(f.release(), /binding changed|active or unknown/);
    assert.deepEqual(f.calls, []);
  }
});

test('foreign and locked sessions are never terminated', async () => {
  for (const changed of [
    { projectId: 'foreign-project' },
    { domain: 'foreign-domain' },
    { clientSessionId: 'foreign-client' },
    { callLocked: true },
    { callLocked: undefined },
  ]) {
    const f = fixture();
    Object.assign(f.control.current, changed);
    await assert.rejects(f.release(), /identity changed or is busy/);
    assert.deepEqual(
      f.calls.map(call => call.type),
      ['client', 'current', 'close'],
    );
  }
});

test('changed identity or newly active work during lookup prevents termination', async () => {
  for (const change of [
    f => (f.control.identity = 'another-account'),
    f => (f.control.binding.clientSessionId = 'new-session'),
    f => (f.control.unresolved = true),
  ]) {
    const f = fixture();
    f.control.beforeCurrent = () => change(f);
    await assert.rejects(f.release(), /binding changed|active or unknown/);
    assert.deepEqual(
      f.calls.map(call => call.type),
      ['client', 'current', 'close'],
    );
  }
});

test('unconfirmed termination keeps the binding intact for retry', async () => {
  for (const stopped of [
    { status: 'stopping' },
    { id: 'different-session' },
    { clientSessionId: 'different-client' },
    { callLocked: true },
  ]) {
    const f = fixture();
    f.control.stopped = stopped;
    await assert.rejects(f.release(), /release was not confirmed/);
    assert.deepEqual(
      f.calls.map(call => call.type),
      ['client', 'current', 'terminate', 'close'],
    );
  }
});

test('already stopped preparation sessions renew without another terminate', async () => {
  const f = fixture();
  f.control.current.status = 'stopped';
  assert.equal((await f.release()).status, 'released');
  assert.deepEqual(
    f.calls.map(call => call.type),
    ['client', 'current', 'update', 'renew', 'close'],
  );
});

async function invokeGateway(f, toolId, inputs = {}) {
  const state = await f.runtime.inspect();
  return f.runtime.execute(
    { toolId, inputs, expectedStateId: state.id },
    {
      approval: true,
      taskId: f.taskId,
      scope: { projectId: state.projectId, domain: 'test', stateId: state.id, tools: [toolId] },
    },
  );
}

async function prepareGateway(f) {
  const planned = await invokeGateway(f, 'project.remote.plan', {
    files: ['input.txt'],
    tools: ['test.run'],
  });
  assert.equal(planned.action.status, 'completed', planned.action.diagnostics.join('\n'));
  const review = JSON.parse(f.runtime.readArtifact(planned.artifacts[0].id).content.toString());
  return invokeGateway(f, 'project.remote.prepare', { reviewId: review.reviewId });
}

test('gateway preparation releases its real session binding and engineering execution reacquires it', async t => {
  const f = planningGateway(t);
  const prepared = await prepareGateway(f);
  assert.equal(prepared.action.status, 'completed', prepared.action.diagnostics.join('\n'));
  assert.equal(f.sessions.size, 1);
  const first = [...f.sessions.values()][0];
  assert.equal(first.status, 'stopped');
  assert.equal(f.requests.filter(request => request.route.endsWith('/terminate')).length, 1);
  assert.equal(f.settings.task(f.projectDir, 'test', f.chatId), null);
  assert.equal(f.invocations.length, 0);
  const renewed = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
  assert.equal(renewed.previousApplicationSessionId, first.id);
  assert.notEqual(renewed.clientSessionId, first.clientSessionId);

  const result = await invokeGateway(f, 'test.run');
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.invocations.length, 1);
  assert.equal(f.sessions.size, 2);
  assert.ok([...f.sessions.values()].every(session => session.status === 'stopped'));
  assert.equal(f.settings.task(f.projectDir, 'test', f.chatId).outcome, 'completed');
});

test('failed protected discovery releases the gateway session without inventing an invocation', async t => {
  const f = planningGateway(t);
  f.controls.failInventory = true;
  const failed = await prepareGateway(f);
  assert.equal(failed.action.status, 'failed');
  assert.equal(f.sessions.size, 1);
  assert.ok([...f.sessions.values()].every(session => session.status === 'stopped'));
  assert.equal(f.requests.filter(request => request.route.endsWith('/terminate')).length, 1);
  assert.equal(f.settings.task(f.projectDir, 'test', f.chatId), null);
  assert.equal(f.invocations.length, 0);
  const first = [...f.sessions.values()][0];
  const renewed = f.settings.sessionBinding(f.projectDir, 'test', f.chatId);
  assert.equal(renewed.previousApplicationSessionId, first.id);
  assert.notEqual(renewed.clientSessionId, first.clientSessionId);

  f.controls.failInventory = false;
  const retried = await prepareGateway(f);
  assert.equal(retried.action.status, 'completed', retried.action.diagnostics.join('\n'));
  assert.equal(f.sessions.size, 2);
  assert.ok([...f.sessions.values()].every(session => session.status === 'stopped'));
  assert.equal(f.settings.task(f.projectDir, 'test', f.chatId), null);
});
