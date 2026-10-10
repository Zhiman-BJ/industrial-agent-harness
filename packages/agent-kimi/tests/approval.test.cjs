const test = require('node:test');
const assert = require('node:assert/strict');
const { KimiSession } = require('../src/index.cjs');
function fixture(approve) {
  const events = [];
  const session = new KimiSession(
    '.',
    () => null,
    () => null,
    () => null,
    event => events.push(event),
    () => ({}),
  );
  session.turn = { approve };
  session.emitEvent({
    type: 'ApprovalRequest',
    payload: { id: 'a1', action: 'run command', description: 'read file' },
  });
  return { session, events };
}
test('successful approval emits a resolution even without an SDK echo and rejects duplicate submission', async () => {
  let finish;
  const { session, events } = fixture(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = session.approve('a1', 'approve');
  await assert.rejects(session.approve('a1', 'approve'), /no longer pending/);
  assert.equal(events.length, 1);
  finish();
  await pending;
  assert.deepEqual(events[1], {
    type: 'approval-resolved',
    id: 'a1',
    decision: 'approve',
    origin: 'user',
  });
  session.emitEvent({
    type: 'ApprovalResponse',
    payload: { request_id: 'a1', response: 'approve' },
  });
  assert.equal(events.length, 2);
  await assert.rejects(session.approve('a1', 'approve'), /no longer pending/);
});
test('failed submission stays pending for retry; SDK session approval also clears the request', async () => {
  let fail = true;
  const { session, events } = fixture(async () => {
    if (fail) throw Error('transport failed');
  });
  await assert.rejects(session.approve('a1', 'reject'), /transport failed/);
  assert.equal(events.length, 1);
  fail = false;
  await session.approve('a1', 'reject');
  assert.equal(events[1].decision, 'reject');
  session.emitEvent({
    type: 'ApprovalRequest',
    payload: { id: 'a2', action: 'read', description: 'next' },
  });
  session.emitEvent({
    type: 'ApprovalResponse',
    payload: { request_id: 'a2', response: 'approve_for_session' },
  });
  assert.equal(events.at(-1).decision, 'approve_for_session');
  await assert.rejects(session.approve('a2', 'reject'), /no longer pending/);
  await assert.rejects(session.approve('a2', 'invalid'), /Invalid approval/);
});

test('only identified Harness Runtime callbacks delegate transport approval; native and untrusted tools still ask', async () => {
  const approvals = [];
  const { session, events } = fixture(async (id, decision) => approvals.push({ id, decision }));
  events.length = 0;
  session.hostRuntimeTools = new Set(['external_tool_call']);
  for (const [id, sender, harness_callback] of [
    ['hosted', 'external_tool_call', true],
    ['foreign', 'external_tool_call', false],
    ['native', 'Bash', false],
    ['unknown', 'unknown_callback', true],
  ])
    session.emitEvent({
      type: 'ApprovalRequest',
      payload: { id, sender, harness_callback, action: 'execute', description: 'approval' },
    });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(approvals, [{ id: 'hosted', decision: 'approve' }]);
  assert.deepEqual(
    events.filter(event => event.type === 'approval').map(event => event.id),
    ['foreign', 'native', 'unknown'],
  );
  const decision = session.requestRuntimeApproval(
    { id: 'registered.host.mutation' },
    { expectedStateId: 'current-state' },
  );
  const request = events.at(-1);
  assert.equal(request.type, 'approval');
  assert.equal(request.action, 'registered.host.mutation');
  await session.approve(request.id, 'reject');
  assert.equal(await decision, false);
});

test('closing background work rejects a pending host mutation and expires its approval', async () => {
  const { session, events } = fixture(async () => {});
  session.backgroundTasks = true;
  const decision = session.requestRuntimeApproval(
    { id: 'registered.background.mutation' },
    { expectedStateId: 'current-state' },
  );
  const request = events.at(-1);
  assert.ok(session.backgroundApprovals.has(request.id));
  session.session = { close: async () => assert.equal(await decision, false) };
  await session.closeNative();
  assert.equal(session.runtimeApprovals.size, 0);
  assert.equal(session.pendingApprovals.size, 0);
  assert.ok(
    events.some(
      event =>
        event.type === 'approval-resolved' &&
        event.id === request.id &&
        event.decision === 'expired',
    ),
  );
  assert.equal(session.backgroundTasks, false);
  await assert.rejects(session.approve(request.id, 'approve'), /no longer pending/);
});
