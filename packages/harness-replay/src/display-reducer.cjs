'use strict';

// Deterministic display reducer for replay (#105). The merge semantics are a
// faithful port of apps/desktop/src/agent-events.ts `appendDisplayEvents`.
// Imported native recordings additionally scope streaming content by agent
// and turn: independent native streams must never become one message.

// Port of appendDisplayEvents: subagent-state dedups by id in place; a text
// (or thinking) event merges into the last content entry; status/step never
// occupy the content slot but may sit between content entries.
function appendDisplayEvents(current, events) {
  if (!events.length) return current;
  const updated = [...current];
  let subagentIndices;
  let contentIndex = updated.length - 1;
  while (
    contentIndex >= 0 &&
    (updated[contentIndex].type === 'status' || updated[contentIndex].type === 'step')
  )
    contentIndex--;
  for (const event of events) {
    if (event.type === 'subagent-state') {
      if (!subagentIndices) {
        subagentIndices = new Map();
        for (let index = 0; index < updated.length; index++) {
          const item = updated[index];
          if (item.type === 'subagent-state' && !subagentIndices.has(item.id))
            subagentIndices.set(item.id, index);
        }
      }
      const index = subagentIndices.get(event.id);
      if (index !== undefined) {
        updated[index] = event;
        continue;
      }
      subagentIndices.set(event.id, updated.length);
    }
    const previous = updated[contentIndex];
    if (
      ((previous?.type === 'text' && event.type === 'text') ||
        (previous?.type === 'thinking' && event.type === 'thinking')) &&
      previous.replayAgentId === event.replayAgentId &&
      previous.replayTurnId === event.replayTurnId &&
      previous.replayRole === event.replayRole
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
  const events = [];
  for (let index = 0; index < Math.min(upto, records.length); index++) {
    events.push(records[index].event);
  }
  return appendDisplayEvents([], events);
}

const TERMINAL_TYPES = new Set(['done', 'error']);
const NON_CONTENT_TYPES = new Set(['status', 'step', 'context-metrics', 'compaction']);

function agentId(record) {
  return record.event.replayAgentId ?? record.origin?.agentId;
}

// A child's terminal settles that child's stream, never the parent turn.
// Legacy recordings have no lane identity and retain their original behavior.
// An already-filtered child recording naturally selects its own first lane.
function lifecycleAgent(records) {
  let first;
  let hasRoot = false;
  for (const record of records) {
    const id = agentId(record);
    if (id === 'main') return 'main';
    if (id === 'root') hasRoot = true;
    if (first === undefined && id !== undefined) first = id;
  }
  return hasRoot ? 'root' : first;
}

function isLifecycleRecord(record, selectedAgent) {
  const id = agentId(record);
  return selectedAgent === undefined || id === undefined || id === selectedAgent;
}

// Build once for the engine. Repeated ticks and snapshots need constant-time
// lifecycle lookup even when 40,000 native metadata events follow a terminal.
function createLifecycleIndex(records) {
  const selectedAgent = lifecycleAgent(records);
  const running = new Uint8Array(records.length + 1);
  const terminal = new Array(records.length + 1);
  terminal[0] = null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const type = record.event.type;
    running[index + 1] = running[index];
    terminal[index + 1] = terminal[index];
    if (!isLifecycleRecord(record, selectedAgent)) continue;
    if (!NON_CONTENT_TYPES.has(type)) running[index + 1] = TERMINAL_TYPES.has(type) ? 0 : 1;
    if (TERMINAL_TYPES.has(type)) terminal[index + 1] = record.event;
  }
  return {
    runningAt(position) {
      return running[Math.max(0, Math.min(position, records.length))] === 1;
    },
    terminalAt(position) {
      return terminal[Math.max(0, Math.min(position, records.length))] ?? null;
    },
  };
}

// Whether the trajectory was mid-turn at this position: scan back over
// non-content events; the run is live unless the newest content event is the
// turn's terminal (done/error). An empty prefix is not running.
function runningAt(records, position) {
  const selectedAgent = lifecycleAgent(records);
  for (let index = Math.min(position, records.length) - 1; index >= 0; index--) {
    if (!isLifecycleRecord(records[index], selectedAgent)) continue;
    const type = records[index].event.type;
    if (NON_CONTENT_TYPES.has(type)) continue;
    return !TERMINAL_TYPES.has(type);
  }
  return false;
}

// The terminal event of the newest turn visible at this position.
function terminalAt(records, position) {
  const selectedAgent = lifecycleAgent(records);
  for (let index = Math.min(position, records.length) - 1; index >= 0; index--) {
    if (!isLifecycleRecord(records[index], selectedAgent)) continue;
    if (TERMINAL_TYPES.has(records[index].event.type)) return records[index].event;
  }
  return null;
}

module.exports = {
  appendDisplayEvents,
  latestEvent,
  foldDisplay,
  runningAt,
  terminalAt,
  createLifecycleIndex,
};
