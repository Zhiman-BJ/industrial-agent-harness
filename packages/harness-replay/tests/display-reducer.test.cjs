'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  appendDisplayEvents,
  foldDisplay,
  runningAt,
  terminalAt,
  latestEvent,
} = require('../src/display-reducer.cjs');
const { createReplayEngine } = require('../src/engine.cjs');
const { loadBundle } = require('../../harness-recording/src/loader.cjs');

const FIXTURES = path.join(__dirname, '..', '..', 'harness-recording', 'fixtures');

// Records as a recorder would emit them; relMs is the source clock.
function records(events, stepMs = 250) {
  return events.map((event, index) => ({
    seq: index + 1,
    at: new Date(Date.parse('2026-10-11T09:00:00.000Z') + index * stepMs).toISOString(),
    relMs: index * stepMs,
    origin: { chatId: 'c', projectId: null, turnId: 't1', eventRevision: index + 1 },
    event,
  }));
}

test('replay display matches the live merge semantics: text merge, status skip, subagent dedup', () => {
  const list = records([
    { type: 'text', text: '让我' },
    { type: 'status', contextUsage: 10, tokenUsage: null },
    { type: 'text', text: '检查布局。' },
    { type: 'thinking', text: '先读文件' },
    { type: 'thinking', text: '再比对' },
    { type: 'subagent-state', id: 'sa-1', state: 'running', label: '子代理' },
    { type: 'status', contextUsage: 20, tokenUsage: null },
    { type: 'subagent-state', id: 'sa-1', state: 'done', label: '子代理' },
    { type: 'step', number: 2 },
    { type: 'tool', id: 't1', name: 'x', arguments: '{}' },
  ]);
  const display = foldDisplay(list, list.length);
  // status/step rows stay in the list (AgentFlow renders them in debug mode);
  // they just never occupy the merge target slot.
  assert.deepEqual(
    display.map(event => event.type),
    ['text', 'status', 'thinking', 'subagent-state', 'status', 'step', 'tool'],
  );
  // Consecutive text merged; the subagent card replaced in place.
  assert.equal(display[0].text, '让我检查布局。');
  assert.equal(display[2].text, '先读文件再比对');
  assert.equal(display[3].state, 'done');
  assert.equal(latestEvent(display, 'status').contextUsage, 20);
});

test('a text arriving after status rows merges with the text before them', () => {
  const display = appendDisplayEvents(
    [],
    records([
      { type: 'text', text: 'a' },
      { type: 'status', contextUsage: 1, tokenUsage: null },
      { type: 'text', text: 'b' },
    ]).map(record => record.event),
  );
  assert.equal(display.length, 2);
  assert.equal(display[0].text, 'ab');
});

test('running flips at terminal events and back on the next turn', () => {
  const list = records([
    { type: 'text', text: '第一轮' },
    { type: 'done', result: { status: 'success' } },
    { type: 'status', contextUsage: 1, tokenUsage: null },
    { type: 'text', text: '第二轮' },
    { type: 'done', result: { status: 'success' } },
  ]);
  assert.equal(runningAt(list, 0), false);
  assert.equal(runningAt(list, 1), true);
  assert.equal(runningAt(list, 2), false);
  assert.equal(runningAt(list, 3), false); // status only: still after done
  assert.equal(runningAt(list, 4), true);
  assert.equal(runningAt(list, 5), false);
});

test('incremental playback equals a full fold at every position (success-demo fixture)', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'success-demo'));
  const engine = createReplayEngine(bundle.events);
  for (let position = 0; position <= bundle.events.length; position++) {
    engine.seekToPosition(position);
    const incremental = foldDisplay(bundle.events, position);
    assert.deepEqual(
      engine.snapshot().display,
      incremental,
      `display divergence at position ${position}`,
    );
    // Repeated seeks to the same position never append duplicates.
    engine.seekToPosition(position);
    assert.equal(engine.snapshot().display.length, incremental.length);
  }
});

test('seeking backwards recomputes instead of accumulating (no duplicated messages)', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'success-demo'));
  const engine = createReplayEngine(bundle.events);
  engine.seekToPosition(bundle.events.length);
  const full = engine.snapshot().display.length;
  engine.seekToPosition(1);
  const early = engine.snapshot().display.length;
  engine.seekToPosition(bundle.events.length);
  assert.equal(engine.snapshot().display.length, full);
  assert.ok(early < full);
  // A fresh engine over the same bundle sees exactly the same display.
  const fresh = createReplayEngine(bundle.events);
  fresh.seekToPosition(bundle.events.length);
  assert.deepEqual(fresh.snapshot().display, engine.snapshot().display);
});

test('interrupted-demo replays its surviving prefix honestly', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'interrupted-demo'));
  const engine = createReplayEngine(bundle.events);
  engine.seekToPosition(bundle.events.length);
  const snapshot = engine.snapshot();
  assert.equal(snapshot.atEnd, true);
  assert.equal(snapshot.terminal, null); // no terminal survived the crash
  // The trajectory never settled: the run was live when the process died,
  // so the replayed tail honestly shows a still-running turn.
  assert.equal(snapshot.running, true);
});

test('native text and thinking never merge across agents or turns', () => {
  const events = [
    { type: 'text', text: 'parent ', replayAgentId: 'main', replayTurnId: 't1' },
    { type: 'status', replayAgentId: 'agent-0' },
    { type: 'text', text: 'continued', replayAgentId: 'main', replayTurnId: 't1' },
    { type: 'text', text: 'child', replayAgentId: 'agent-0', replayTurnId: 't1' },
    { type: 'text', text: 'new turn', replayAgentId: 'agent-0', replayTurnId: 't2' },
    { type: 'thinking', text: 'parent thought', replayAgentId: 'main', replayTurnId: 't2' },
    { type: 'thinking', text: 'child thought', replayAgentId: 'agent-0', replayTurnId: 't2' },
  ];
  const expected = appendDisplayEvents([], events);
  assert.deepEqual(
    expected.filter(event => event.type === 'text').map(event => event.text),
    ['parent continued', 'child', 'new turn'],
  );
  assert.equal(expected.filter(event => event.type === 'thinking').length, 2);
  for (let split = 0; split <= events.length; split++) {
    assert.deepEqual(
      appendDisplayEvents(appendDisplayEvents([], events.slice(0, split)), events.slice(split)),
      expected,
      `streaming scope must survive batch boundary ${split}`,
    );
  }
});

test('a native user prompt and assistant response remain separate within one turn', () => {
  const scope = { replayAgentId: 'main', replayTurnId: 't1' };
  const display = appendDisplayEvents(
    [],
    [
      { type: 'text', text: 'request', replayRole: 'user', ...scope },
      { type: 'status', ...scope },
      { type: 'text', text: 'response ', replayRole: 'assistant', ...scope },
      { type: 'text', text: 'continued', replayRole: 'assistant', ...scope },
    ],
  );
  assert.deepEqual(
    display.filter(event => event.type === 'text').map(event => [event.replayRole, event.text]),
    [
      ['user', 'request'],
      ['assistant', 'response continued'],
    ],
  );
});

test('child terminals cannot settle the root lane and child metadata cannot reopen it', () => {
  const mainDone = { type: 'done', replayAgentId: 'main', result: { status: 'success' } };
  const childDone = { type: 'done', replayAgentId: 'agent-0', result: { status: 'success' } };
  const list = records([
    { type: 'text', text: 'child started first', replayAgentId: 'agent-0' },
    { type: 'text', text: 'parent running', replayAgentId: 'main' },
    childDone,
    mainDone,
    { type: 'text', text: 'late child update', replayAgentId: 'agent-0' },
    { type: 'status', replayAgentId: 'main' },
  ]);
  const engine = createReplayEngine(list);
  for (const [position, running, terminal] of [
    [1, false, null],
    [2, true, null],
    [3, true, null],
    [4, false, mainDone],
    [5, false, mainDone],
    [6, false, mainDone],
  ]) {
    engine.seekToPosition(position);
    assert.equal(engine.snapshot().running, running);
    assert.deepEqual(engine.snapshot().terminal, terminal);
    assert.equal(runningAt(list, position), running);
    assert.deepEqual(terminalAt(list, position), terminal);
  }
  const child = list.filter(record => record.event.replayAgentId === 'agent-0');
  const filtered = createReplayEngine(child);
  filtered.seekToPosition(2);
  assert.equal(filtered.snapshot().running, false);
  assert.deepEqual(filtered.snapshot().terminal, childDone);
  filtered.seekToPosition(3);
  assert.equal(filtered.snapshot().running, true);
});
