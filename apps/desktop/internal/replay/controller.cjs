'use strict';

// Internal presentation adapter only. No task service, agent, tool, project store,
// or runtime is constructed here. Every returned row is historical source data.
const {
  createReplayEngine,
  appendDisplayEvents,
} = require('../../../../packages/harness-replay/src/index.cjs');

const PAGE_SIZE = 100;
const agentId = record => record.origin?.agentId || record.event?.replayAgentId || 'main';

function createReplayController(bundle) {
  const records = bundle.events;
  const engine = createReplayEngine(records);
  const declaredAssets = new Set((bundle.manifest.assets || []).map(asset => asset.id));
  const stages = (bundle.manifest.replayStages || [])
    .map(stage => {
      if (
        !stage ||
        typeof stage.id !== 'string' ||
        typeof stage.title !== 'string' ||
        !Number.isSafeInteger(stage.atSeq) ||
        stage.atSeq < 1 ||
        typeof stage.assetId !== 'string' ||
        !declaredAssets.has(stage.assetId)
      )
        throw Error('Replay stages require a declared asset and a positive source sequence');
      const index = records.findIndex(record => record.seq >= stage.atSeq);
      if (index < 0) throw Error('Replay stage source sequence is outside the recording');
      return { ...stage, position: index + 1 };
    })
    .sort((a, b) => a.position - b.position);
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
    const state = engine.snapshot();
    delete state.display;
    return {
      ...state,
      activeStageId:
        [...stages].reverse().find(stage => stage.position <= state.position)?.id || null,
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
  function flow(request = {}) {
    const id = request.agentId || (agents.has('main') ? 'main' : agents.keys().next().value);
    const position = engine.snapshot().position;
    const turns = new Map();
    for (const sourceIndex of agents.get(id) || []) {
      if (sourceIndex >= position) break;
      const record = records[sourceIndex];
      const turnId = record.origin?.turnId || record.event.replayTurnId || 'turn-1';
      if (!turns.has(turnId))
        turns.set(turnId, { id: turnId, task: '', sourceRecords: 0, events: [] });
      const turn = turns.get(turnId);
      turn.sourceRecords++;
      if (record.event.type === 'text' && record.event.replayRole === 'user')
        turn.task += record.event.text;
      else if (
        !['status', 'step', 'context-metrics', 'compaction', 'diagnostic-log'].includes(
          record.event.type,
        )
      )
        turn.events.push(record.event);
    }
    const all = [...turns.values()].filter(turn => turn.task || turn.events.length);
    const requestedTurn = Number.isInteger(request.turnOffset)
      ? request.turnOffset
      : all.length - 1;
    const turnOffset = Math.max(0, Math.min(requestedTurn, all.length - 1));
    const turn = all[turnOffset];
    if (!turn) return { position, agentId: id, turnOffset: 0, totalTurns: 0, turn: null };
    const folded = appendDisplayEvents([], turn.events);
    const blocks = [];
    const tools = new Map();
    for (const event of folded) {
      if (event.type === 'tool') {
        if (tools.has(event.id)) blocks[tools.get(event.id)].push(event);
        else {
          tools.set(event.id, blocks.length);
          blocks.push([event]);
        }
      } else if (event.type === 'tool-result' && tools.has(event.id))
        blocks[tools.get(event.id)].push(event);
      else blocks.push([event]);
    }
    const limit = 40;
    const requestedOffset = Number.isInteger(request.blockOffset)
      ? Math.max(0, request.blockOffset)
      : Math.max(0, blocks.length - limit);
    const blockOffset = Math.min(requestedOffset, Math.max(0, blocks.length - 1));
    return {
      position,
      agentId: id,
      turnOffset,
      totalTurns: all.length,
      turn: {
        ...turn,
        events: blocks.slice(blockOffset, blockOffset + limit).flat(),
        blockOffset,
        totalBlocks: blocks.length,
        blockLimit: limit,
      },
    };
  }
  return {
    metadata() {
      return {
        manifest: bundle.manifest,
        native: bundle.native,
        warnings: bundle.warnings || [],
        missingAssets: bundle.missingAssets || [],
        replayStages: stages,
        ...snapshot(),
      };
    },
    snapshot,
    page,
    control,
    flow,
    image(assetId, readImage) {
      if (
        typeof assetId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId) ||
        !stages.some(stage => stage.assetId === assetId) ||
        !declaredAssets.has(assetId)
      )
        throw Error('Replay image requires a declared stage asset ID');
      if (typeof readImage !== 'function') throw Error('Replay image provider is unavailable');
      return readImage(bundle, assetId);
    },
    tick(deltaMs) {
      engine.tick(deltaMs);
      return snapshot();
    },
  };
}

module.exports = { createReplayController, PAGE_SIZE };
