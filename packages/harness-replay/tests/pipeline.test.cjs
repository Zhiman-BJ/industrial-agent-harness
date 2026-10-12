'use strict';

// Cross-package replay pipeline (#104 -> #105): record trajectories with the
// recorder, persist and load bundles, export a redacted demo copy, and
// replay everything through the engine. This pins the composition the unit
// suites exercise separately: recorder output must be engine-shaped, demo
// exports must replay, and no invariant may drift across the whole chain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  createRecorder,
  loadBundle,
  exportDemoBundle,
  validateBundle,
} = require('../../harness-recording/src/index.cjs');
const { createReplayEngine, foldDisplay, describeBundle } = require('../src/index.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replay-pipeline-'));
}

// Deterministic clock: 250ms per call, with optional extra pauses (keyed by
// 1-based call number) to stage long tool waits.
function clock(pauseAfter = {}) {
  let elapsed = 0;
  let calls = 0;
  return () => {
    calls++;
    elapsed += (pauseAfter[calls] || 0) + 250;
    return new Date(Date.parse('2026-10-12T08:00:00.000Z') + elapsed).toISOString();
  };
}

const meta = (turn, eventRevision) => ({
  chatId: 'chat-main',
  projectId: 'proj-demo',
  turnId: turn,
  eventRevision,
});

function recordTwoTurnTask(directory) {
  const recorder = createRecorder({
    directory,
    chatId: 'chat-main',
    projectId: 'proj-demo',
    recordingId: 'rec-two-turn',
    now: clock(),
    initialTurns: [{ turnId: 'turn-0', summary: '前期需求讨论' }],
  });
  recorder.start();
  recorder.record({ type: 'text', text: '检查这版布局，' }, meta('turn-1', 1));
  recorder.record({ type: 'text', text: '重点看电源网络。' }, meta('turn-1', 2));
  recorder.record({ type: 'thinking', text: '先读布局文件，' }, meta('turn-1', 3));
  recorder.record({ type: 'thinking', text: '再核对连线。' }, meta('turn-1', 4));
  recorder.record(
    {
      type: 'todo',
      items: [
        { title: '读取布局', status: 'in_progress' },
        { title: '核对电源', status: 'pending' },
      ],
    },
    meta('turn-1', 5),
  );
  recorder.record(
    { type: 'tool', id: 't1', name: 'inspect_layout', arguments: '{"file":"sobel.gds"}' },
    meta('turn-1', 6),
  );
  recorder.record(
    { type: 'approval', id: 'ap1', description: '运行布局检查工具', action: 'inspect_layout' },
    meta('turn-1', 7),
  );
  recorder.record({ type: 'approval-resolved', id: 'ap1', decision: 'approve' }, meta('turn-1', 8));
  recorder.record(
    {
      type: 'tool-result',
      id: 't1',
      error: false,
      message: '',
      output: '3 layers, 214 instances, 0 opens',
      outputBytes: 34,
    },
    meta('turn-1', 9),
  );
  recorder.record(
    { type: 'subagent-state', id: 'sa-pwr', state: 'running', label: '电源核对' },
    meta('turn-1', 10),
  );
  recorder.record(
    { type: 'subagent-state', id: 'sa-pwr', state: 'done', label: '电源核对' },
    meta('turn-1', 11),
  );
  recorder.record({ type: 'text', text: '电源网络全部连通。' }, meta('turn-1', 12));
  recorder.record({ type: 'done', result: { status: 'success' } }, meta('turn-1', 13));
  recorder.record({ type: 'status', contextUsage: 42, tokenUsage: null }, meta('turn-2', 1));
  recorder.record({ type: 'text', text: '器件总数是 214 个。' }, meta('turn-2', 2));
  recorder.record({ type: 'done', result: { status: 'success' } }, meta('turn-2', 3));
  recorder.stop();
}

// Reusable full-pipeline checks over any recorded directory.
function pipelineChecks(directory) {
  const bundle = loadBundle(directory);
  const engine = createReplayEngine(bundle.events);
  engine.play();
  const runningFlips = [];
  let lastRunning = null;
  for (let guard = 0; engine.snapshot().phase === 'playing' && guard < 10000; guard++) {
    engine.tick(50);
    const running = engine.snapshot().running;
    if (running !== lastRunning) {
      runningFlips.push(running);
      lastRunning = running;
    }
  }
  const final = engine.snapshot();
  for (const position of [0, 1, Math.floor(bundle.events.length / 2), bundle.events.length]) {
    engine.seekToPosition(position);
    assert.deepEqual(
      engine.snapshot().display,
      foldDisplay(bundle.events, position),
      `seek(${position}) must equal the full fold`,
    );
    engine.seekToPosition(position);
    assert.equal(engine.snapshot().display.length, foldDisplay(bundle.events, position).length);
  }
  return { bundle, engine, description: describeBundle(bundle), final, runningFlips };
}

test('a two-turn recorded task replays end to end with honest running flips', () => {
  const directory = tempDir();
  recordTwoTurnTask(directory);
  assert.deepEqual(validateBundle(directory), []);
  const { bundle, description, final, runningFlips } = pipelineChecks(directory);

  assert.equal(description.status, 'complete');
  assert.equal(description.outcome, 'success');
  assert.deepEqual(description.turns, ['turn-1', 'turn-2']);
  assert.equal(description.initialTurns.length, 1);
  assert.equal(final.phase, 'paused');
  assert.ok(final.atEnd);
  // running: false through the (now honest) lead-in while nothing is
  // revealed, then true mid-turn -> false at turn-1 done -> true on turn-2
  // -> false at its done.
  assert.deepEqual(runningFlips, [false, true, false, true, false]);
  const texts = final.display.filter(event => event.type === 'text').map(event => event.text);
  assert.ok(
    texts.includes('检查这版布局，重点看电源网络。'),
    `streamed chunks merged: ${texts.join(' / ')}`,
  );
  assert.equal(final.display.filter(event => event.type === 'subagent-state').length, 1);
  assert.equal(final.display.filter(event => event.type === 'approval').length, 1);
  assert.equal(bundle.events.length, 16);
});

test('a 90-second tool wait compresses to the cap and can stay raw', () => {
  const directory = tempDir();
  const recorder = createRecorder({
    directory,
    chatId: 'chat-main',
    recordingId: 'rec-long-wait',
    now: clock({ 3: 90000 }),
  });
  recorder.start();
  recorder.record({ type: 'text', text: '运行长时间原生工具。' }, meta('turn-1', 1));
  recorder.record(
    { type: 'tool', id: 't1', name: 'freecad_run', arguments: '{}' },
    meta('turn-1', 2),
  );
  recorder.record(
    { type: 'tool-result', id: 't1', error: false, message: '', output: 'done', outputBytes: 4 },
    meta('turn-1', 3),
  );
  recorder.record({ type: 'text', text: '完成。' }, meta('turn-1', 4));
  recorder.record({ type: 'done', result: { status: 'success' } }, meta('turn-1', 5));
  recorder.stop();

  const { engine } = pipelineChecks(directory);
  // Lead-in 250 + gap 250 + compressed 1500 + 250 + 250: the lead-in is a
  // gap like any other (it used to be silently pinned to displayMs 0).
  assert.equal(engine.timeline.durationMs, 2500);
  const raw = createReplayEngine(loadBundle(directory).events, {
    compression: { thresholdMs: Infinity, capMs: 1 },
  });
  assert.equal(raw.timeline.durationMs, 91250);
});

test('a cancelled run replays with a cancelled outcome', () => {
  const directory = tempDir();
  const recorder = createRecorder({
    directory,
    chatId: 'chat-main',
    recordingId: 'rec-cancel',
    now: clock(),
  });
  recorder.start();
  recorder.record({ type: 'text', text: '先停在这里。' }, meta('turn-1', 1));
  recorder.record({ type: 'done', result: { status: 'cancelled' } }, meta('turn-1', 2));
  recorder.stop();
  const { description, final } = pipelineChecks(directory);
  assert.equal(description.outcome, 'cancelled');
  assert.equal(final.running, false);
});

test('foreign-chat events never reach the bundle, let alone the replay', () => {
  const directory = tempDir();
  const recorder = createRecorder({
    directory,
    chatId: 'chat-main',
    recordingId: 'rec-foreign',
    now: clock(),
  });
  recorder.start();
  recorder.record({ type: 'text', text: '本聊事件。' }, meta('turn-1', 1));
  const foreign = { chatId: 'chat-other', projectId: 'p2', turnId: 't9', eventRevision: 1 };
  recorder.record({ type: 'text', text: '别的会话' }, foreign);
  recorder.record({ type: 'done', result: { status: 'success' } }, meta('turn-1', 2));
  recorder.stop();
  assert.equal(recorder.stats().ignoredForeign, 1);
  const { bundle } = pipelineChecks(directory);
  assert.ok(bundle.events.every(record => record.origin.chatId === 'chat-main'));
});

test('a redacted demo export replays with no credentials and an untouched original', () => {
  const original = tempDir();
  const recorder = createRecorder({
    directory: original,
    chatId: 'chat-main',
    recordingId: 'rec-creds',
    now: clock(),
  });
  recorder.start();
  recorder.record(
    { type: 'text', text: '在 /Users/roger/board.gds 上运行检查。' },
    meta('turn-1', 1),
  );
  recorder.record(
    {
      type: 'tool',
      id: 't1',
      name: 'http_request',
      arguments: JSON.stringify({
        url: 'https://ci:s3cret@192.168.1.10/api',
        api_key: 'sk-AbCdEf1234567890Zz',
      }),
    },
    meta('turn-1', 2),
  );
  recorder.record({ type: 'text', text: '调用完成。' }, meta('turn-1', 3));
  recorder.record({ type: 'done', result: { status: 'success' } }, meta('turn-1', 4));
  recorder.stop();

  const demo = path.join(tempDir(), 'demo');
  exportDemoBundle(original, demo, {});
  const { bundle, description } = pipelineChecks(demo);

  assert.equal(description.isDemo, true);
  assert.equal(description.reviewStatus, 'unreviewed');
  const args = JSON.parse(
    bundle.events.find(record => record.event.type === 'tool').event.arguments,
  );
  assert.equal(args.api_key, '[REDACTED]');
  assert.match(args.url, /\[REDACTED\]@\[REDACTED_ENDPOINT\]\//);
  assert.equal(
    bundle.events.find(record => record.event.type === 'text').event.text,
    '在 ~/board.gds 上运行检查。',
  );
  assert.ok(
    JSON.stringify(bundle.events).indexOf('sk-AbCdEf') === -1,
    'no api key anywhere in the demo events',
  );
  // The original stays intact and still carries its evidence.
  assert.deepEqual(validateBundle(original), []);
  assert.ok(JSON.stringify(loadBundle(original).events).includes('sk-AbCdEf'));
});
