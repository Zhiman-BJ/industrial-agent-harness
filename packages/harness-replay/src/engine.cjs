'use strict';

// Deterministic replay engine (#105). No timers, no clock, no IO: the host
// drives time via tick(deltaMs), so the same tick sequence always produces
// the same state (the pause/speed/seek/reset acceptance requirement). Play
// advances incrementally for cheapness, but seek recomputes from zero, and
// tests pin incremental == full-fold at every position.

const { buildTimeline } = require('./timeline.cjs');
const { appendDisplayEvents, foldDisplay, createLifecycleIndex } = require('./display-reducer.cjs');

const SPEEDS = [0.5, 1, 2, 4];

function createReplayEngine(records, options = {}) {
  if (!Array.isArray(records)) throw Error('engine requires a records array from a loaded bundle');
  for (const record of records) {
    if (!record || typeof record.event !== 'object' || !Number.isFinite(record.relMs))
      throw Error('engine records must be loaded bundle records (seq/relMs/event)');
  }
  const timeline = buildTimeline(records, options.compression);
  const lifecycle = createLifecycleIndex(records);

  const state = {
    phase: 'paused', // paused | playing
    speed: 1,
    displayMs: 0,
    position: 0,
    running: false,
    atEnd: records.length === 0,
    display: [],
  };

  function recompute() {
    state.display = foldDisplay(records, state.position);
    state.running = lifecycle.runningAt(state.position);
    state.atEnd = state.position >= records.length;
  }

  function clampDisplayTime(displayMs) {
    return Math.max(0, Math.min(displayMs, timeline.durationMs));
  }

  function play() {
    if (state.atEnd) return snapshot();
    state.phase = 'playing';
    return snapshot();
  }

  function pause() {
    state.phase = 'paused';
    return snapshot();
  }

  // Any positive speed is accepted; the UI offers 0.5/1/2/4 per the issue.
  function setSpeed(speed) {
    if (!Number.isFinite(speed) || speed <= 0) throw Error('speed must be a positive number');
    state.speed = speed;
    return snapshot();
  }

  // Advance by wall-clock delta. Only playing state consumes time; the host
  // clock should not call tick while paused, but tolerating it keeps the
  // engine robust against racing clock callbacks.
  function tick(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw Error('deltaMs must be non-negative');
    if (state.phase !== 'playing') return snapshot();
    const target = clampDisplayTime(state.displayMs + deltaMs * state.speed);
    const targetPosition = timeline.positionAt(target);
    if (targetPosition > state.position) {
      const incoming = records.slice(state.position, targetPosition).map(record => record.event);
      state.display = appendDisplayEvents(state.display, incoming);
      state.position = targetPosition;
      state.running = lifecycle.runningAt(state.position);
      state.atEnd = state.position >= records.length;
    }
    state.displayMs = target;
    if (state.atEnd) state.phase = 'paused';
    return snapshot();
  }

  // Jump to a display time; deterministic full recompute, phase preserved.
  function seek(displayMs) {
    state.displayMs = clampDisplayTime(displayMs);
    state.position = timeline.positionAt(state.displayMs);
    recompute();
    if (state.atEnd) state.phase = 'paused';
    return snapshot();
  }

  function seekToPosition(position) {
    const clamped = Math.max(0, Math.min(Math.trunc(position), records.length));
    state.position = clamped;
    state.displayMs = timeline.displayAt(clamped);
    recompute();
    if (state.atEnd) state.phase = 'paused';
    return snapshot();
  }

  // Restore the initial state, including speed: a reset replay is
  // indistinguishable from a fresh one.
  function reset() {
    state.phase = 'paused';
    state.speed = 1;
    state.displayMs = 0;
    state.position = 0;
    recompute();
    return snapshot();
  }

  function snapshot() {
    return {
      phase: state.phase,
      speed: state.speed,
      displayMs: state.displayMs,
      position: state.position,
      totalEvents: records.length,
      durationMs: timeline.durationMs,
      running: state.running,
      atEnd: state.atEnd,
      // Read-only by convention: consumers must not mutate the display list.
      display: state.display,
      terminal: lifecycle.terminalAt(state.position),
      sourceMs: timeline.sourceAt(state.displayMs),
    };
  }

  recompute();
  return { play, pause, setSpeed, tick, seek, seekToPosition, reset, snapshot, timeline };
}

module.exports = { createReplayEngine, SPEEDS };
