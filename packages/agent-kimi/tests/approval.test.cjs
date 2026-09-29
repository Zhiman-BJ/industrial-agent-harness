const test = require('node:test');
const assert = require('node:assert/strict');
const {KimiSession} = require('../src/index.cjs');
function fixture(approve) {
  const events = [];
  const session = new KimiSession('.', () => null, () => null, () => null, event => events.push(event), () => ({}));
  session.turn = {approve};
  session.emitEvent({type: 'ApprovalRequest', payload: {id: 'a1', action: 'run command', description: 'read file'}});
  return {session, events};
}
test('successful approval emits a resolution even without an SDK echo and rejects duplicate submission', async () => {
  let finish;
  const {session, events} = fixture(() => new Promise(resolve => {finish = resolve;}));
  const pending = session.approve('a1', 'approve');
  await assert.rejects(session.approve('a1', 'approve'), /no longer pending/);
  assert.equal(events.length, 1);
  finish(); await pending;
  assert.deepEqual(events[1], {type: 'approval-resolved', id: 'a1', decision: 'approve'});
  session.emitEvent({type: 'ApprovalResponse', payload: {request_id: 'a1', response: 'approve'}});
  assert.equal(events.length, 2);
  await assert.rejects(session.approve('a1', 'approve'), /no longer pending/);
});
test('failed submission stays pending for retry; SDK session approval also clears the request', async () => {
  let fail = true;
  const {session, events} = fixture(async () => {if (fail) throw Error('transport failed');});
  await assert.rejects(session.approve('a1', 'reject'), /transport failed/);
  assert.equal(events.length, 1);
  fail = false; await session.approve('a1', 'reject');
  assert.equal(events[1].decision, 'reject');
  session.emitEvent({type: 'ApprovalRequest', payload: {id: 'a2', action: 'read', description: 'next'}});
  session.emitEvent({type: 'ApprovalResponse', payload: {request_id: 'a2', response: 'approve_for_session'}});
  assert.equal(events.at(-1).decision, 'approve_for_session');
  await assert.rejects(session.approve('a2', 'reject'), /no longer pending/);
  await assert.rejects(session.approve('a2', 'invalid'), /Invalid approval/);
});
