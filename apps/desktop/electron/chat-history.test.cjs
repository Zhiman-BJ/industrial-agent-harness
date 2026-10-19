const test = require('node:test');
const assert = require('node:assert/strict');

test('late history cannot restore expired approval, duplicate text or resurrect running state', async () => {
  const { mergeHistoryEvents } = await import('../src/chat-history.ts');
  const history = {
    chat: { id: 'a' },
    eventRevision: 2,
    executing: true,
    turns: [{ id: 'turn-a', status: 'running', events: [{ type: 'text', text: 'first' }] }],
  };
  const received = [
    { chatId: 'a', turnId: 'turn-a', eventRevision: 2, type: 'text', text: 'first' },
    { chatId: 'b', turnId: 'turn-b', eventRevision: 10, type: 'text', text: 'OTHER_CHAT' },
    { chatId: 'a', turnId: 'turn-a', eventRevision: 3, type: 'text', text: ' second' },
    {
      chatId: 'a',
      turnId: 'turn-a',
      eventRevision: 4,
      type: 'approval-resolved',
      id: 'shared',
      decision: 'expired',
    },
    {
      chatId: 'a',
      turnId: 'turn-a',
      eventRevision: 5,
      type: 'done',
      result: { status: 'cancelled' },
    },
  ];
  const merged = mergeHistoryEvents(history, received);
  assert.equal(merged.turns[0].events[0].text, 'first second');
  assert.equal(merged.turns[0].status, 'cancelled');
  assert.equal(merged.executing, false);
  assert.equal(merged.eventRevision, 5);
  assert.equal(history.turns[0].status, 'running');
});

test('stale, unversioned and other-chat deliveries leave the snapshot untouched', async () => {
  const { mergeHistoryEvents } = await import('../src/chat-history.ts');
  const history = Object.freeze({
    chat: Object.freeze({ id: 'a' }),
    eventRevision: 8,
    executing: false,
    turns: Object.freeze([
      Object.freeze({
        id: 'turn-a',
        status: 'completed',
        events: Object.freeze([{ type: 'text', text: 'saved' }]),
      }),
    ]),
  });
  const deliveries = [
    { chatId: 'a', turnId: 'turn-a', eventRevision: 8, type: 'text', text: 'duplicate' },
    { chatId: 'a', turnId: 'turn-a', eventRevision: 7, type: 'error', message: 'stale' },
    { chatId: 'a', turnId: 'turn-a', type: 'done', result: { status: 'running' } },
    { chatId: 'b', turnId: 'turn-a', eventRevision: 99, type: 'text', text: 'private' },
  ];
  assert.equal(mergeHistoryEvents(history, deliveries), history);
  assert.equal(mergeHistoryEvents(history, []), history);
});

test('late events are routed to their own turn and applying the same delivery twice is idempotent', async () => {
  const { mergeHistoryEvents } = await import('../src/chat-history.ts');
  const first = Object.freeze({
    id: 'first',
    status: 'completed',
    events: Object.freeze([{ type: 'text', text: 'one' }]),
  });
  const second = Object.freeze({
    id: 'second',
    status: 'running',
    events: Object.freeze([{ type: 'text', text: 'two' }]),
  });
  const untouched = Object.freeze({ id: 'old', status: 'completed', events: Object.freeze([]) });
  const history = Object.freeze({
    chat: Object.freeze({ id: 'a' }),
    eventRevision: 4,
    executing: true,
    turns: Object.freeze([untouched, first, second]),
    hasMore: true,
    before: 'older-page',
  });
  const deliveries = [
    { chatId: 'a', turnId: 'first', eventRevision: 5, type: 'text', text: ' restored' },
    { chatId: 'a', turnId: 'second', eventRevision: 6, type: 'text', text: ' live' },
    { chatId: 'a', turnId: 'first', eventRevision: 7, type: 'error', message: 'late failure' },
  ];
  const merged = mergeHistoryEvents(history, deliveries);
  assert.equal(merged.turns[0], untouched);
  assert.equal(merged.turns[1].events[0].text, 'one restored');
  assert.equal(merged.turns[1].status, 'error');
  assert.equal(merged.turns[2].events[0].text, 'two live');
  assert.equal(merged.turns[2].status, 'running');
  assert.equal(merged.executing, true, 'An earlier turn failure must not stop the live last turn');
  assert.equal(merged.hasMore, true);
  assert.equal(merged.before, 'older-page');
  assert.equal(merged.eventRevision, 7);
  assert.equal(mergeHistoryEvents(merged, deliveries), merged);
  assert.equal(first.events[0].text, 'one');
  assert.equal(second.events[0].text, 'two');
});

test('legacy snapshots merge versioned recovery events and keep terminal state authoritative', async () => {
  const { mergeHistoryEvents } = await import('../src/chat-history.ts');
  const history = {
    chat: { id: 'a' },
    executing: true,
    turns: [{ id: 'turn', status: 'running', events: [] }],
  };
  const received = [
    {
      chatId: 'a',
      turnId: 'turn',
      eventRevision: 1,
      type: 'error',
      message: 'transport interrupted',
    },
    {
      chatId: 'a',
      turnId: 'turn',
      eventRevision: 2,
      type: 'done',
      result: { status: 'completed' },
    },
  ];
  const recovered = mergeHistoryEvents(history, received);
  assert.equal(recovered.turns[0].status, 'completed');
  assert.equal(recovered.executing, false);
  assert.equal(recovered.eventRevision, 2);
  assert.deepEqual(recovered.turns[0].events, received);
  const afterError = mergeHistoryEvents(recovered, [
    { chatId: 'a', turnId: 'turn', eventRevision: 3, type: 'error', message: 'final failure' },
  ]);
  assert.equal(afterError.turns[0].status, 'error');
  assert.equal(afterError.executing, false);
});

test('a history page never creates a phantom turn from events outside that page', async () => {
  const { mergeHistoryEvents } = await import('../src/chat-history.ts');
  const history = {
    chat: { id: 'a' },
    eventRevision: 1,
    executing: false,
    turns: [],
    hasMore: false,
    before: null,
  };
  const merged = mergeHistoryEvents(history, [
    { chatId: 'a', turnId: 'not-in-page', eventRevision: 2, type: 'text', text: 'unloaded turn' },
  ]);
  assert.deepEqual(merged.turns, []);
  assert.equal(merged.executing, false);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.before, null);
  assert.equal(
    merged.eventRevision,
    2,
    'Unloaded turn events still advance the snapshot watermark',
  );
});

test('interleaved turn buckets preserve arrival order, repeated chunks and unmatched-event revision', async () => {
  const { mergeHistoryEvents } = await import('../src/chat-history.ts');
  const history = {
    chat: { id: 'a' },
    eventRevision: 2,
    executing: true,
    turns: [
      { id: 'first', status: 'running', events: [] },
      { id: 'second', status: 'running', events: [] },
    ],
  };
  const firstText = { chatId: 'a', turnId: 'first', eventRevision: 4, type: 'text', text: 'A' };
  const received = Object.freeze([
    Object.freeze(firstText),
    Object.freeze({ chatId: 'a', turnId: 'second', eventRevision: 3, type: 'text', text: 'B' }),
    Object.freeze({
      chatId: 'a',
      turnId: 'first',
      eventRevision: 5,
      type: 'done',
      result: { status: 'completed' },
    }),
    Object.freeze({ ...firstText }),
    Object.freeze({
      chatId: 'a',
      turnId: 'first',
      eventRevision: 6,
      type: 'error',
      message: 'final',
    }),
    Object.freeze({ chatId: 'a', turnId: 'second', eventRevision: 7, type: 'text', text: 'C' }),
    Object.freeze({
      chatId: 'a',
      eventRevision: 9,
      type: 'status',
      contextUsage: 0.2,
      tokenUsage: null,
    }),
    Object.freeze({
      chatId: 'a',
      turnId: 'unloaded',
      eventRevision: 10,
      type: 'text',
      text: 'unloaded',
    }),
  ]);
  const merged = mergeHistoryEvents(history, received);
  assert.deepEqual(
    merged.turns.map(turn => turn.id),
    ['first', 'second'],
  );
  assert.deepEqual(merged.turns[0].events, [received[0], received[2], received[3], received[4]]);
  assert.equal(merged.turns[0].status, 'error', 'Terminal events follow delivery order');
  assert.equal(merged.turns[1].events[0].text, 'BC');
  assert.equal(merged.turns[1].status, 'running');
  assert.equal(merged.executing, true);
  assert.equal(merged.eventRevision, 10);
  assert.deepEqual(history.turns[0].events, []);
  assert.equal(received[0].text, 'A');
});
