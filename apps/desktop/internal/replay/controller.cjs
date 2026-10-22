'use strict';

// Internal presentation adapter only. No task service, agent, tool, project store,
// or runtime is constructed here. Every returned row is historical source data.
const { createReplayEngine } = require('../../../../packages/harness-replay/src/index.cjs');

const PAGE_SIZE = 100;
const agentId = record => record.origin?.agentId || record.event?.replayAgentId || 'main';

function createReplayController(bundle) {
  const records = bundle.events;
  const engine = createReplayEngine(records);
  const agents = new Map();
  for (const [index, record] of records.entries()) {
    const id = agentId(record);
    if (!agents.has(id)) agents.set(id, []);
    agents.get(id).push(index);
  }
  function reached(indices, position) {
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indices[middle] < position) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function snapshot() {
    const { display: _display, ...state } = engine.snapshot();
    return {
      ...state,
      agents: [...agents].map(([id, indices]) => ({
        ...(bundle.native?.agents?.find(agent => agent.id === id) || {}),
        id,
        totalEvents: indices.length,
        reachedEvents: reached(indices, state.position),
      })),
    };
  }
  function page(request = {}) {
    const position = engine.snapshot().position;
    const id = request.agentId || '';
    const indices = id ? agents.get(id) || [] : null;
    const total = indices ? reached(indices, position) : position;
    const requested = Number.isFinite(request.offset) ? Math.max(0, Math.trunc(request.offset)) : 0;
    const offset = Math.min(requested, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
    const rows = [];
    for (let index = offset; index < Math.min(total, offset + PAGE_SIZE); index++) {
      const sourceIndex = indices ? indices[index] : index;
      rows.push({ sourceIndex, record: records[sourceIndex] });
    }
    return { offset, total, pageSize: PAGE_SIZE, rows };
  }
  function control(request = {}) {
    switch (request.action) {
      case 'play':
        engine.play();
        break;
      case 'pause':
        engine.pause();
        break;
      case 'reset':
        engine.reset();
        break;
      case 'speed':
        engine.setSpeed(request.value);
        break;
      case 'seek':
        if (!Number.isFinite(request.value)) throw Error('Replay position must be finite');
        engine.seekToPosition(request.value);
        break;
      default:
        throw Error('Unsupported replay control');
    }
    return snapshot();
  }
  return {
    metadata() {
      return {
        manifest: bundle.manifest,
        native: bundle.native,
        warnings: bundle.warnings || [],
        missingAssets: bundle.missingAssets || [],
        ...snapshot(),
      };
    },
    snapshot,
    page,
    control,
    tick(deltaMs) {
      engine.tick(deltaMs);
      return snapshot();
    },
  };
}

module.exports = { createReplayController, PAGE_SIZE };
