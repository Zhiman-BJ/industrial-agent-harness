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
