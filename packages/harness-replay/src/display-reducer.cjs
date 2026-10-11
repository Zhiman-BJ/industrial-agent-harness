'use strict';

// Deterministic display reducer for replay (#105). The merge semantics are a
// faithful port of apps/desktop/src/agent-events.ts `appendDisplayEvents` —
// replay must render byte-for-byte what live mode rendered from the same
// events. Any change to the live semantics must be mirrored here (and vice
// versa); the cross-implementation contract is pinned by tests.

// Port of appendDisplayEvents: subagent-state dedups by id in place; a text
// (or thinking) event merges into the last content entry; status/step never
// occupy the content slot but may sit between content entries.
function appendDisplayEvents(current, events) {
  if (!events.length) return current;
  const updated = [...current];
  let contentIndex = updated.length - 1;
  while (
    contentIndex >= 0 &&
    (updated[contentIndex].type === 'status' || updated[contentIndex].type === 'step')
  )
    contentIndex--;
  for (const event of events) {
    if (event.type === 'subagent-state') {
      const index = updated.findIndex(
        item => item.type === 'subagent-state' && item.id === event.id,
      );
      if (index >= 0) {
        updated[index] = event;
        continue;
      }
    }
    const previous = updated[contentIndex];
    if (
      (previous?.type === 'text' && event.type === 'text') ||
      (previous?.type === 'thinking' && event.type === 'thinking')
    ) {
      updated[contentIndex] = { ...previous, text: previous.text + event.text };
    } else {
      updated.push(event);
      if (event.type !== 'status' && event.type !== 'step') contentIndex = updated.length - 1;
    }
  }
  return updated;
}

// Port of latestEvent: newest event of a type (UI uses this for todo/status).
function latestEvent(events, type) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === type) return events[index];
  }
  return undefined;
}

// Full deterministic fold: display state after the first `upto` records.
// Seeking anywhere is a recompute from zero — no incremental shortcuts that
// could diverge from a fresh replay of the same prefix.
function foldDisplay(records, upto = records.length) {
  let display = [];
  for (let index = 0; index < Math.min(upto, records.length); index++) {
    display = appendDisplayEvents(display, [records[index].event]);
  }
  return display;
}

const TERMINAL_TYPES = new Set(['done', 'error']);
const NON_CONTENT_TYPES = new Set(['status', 'step', 'context-metrics', 'compaction']);

// Whether the trajectory was mid-turn at this position: scan back over
// non-content events; the run is live unless the newest content event is the
// turn's terminal (done/error). An empty prefix is not running.
function runningAt(records, position) {
  for (let index = Math.min(position, records.length) - 1; index >= 0; index--) {
    const type = records[index].event.type;
    if (NON_CONTENT_TYPES.has(type)) continue;
    return !TERMINAL_TYPES.has(type);
  }
  return false;
}

// The terminal event of the newest turn visible at this position.
function terminalAt(records, position) {
  for (let index = Math.min(position, records.length) - 1; index >= 0; index--) {
    if (TERMINAL_TYPES.has(records[index].event.type)) return records[index].event;
  }
  return null;
}

module.exports = { appendDisplayEvents, latestEvent, foldDisplay, runningAt, terminalAt };
