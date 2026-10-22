'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createReplayController, PAGE_SIZE } = require('./controller.cjs');

function fixture(count = 450) {
  return {
    manifest: { recordingId: 'internal-test', status: 'complete' },
    events: Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      relMs: index * 10,
      origin: { agentId: index % 2 ? 'agent-1' : 'main', turnId: 'turn-1' },
      source: {
        sourceFile: 'native/events.jsonl',
        sourceLine: index + 1,
        eventId: `event-${index}`,
      },
      event: { type: 'text', text: `${index}`, replayAgentId: index % 2 ? 'agent-1' : 'main' },
    })),
    warnings: [],
    missingAssets: [],
    native: {
      agents: [
        { id: 'main', turnCount: 1 },
        { id: 'agent-1', turnCount: 1 },
      ],
    },
  };
}

test('replay pages preserve every source record across all agents without truncation', () => {
  const bundle = fixture();
  const controller = createReplayController(bundle);
  controller.control({ action: 'play' });
  const end = controller.tick(100000);
  assert.equal(end.position, bundle.events.length);
  assert.equal(end.atEnd, true);
  assert.equal(end.display, undefined, 'IPC snapshots never transfer an unbounded display array');
  for (const agent of ['', 'main', 'agent-1']) {
    const actual = [];
    for (let offset = 0; offset < bundle.events.length; offset += PAGE_SIZE) {
      const page = controller.page({ agentId: agent, offset });
      if (page.offset !== offset) break;
      actual.push(...page.rows.map(row => row.record));
    }
    assert.deepEqual(
      actual,
      bundle.events.filter(record => !agent || record.origin.agentId === agent),
    );
  }
  assert.deepEqual(
    end.agents.map(agent => agent.reachedEvents),
    [225, 225],
  );
});

test('pause, speed, seek and reset keep cursor coverage and pages consistent', () => {
  const controller = createReplayController(fixture());
  controller.control({ action: 'seek', value: 203 });
  assert.equal(controller.page({ agentId: 'main', offset: 100 }).total, 102);
  assert.equal(controller.page({ offset: 999999 }).offset, 200);
  controller.control({ action: 'speed', value: 4 });
  controller.control({ action: 'play' });
  assert.ok(controller.tick(100).position > 203);
  const paused = controller.control({ action: 'pause' });
  assert.deepEqual(controller.tick(100), paused);
  assert.equal(controller.control({ action: 'reset' }).position, 0);
  assert.equal(controller.snapshot().speed, 1);
  assert.deepEqual(controller.page().rows, []);
  assert.throws(() => controller.control({ action: 'seek', value: NaN }), /finite/);
  assert.throws(() => controller.control({ action: 'runTool' }), /Unsupported/);
});

test('read-only composition has no live model, tool, network or script dependency', () => {
  const originalLoad = Module._load;
  const forbidden =
    /(?:harness-application|agent-kimi|domain-runtime|child_process|node:http|node:https|node:net|node:tls|node:vm)/;
  const calls = [];
  Module._load = function (request, ...args) {
    if (forbidden.test(request)) {
      calls.push(request);
      throw Error(`Live dependency: ${request}`);
    }
    return originalLoad.call(this, request, ...args);
  };
  try {
    for (const name of Object.keys(require.cache))
      if (name.includes('/internal/replay/controller.cjs') || name.includes('/harness-replay/'))
        delete require.cache[name];
    const { createReplayController: create } = require('./controller.cjs');
    const controller = create(fixture());
    controller.control({ action: 'play' });
    controller.tick(100000);
    controller.page();
    assert.deepEqual(calls, []);
  } finally {
    Module._load = originalLoad;
  }
});

test('the integration safety guard fails on live model, tool, script and network access', () => {
  const guard = require('./safety-guard.cjs').installReplaySafetyGuard();
  try {
    assert.throws(() => require('@industrial-agent-harness/agent-kimi'), /modelCalls/);
    assert.throws(() => require('@industrial-agent-harness/harness-application'), /toolCalls/);
    assert.throws(() => require('node:child_process'), /scriptCalls/);
    assert.throws(() => fetch('https://example.invalid'), /attempted fetch/);
    assert.deepEqual(guard.calls, {
      modelCalls: 1,
      toolCalls: 1,
      scriptCalls: 1,
      networkCalls: 1,
    });
  } finally {
    guard.restore();
  }
});

function stagedFixture() {
  const bundle = fixture(5);
  bundle.events.forEach((record, index) => {
    record.seq = (index + 1) * 10;
  });
  bundle.manifest.assets = [
    { id: 'board-outline' },
    { id: 'board-placed' },
    { id: 'other-source' },
  ];
  bundle.manifest.replayStages = [
    { id: 'outline', title: 'Board outline', atSeq: 10, assetId: 'board-outline' },
    { id: 'placed', title: 'Placed components', atSeq: 30, assetId: 'board-placed' },
  ];
  bundle.manifest.source = { kind: 'constructed-demo' };
  bundle.manifest.demo = { constructed: true, note: 'A constructed presentation example.' };
  return bundle;
}

test('stage snapshots follow reached source sequences and restore on backward seek/reset', () => {
  const controller = createReplayController(stagedFixture());
  assert.equal(controller.snapshot().activeStageId, null);
  assert.deepEqual(
    controller.metadata().replayStages.map(stage => stage.position),
    [1, 3],
  );
  assert.equal(controller.control({ action: 'seek', value: 1 }).activeStageId, 'outline');
  assert.equal(controller.control({ action: 'seek', value: 2 }).activeStageId, 'outline');
  assert.equal(controller.control({ action: 'seek', value: 3 }).activeStageId, 'placed');
  assert.equal(controller.control({ action: 'seek', value: 1 }).activeStageId, 'outline');
  assert.equal(controller.control({ action: 'reset' }).activeStageId, null);
  controller.control({ action: 'play' });
  assert.equal(controller.tick(1000).activeStageId, 'placed');
  assert.equal(controller.page().total, 5, 'stage display does not replace source events');
});

test('image IPC adapter accepts only declared stage asset IDs and propagates provider failures', () => {
  const bundle = stagedFixture();
  const controller = createReplayController(bundle);
  const calls = [];
  const provider = (input, id) => {
    calls.push({ input, id });
    return { mime: 'image/png', dataUrl: 'data:image/png;base64,png' };
  };
  assert.equal(controller.image('board-outline', provider).mime, 'image/png');
  assert.equal(calls[0].input, bundle);
  assert.equal(calls[0].id, 'board-outline');
  for (const unsafe of [
    '../board-outline',
    '/tmp/board.png',
    'file:///tmp/board.png',
    'other-source',
    'undeclared',
    { assetId: 'board-outline' },
  ])
    assert.throws(() => controller.image(unsafe, provider), /declared stage asset ID/);
  assert.equal(calls.length, 1, 'invalid references never reach the reader');
  assert.throws(
    () =>
      controller.image('board-placed', () => {
        throw Error('Hash changed');
      }),
    /Hash changed/,
  );
});

test('a stage cannot silently reference undeclared assets or unavailable source sequences', () => {
  const bundle = stagedFixture();
  bundle.manifest.replayStages[0].assetId = 'undeclared';
  assert.throws(() => createReplayController(bundle), /declared asset/);
  bundle.manifest.replayStages[0].assetId = 'board-outline';
  bundle.manifest.replayStages[0].atSeq = 99;
  assert.throws(() => createReplayController(bundle), /outside the recording/);
});

test('product flow separates user input, merges exact streamed content and filters metadata', () => {
  const bundle = fixture(0);
  const events = [
    { type: 'text', text: 'Historical user request', replayRole: 'user' },
    { type: 'text', text: 'First ', replayRole: 'assistant' },
    { type: 'status', message: 'native metadata' },
    { type: 'text', text: 'answer.', replayRole: 'assistant' },
    { type: 'thinking', text: 'Recorded thought.' },
  ];
  bundle.events = events.map((event, index) => ({
    seq: index + 1,
    relMs: index,
    origin: { agentId: 'main', turnId: 'turn-1' },
    event,
  }));
  const controller = createReplayController(bundle);
  controller.control({ action: 'seek', value: events.length });
  const flow = controller.flow();
  assert.equal(flow.turn.task, 'Historical user request');
  assert.deepEqual(
    flow.turn.events.map(event => event.text),
    ['First answer.', 'Recorded thought.'],
  );
  assert.equal(flow.position, events.length);
});

test('bounded product flow pages never orphan tool results across block boundaries', () => {
  const bundle = fixture(0);
  const events = [];
  for (let index = 0; index < 45; index++)
    events.push({
      type: 'tool',
      id: `call-${index}`,
      name: 'HistoricalTool',
      arguments: `${index}`,
    });
  for (let index = 0; index < 45; index++)
    events.push({ type: 'tool-result', id: `call-${index}`, output: `result-${index}` });
  bundle.events = events.map((event, index) => ({
    seq: index + 1,
    relMs: index,
    origin: { agentId: 'agent-1', turnId: 'turn-2' },
    event,
  }));
  const controller = createReplayController(bundle);
  controller.control({ action: 'seek', value: events.length });
  const ids = new Set();
  for (const blockOffset of [0, 40]) {
    const flow = controller.flow({ agentId: 'agent-1', blockOffset });
    assert.equal(flow.turn.totalBlocks, 45);
    const calls = flow.turn.events.filter(event => event.type === 'tool');
    const results = flow.turn.events.filter(event => event.type === 'tool-result');
    assert.deepEqual(
      calls.map(event => event.id),
      results.map(event => event.id),
    );
    calls.forEach(call => ids.add(call.id));
  }
  assert.equal(ids.size, 45);
  assert.equal(controller.flow({ agentId: 'missing' }).turn, null);
});
