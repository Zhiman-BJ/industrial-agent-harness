'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTimeline, DEFAULT_COMPRESSION } = require('../src/timeline.cjs');
const { createReplayEngine, SPEEDS } = require('../src/engine.cjs');
const { createReplayClock } = require('../src/clock.cjs');

function records(entries) {
  // entries: [relMs, event]
  return entries.map(([relMs, event], index) => ({
    seq: index + 1,
    at: '2026-10-11T09:00:00.000Z',
    relMs,
    origin: { chatId: 'c', projectId: null, turnId: 't1', eventRevision: index + 1 },
    event,
  }));
}

const text = i => ({ type: 'text', text: `e${i}` });

test('compression shrinks only gaps beyond the threshold and keeps order', () => {
  // 0ms, 1s, 2s, then a 3-minute wait, then 1s more.
  const list = records([
    [0, text(0)],
    [1000, text(1)],
    [2000, text(2)],
    [182000, text(3)],
    [183000, text(4)],
  ]);
  const timeline = buildTimeline(list, { thresholdMs: 5000, capMs: 1500 });
  // Gaps: 1000, 1000, 180000 (compressed -> 1500), 1000.
  assert.deepEqual(
    timeline.points.map(point => point.displayMs),
    [0, 1000, 2000, 3500, 4500],
  );
  assert.equal(timeline.durationMs, 4500);
  // Order and source times are preserved for the UI.
  assert.deepEqual(
    timeline.points.map(point => point.sourceMs),
    [0, 1000, 2000, 182000, 183000],
  );
});

test('compression can be disabled and is validated', () => {
  const list = records([
    [0, text(0)],
    [60000, text(1)],
  ]);
  const disabled = buildTimeline(list, { thresholdMs: Infinity, capMs: 1 });
  assert.equal(disabled.durationMs, 60000);
  assert.throws(() => buildTimeline(list, { capMs: 5000, thresholdMs: 1000 }), /must not exceed/);
  assert.throws(() => buildTimeline(list, { thresholdMs: -1 }), /positive/);
});

test('speeds scale wall time into display time', () => {
  const list = records([
    [0, text(0)],
    [1000, text(1)],
    [2000, text(2)],
  ]);
  const engine = createReplayEngine(list);
  engine.play();
  engine.tick(500); // 1x: the first event (displayMs 0) is revealed
  assert.equal(engine.snapshot().position, 1);
  engine.setSpeed(4);
  engine.tick(500); // 4x covers the remaining 2000ms of display time
  const snapshot = engine.snapshot();
  assert.equal(snapshot.position, 3);
  assert.equal(snapshot.atEnd, true);
  assert.equal(snapshot.phase, 'paused'); // auto-pause at the end
  assert.deepEqual(SPEEDS, [0.5, 1, 2, 4]);
});

test('pause/speed/seek/reset combinations converge on the same state', () => {
  const list = records([
    [0, text(0)],
    [1000, text(1)],
    [2000, text(2)],
    [3000, text(3)],
  ]);
  const engine = createReplayEngine(list);

  // Path A: play at 2x to 1500ms display time.
  engine.play();
  engine.setSpeed(2);
  engine.tick(750);
  const pathA = engine.snapshot();

  // Path B: seek straight there, pause/seek combos around it.
  const engineB = createReplayEngine(list);
  engineB.play();
  engineB.setSpeed(2);
  engineB.pause();
  engineB.seek(2000);
  engineB.seek(999);
  engineB.seek(1500);
  engineB.play();
  const pathB = engineB.snapshot();

  assert.equal(pathA.position, pathB.position);
  assert.equal(pathA.displayMs, pathB.displayMs);
  assert.deepEqual(pathA.display, pathB.display);
  assert.equal(pathA.displayMs, 1500);

  // Reset restores a fresh engine exactly, including speed.
  engine.reset();
  const fresh = createReplayEngine(list);
  const a = { ...engine.snapshot(), display: [...engine.snapshot().display] };
  const b = { ...fresh.snapshot(), display: [...fresh.snapshot().display] };
  assert.deepEqual(a, b);
});

test('replay never runs past the end or rewinds time on bad input', () => {
  const list = records([
    [0, text(0)],
    [1000, text(1)],
  ]);
  const engine = createReplayEngine(list);
  engine.play();
  engine.tick(999999);
  assert.equal(engine.snapshot().displayMs, 1000);
  assert.equal(engine.snapshot().position, 2);
  engine.seek(-50);
  assert.equal(engine.snapshot().displayMs, 0);
  assert.throws(() => engine.tick(-1), /non-negative/);
  assert.throws(() => engine.setSpeed(0), /positive/);
});

test('the clock adapter cleans up its timer and never fires after dispose', () => {
  const fired = [];
  let now = 0;
  const clock = createReplayClock({
    intervalMs: 100,
    onTick: delta => fired.push(delta),
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: timer => clearInterval(timer),
    now: () => now,
  });
  clock.start();
  clock.start(); // double start replaces, no leak
  clock.dispose();
  clock.dispose(); // idempotent
  assert.equal(clock.isRunning(), false);
  assert.throws(() => clock.start(), /disposed/);
});

test('clock ticks drive the engine deterministically; dispose stops the timer', () => {
  const list = records([
    [0, text(0)],
    [300, text(1)],
    [600, text(2)],
  ]);
  const engine = createReplayEngine(list);
  const seen = [];
  const live = new Set();
  const clock = createReplayClock({
    intervalMs: 100,
    onTick: delta => {
      const snapshot = engine.tick(delta);
      seen.push([snapshot.position, snapshot.phase]);
    },
    setTimer: (fn, ms) => {
      const handle = { fn, ms };
      live.add(handle);
      return handle;
    },
    clearTimer: handle => live.delete(handle),
  });
  engine.play();
  clock.start();
  const fire = () => [...live].forEach(handle => handle.fn());
  for (let tick = 0; tick < 7; tick++) fire(); // seven 100ms intervals
  clock.dispose();
  assert.equal(live.size, 0, 'dispose must clear the interval');
  for (let tick = 0; tick < 3; tick++) fire(); // nothing left to fire
  // Display time == wall time at speed 1. Events sit at 0/300/600ms.
  assert.deepEqual(seen, [
    [1, 'playing'], // 100ms
    [1, 'playing'], // 200ms
    [2, 'playing'], // 300ms: second event revealed
    [2, 'playing'], // 400ms
    [2, 'playing'], // 500ms
    [3, 'paused'], // 600ms: last event revealed -> auto-pause
    [3, 'paused'], // 700ms: paused engine ignores ticks
  ]);
});

test('the lead-in before the first event compresses like any gap and stays raw when compression is off', () => {
  // First event arrives 90s after recording start, then 250ms cadence.
  const list = records([
    [90000, text(0)],
    [90250, text(1)],
    [90500, text(2)],
  ]);
  const compressed = buildTimeline(list);
  assert.deepEqual(
    compressed.points.map(point => point.displayMs),
    [1500, 1750, 2000],
  );
  const raw = buildTimeline(list, { thresholdMs: Infinity, capMs: 1 });
  assert.deepEqual(
    raw.points.map(point => point.displayMs),
    [90000, 90250, 90500],
  );
});

test('every playback speed converges to the same final state, with wall time scaling inversely', () => {
  const list = records([
    [0, text(0)],
    [400, text(1)],
    [800, text(2)],
    [1200, text(3)],
    [1600, { type: 'done', result: { status: 'success' } }],
  ]);
  const finals = [];
  const walls = [];
  for (const speed of [0.5, 1, 2, 4]) {
    const engine = createReplayEngine(list);
    engine.play();
    engine.setSpeed(speed);
    let wall = 0;
    for (let guard = 0; engine.snapshot().phase === 'playing' && guard < 10000; guard++) {
      engine.tick(100);
      wall += 100;
    }
    const snapshot = engine.snapshot();
    finals.push(JSON.stringify(snapshot.display));
    finals.push(`${snapshot.position}/${snapshot.running}`);
    walls.push(wall);
  }
  assert.equal(new Set(finals).size, 2, 'all speeds reach one identical final display + position');
  // 1600ms of display time per run; wall time scales inversely with speed
  // (tick granularity 100ms): 0.5x needs 3200ms of ticks, 4x needs 400ms.
  assert.deepEqual(walls, [3200, 1600, 800, 400]);

  // Switching speed mid-playback is equally convergent.
  const switched = createReplayEngine(list);
  switched.play();
  switched.setSpeed(0.5);
  switched.tick(800); // 400ms of display time
  switched.setSpeed(4);
  switched.tick(300); // +1200ms of display time reaches the 1600ms end
  const snapshot = switched.snapshot();
  assert.equal(snapshot.phase, 'paused');
  assert.equal(snapshot.position, 5);
  assert.deepEqual(snapshot.display, JSON.parse(finals[0]));
});
