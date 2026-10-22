'use strict';

const { createManifest, uuidLike, isSafeRelativePath } = require('./manifest.cjs');
const { RecordingError } = require('./loader.cjs');

function fail(code, message) {
  throw new RecordingError(`native:${code}`, message);
}
function parse(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    fail('json', `Invalid JSON: ${name}`);
  }
}
function inputText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content.map(part => (part.type === 'text' ? part.text : JSON.stringify(part))).join('\n');
}

function projectNativeTrajectory(files) {
  const manifest = parse(files.get('manifest.json'), 'manifest.json');
  if (manifest.schema_version !== 'agent-trajectory-export/1.0')
    fail('schema', 'Unsupported native trajectory schema');
  if (!uuidLike(manifest.session_id)) fail('session-id', 'Invalid native session identity');
  const text = files.get('events.timeline.jsonl');
  if (!text || !text.endsWith('\n'))
    fail('truncated', 'Native event stream must end in a complete line');
  const groups = new Map();
  const ids = new Set();
  for (const [index, line] of text.trimEnd().split('\n').entries()) {
    const entry = parse(line, `events.timeline.jsonl:${index + 1}`);
    if (
      entry.schema_version !== 'agent-event/1.0' ||
      !uuidLike(entry.agent_id) ||
      !Number.isInteger(entry.source_line) ||
      entry.source_line < 1 ||
      !Number.isFinite(entry.timestamp_ms) ||
      !isSafeRelativePath(entry.source_file) ||
      !entry.raw ||
      typeof entry.raw.type !== 'string' ||
      entry.event_type !== entry.raw.type ||
      entry.event_id !== `${entry.agent_id}:${entry.source_line}`
    )
      fail('event-shape', `Malformed native event at line ${index + 1}`);
    if (ids.has(entry.event_id))
      fail('duplicate-event', `Duplicate native event ${entry.event_id}`);
    ids.add(entry.event_id);
    if (!groups.has(entry.agent_id)) groups.set(entry.agent_id, []);
    groups.get(entry.agent_id).push(entry);
  }
  const stats = manifest.statistics;
  if (!stats || stats.event_count !== ids.size || stats.agent_count !== groups.size)
    fail('count-mismatch', 'Native event/agent count does not match manifest');
  const records = [];
  const agents = [];
  let adjustedTimestamps = 0;
  let maxEventBytes = 0;
  const totals = {
    toolCalls: 0,
    toolResults: 0,
    thinkingBlocks: 0,
    compactions: 0,
    decisions: 0,
    toolErrors: 0,
  };
  const unresolved = [];
  for (const [agentId, entries] of groups) {
    // Source lines, not exported wall-time sorting, are the native order.
    entries.sort((a, b) => a.source_line - b.source_line);
    const agent = {
      id: agentId,
      eventCount: entries.length,
      turnCount: 0,
      toolCalls: 0,
      toolResults: 0,
      thinkingBlocks: 0,
      compactions: 0,
      decisions: 0,
      toolErrors: 0,
      completedTurns: 0,
    };
    const calls = new Map();
    let sortMs = 0;
    let turnId = '0';
    let lastTerminal = null;
    for (const [index, entry] of entries.entries()) {
      if (entry.source_line !== index + 1)
        fail('source-gap', `Missing native source line in ${agentId}`);
      if (entry.timestamp_ms < sortMs) adjustedTimestamps++;
      sortMs = Math.max(sortMs, entry.timestamp_ms);
      const raw = entry.raw;
      const loop = raw.type === 'context.append_loop_event' ? raw.event : null;
      if (raw.type === 'context.append_loop_event' && (!loop || typeof loop.type !== 'string'))
        fail('loop-shape', `Malformed loop event ${entry.event_id}`);
      if (raw.type === 'turn.prompt') {
        turnId = String(raw.turnId ?? agent.turnCount);
        agent.turnCount++;
        lastTerminal = null;
      }
      if (loop?.turnId !== undefined) turnId = String(loop.turnId);
      if (raw.type === 'turn.ended' && raw.turnId !== undefined) {
        if (String(raw.turnId) !== turnId)
          fail('turn-identity', `Terminal turn identity mismatch in ${entry.event_id}`);
        turnId = String(raw.turnId);
      }
      if (['content.part', 'tool.call', 'tool.result', 'step.begin'].includes(loop?.type))
        lastTerminal = null;
      if (!uuidLike(turnId))
        fail('turn-identity', `Invalid native turn identity in ${entry.event_id}`);
      const replayTurnId = `${agentId}-turn-${turnId}`;
      let event = { type: 'status', message: raw.type };
      if (raw.type === 'context.append_message') {
        if (
          !raw.message ||
          typeof raw.message.role !== 'string' ||
          raw.message.content === undefined
        )
          fail('message-shape', `Malformed input ${entry.event_id}`);
        if (raw.message.role === 'user') lastTerminal = null;
        event = {
          type: 'text',
          text: inputText(raw.message?.content),
          replayRole: raw.message?.role || 'unknown',
        };
      } else if (loop?.type === 'content.part') {
        if (
          (loop.part?.type === 'text' && typeof loop.part.text !== 'string') ||
          (loop.part?.type === 'think' && typeof loop.part.think !== 'string')
        )
          fail('content-shape', `Malformed content ${entry.event_id}`);
        if (loop.part?.type === 'text')
          event = { type: 'text', text: loop.part.text, replayRole: 'assistant' };
        else if (loop.part?.type === 'think') {
          event = { type: 'thinking', text: loop.part.think, replayRole: 'assistant' };
          agent.thinkingBlocks++;
        } else
          event = { type: 'status', message: `Recorded content: ${loop.part?.type || 'unknown'}` };
      } else if (loop?.type === 'tool.call') {
        if (
          typeof loop.toolCallId !== 'string' ||
          typeof loop.name !== 'string' ||
          !loop.name ||
          loop.args === undefined
        )
          fail('call-shape', `Malformed tool call ${entry.event_id}`);
        const id = `${agentId}:${loop.toolCallId}`;
        if (!loop.toolCallId || calls.has(id))
          fail('duplicate-call', `Duplicate or malformed tool call ${id}`);
        calls.set(id, { turnId: replayTurnId, resolved: false });
        event = { type: 'tool', id, name: loop.name, arguments: JSON.stringify(loop.args) };
        agent.toolCalls++;
      } else if (loop?.type === 'tool.result') {
        if (
          !loop.result ||
          typeof loop.result !== 'object' ||
          typeof loop.result.output !== 'string' ||
          (loop.result.isError !== undefined && typeof loop.result.isError !== 'boolean')
        )
          fail('result-shape', `Malformed tool result ${entry.event_id}`);
        const id = `${agentId}:${loop.toolCallId}`;
        const call = calls.get(id);
        if (!call || call.resolved) fail('orphan-result', `Unmatched tool result ${id}`);
        call.resolved = true;
        const output =
          typeof loop.result?.output === 'string'
            ? loop.result.output
            : JSON.stringify(loop.result?.output ?? null);
        event = {
          type: 'tool-result',
          id,
          error: Boolean(loop.result?.isError),
          output,
          outputBytes: Buffer.byteLength(output),
          message: loop.result?.note || '',
        };
        agent.toolResults++;
        if (event.error) agent.toolErrors++;
      } else if (loop?.type === 'step.begin') {
        event = { type: 'step', number: loop.step };
        agent.decisions++;
      } else if (raw.type === 'full_compaction.begin')
        event = { type: 'compaction', state: 'begin' };
      else if (raw.type === 'full_compaction.complete')
        event = { type: 'compaction', state: 'end' };
      else if (raw.type === 'context.apply_compaction') {
        event = {
          type: 'status',
          message: 'Recorded native context compaction',
          summary: raw.summary,
        };
        agent.compactions++;
      } else if (
        raw.type === 'tools.update_store' &&
        raw.name === 'todo' &&
        Array.isArray(raw.value)
      ) {
        event = { type: 'todo', items: raw.value };
      } else if (raw.type === 'turn.ended') {
        const successful = raw.reason === 'completed';
        event = successful
          ? { type: 'done', result: { status: 'success' } }
          : raw.reason === 'cancelled'
            ? { type: 'done', result: { status: 'cancelled' } }
            : { type: 'error', message: `Recorded turn ended: ${raw.reason || 'unknown'}` };
        lastTerminal = event;
        agent.completedTurns++;
      }
      event.replayAgentId = agentId;
      event.replayTurnId = loop?.type === 'tool.result' ? calls.get(event.id).turnId : replayTurnId;
      const record = {
        at: new Date(entry.timestamp_ms).toISOString(),
        sortMs,
        origin: {
          chatId: manifest.session_id,
          projectId: null,
          turnId: event.replayTurnId,
          agentId,
        },
        event,
        source: {
          eventId: entry.event_id,
          sourceFile: entry.source_file,
          sourceLine: entry.source_line,
          timestampMs: entry.timestamp_ms,
          type: raw.type,
          raw,
        },
      };
      records.push(record);
    }
    agent.outcome =
      lastTerminal?.type === 'error' ? 'error' : lastTerminal?.result?.status || 'unknown';
    for (const [id, call] of calls) if (!call.resolved) unresolved.push(id);
    for (const key of Object.keys(totals)) totals[key] += agent[key];
    agents.push(agent);
  }
  for (const [field, key] of [
    ['tool_calls', 'toolCalls'],
    ['tool_results', 'toolResults'],
    ['thinking_blocks', 'thinkingBlocks'],
    ['compactions', 'compactions'],
    ['decision_count', 'decisions'],
  ]) {
    if (stats[field] !== totals[key])
      fail('count-mismatch', `${field}: manifest ${stats[field]}, observed ${totals[key]}`);
  }
  // A k-way equivalent merge: each lane's corrected time is monotonic. The
  // original timestamp remains on source/at; correction affects display only.
  records.sort(
    (a, b) =>
      a.sortMs - b.sortMs ||
      a.origin.agentId.localeCompare(b.origin.agentId) ||
      a.source.sourceLine - b.source.sourceLine,
  );
  const start = records[0]?.sortMs;
  if (!records.length) fail('empty', 'Empty native trajectory');
  records.forEach((record, index) => {
    record.seq = index + 1;
    record.relMs = record.sortMs - start;
    delete record.sortMs;
    maxEventBytes = Math.max(maxEventBytes, Buffer.byteLength(JSON.stringify(record)));
  });
  const main = agents.find(agent => agent.id === 'main') || agents[0];
  const complete =
    manifest.task_is_running_snapshot !== true &&
    agents.every(agent => agent.outcome !== 'unknown') &&
    unresolved.length === 0;
  const resultManifest = createManifest({
    recordingId: `native-${manifest.session_id}`,
    chatId: manifest.session_id,
    displayName: 'Native trajectory',
    startedAt: new Date(start).toISOString(),
    limits: { maxEvents: records.length, maxEventBytes },
  });
  resultManifest.source = {
    kind: 'native-trajectory',
    capturedVia: 'native-wire-export',
    schema: manifest.schema_version,
  };
  resultManifest.status = complete ? 'complete' : 'incomplete';
  if (!complete) resultManifest.incompleteReason = 'stopped-before-completion';
  resultManifest.outcome = main.outcome;
  resultManifest.events = {
    file: 'events.jsonl',
    count: records.length,
    firstSeq: 1,
    lastSeq: records.length,
  };
  const warnings = [];
  if (adjustedTimestamps)
    warnings.push(
      `native:source-order: ${adjustedTimestamps} timestamps adjusted for presentation; original source time retained`,
    );
  if (unresolved.length)
    warnings.push(`native:pending-tools: ${unresolved.length} unresolved recorded calls`);
  const diagnostics = parse(files.get('diagnostics.json'), 'diagnostics.json');
  if (diagnostics.issues?.length)
    warnings.push(`native:export-diagnostics: ${diagnostics.issues.length} source issues`);
  return {
    manifest: resultManifest,
    events: records,
    warnings,
    missingAssets: [],
    native: {
      schemaVersion: manifest.schema_version,
      sessionId: manifest.session_id,
      sourceEventCount: records.length,
      agents: agents.sort((a, b) =>
        a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.id.localeCompare(b.id),
      ),
      ...totals,
      adjustedTimestamps,
      unresolvedToolCalls: unresolved,
      artifactSnapshotsIncluded: false,
      note: 'Recorded observations only; project snapshots and engineering acceptance are not reconstructed.',
    },
  };
}

module.exports = { projectNativeTrajectory };
