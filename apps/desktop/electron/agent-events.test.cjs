const test = require('node:test');
const assert = require('node:assert/strict');

test('batched display events preserve streamed content, activity boundaries and the previous render', async () => {
  const { appendDisplayEvents, latestEvent } = await import('../src/agent-events.ts');
  const current = Object.freeze([Object.freeze({ type: 'text', text: 'Hello' })]);
  const events = [
    { type: 'status', contextUsage: 0.1 },
    { type: 'step', number: 1 },
    { type: 'text', text: ' world' },
    { type: 'thinking', text: 'Think' },
    { type: 'thinking', text: ' more' },
    { type: 'tool', id: 'a', name: 'ReadFile', arguments: '{}' },
    { type: 'text', text: 'Done' },
    { type: 'text', text: '.' },
  ];
  const result = appendDisplayEvents(current, events);
  assert.deepEqual(result, [
    { type: 'text', text: 'Hello world' },
    { type: 'status', contextUsage: 0.1 },
    { type: 'step', number: 1 },
    { type: 'thinking', text: 'Think more' },
    { type: 'tool', id: 'a', name: 'ReadFile', arguments: '{}' },
    { type: 'text', text: 'Done.' },
  ]);
  assert.equal(current[0].text, 'Hello');
  assert.equal(latestEvent(result, 'text').text, 'Done.');
  assert.equal(latestEvent(result, 'todo'), undefined);
  assert.equal(appendDisplayEvents(result, []), result);
});

test('subagent lifecycle updates replace only the matching child and retain surrounding activity', async () => {
  const { appendDisplayEvents, latestEvent } = await import('../src/agent-events.ts');
  const child = (id, status, extra = {}) => ({
    type: 'subagent-state',
    id,
    agentId: id,
    parentToolCallId: 'parent',
    subagentType: 'task',
    description: id,
    background: true,
    status,
    ...extra,
  });
  const first = Object.freeze(child('a', 'running', { summary: 'starting' }));
  const other = Object.freeze(child('b', 'running'));
  const tool = Object.freeze({ type: 'tool', id: 'parent', name: 'Task', arguments: '{}' });
  const current = Object.freeze([tool, first, other]);
  const waiting = child('a', 'awaiting_approval');
  const completed = child('a', 'completed', { summary: 'finished' });
  const failed = child('c', 'failed', { summary: 'launch failed' });
  const result = appendDisplayEvents(current, [waiting, completed, failed]);
  assert.deepEqual(result, [tool, completed, other, failed]);
  assert.equal(result[0], tool);
  assert.equal(result[2], other);
  assert.equal(first.status, 'running');
  assert.equal(first.summary, 'starting');
  assert.equal(result.filter(event => event.id === 'a').length, 1);
  assert.equal(latestEvent(result, 'subagent-state'), failed);
});

test('batch boundaries do not change the displayed stream or cross approval and result boundaries', async () => {
  const { appendDisplayEvents } = await import('../src/agent-events.ts');
  const events = Object.freeze([
    Object.freeze({ type: 'thinking', text: 'Plan' }),
    Object.freeze({ type: 'status', contextUsage: 0.2, tokenUsage: null }),
    Object.freeze({ type: 'step', number: 1 }),
    Object.freeze({ type: 'thinking', text: ' carefully' }),
    Object.freeze({
      type: 'approval',
      id: 'approval-1',
      action: 'write',
      description: 'Approve write',
    }),
    Object.freeze({ type: 'thinking', text: 'After approval' }),
    Object.freeze({
      type: 'tool-result',
      id: 'tool-1',
      output: 'saved',
      message: 'Saved',
      error: false,
    }),
    Object.freeze({ type: 'text', text: 'Saved' }),
    Object.freeze({ type: 'status', contextUsage: 0.3, tokenUsage: null }),
    Object.freeze({ type: 'text', text: '.' }),
  ]);
  const expected = [
    { type: 'thinking', text: 'Plan carefully' },
    events[1],
    events[2],
    events[4],
    events[5],
    events[6],
    { type: 'text', text: 'Saved.' },
    events[8],
  ];
  assert.deepEqual(appendDisplayEvents([], events), expected);
  for (let split = 0; split <= events.length; split++) {
    const partial = appendDisplayEvents([], events.slice(0, split));
    const snapshot = structuredClone(partial);
    assert.deepEqual(
      appendDisplayEvents(partial, events.slice(split)),
      expected,
      `IPC batch split ${split}`,
    );
    assert.deepEqual(
      partial,
      snapshot,
      'A subsequent batch must leave the previous render untouched',
    );
  }
  assert.deepEqual(events[0], { type: 'thinking', text: 'Plan' });
});

test('streamed text keeps its first receipt time across later chunks and a restored history', async () => {
  const { appendDisplayEvents } = await import('../src/agent-events.ts');
  const first = { type: 'text', text: 'First', recordedAt: '2026-10-08T05:54:45.000Z' };
  const later = { type: 'text', text: ' second', recordedAt: '2026-10-08T05:55:01.000Z' };
  assert.deepEqual(appendDisplayEvents([first], [later]), [{ ...first, text: 'First second' }]);
  // Legacy history has no receipt time: do not invent a time for its first chunk.
  assert.deepEqual(appendDisplayEvents([{ type: 'text', text: 'Old' }], [later]), [
    { type: 'text', text: 'Old second' },
  ]);
});

test('subagent replacement uses the first child with that ID and does not replace a same-ID tool', async () => {
  const { appendDisplayEvents } = await import('../src/agent-events.ts');
  const child = (id, status) => ({ type: 'subagent-state', id, status });
  const tool = Object.freeze({ type: 'tool', id: 'same', name: 'Task', arguments: '{}' });
  const first = Object.freeze(child('same', 'running'));
  const duplicate = Object.freeze(child('same', 'awaiting_approval'));
  const current = Object.freeze([
    tool,
    first,
    duplicate,
    Object.freeze({ type: 'text', text: 'Answer' }),
  ]);
  const completed = child('same', 'completed');
  const newChild = child('new', 'running');
  const cancelled = child('new', 'cancelled');
  const result = appendDisplayEvents(current, [
    completed,
    { type: 'text', text: ' continued' },
    newChild,
    { type: 'text', text: 'After child' },
    cancelled,
    { type: 'text', text: '.' },
  ]);
  assert.deepEqual(result, [
    tool,
    completed,
    duplicate,
    { type: 'text', text: 'Answer continued' },
    cancelled,
    { type: 'text', text: 'After child.' },
  ]);
  assert.equal(result[0], tool);
  assert.equal(result[2], duplicate);
  assert.equal(current[1].status, 'running');
  assert.equal(current[3].text, 'Answer');
});
