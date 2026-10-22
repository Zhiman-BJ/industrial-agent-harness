'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const {
  verifyNativeReplay,
  installOfflineGuards,
  readNativeSource,
} = require('../../scripts/verify-native-replay.cjs');

function makeExport(directory) {
  const base = Date.parse('2026-10-21T01:00:00.000Z');
  const agents = { main: [], 'agent-1': [] };
  for (const [agentId, events] of Object.entries(agents)) {
    const add = (type, fields = {}, time = base + events.length * 10) =>
      events.push({ type, agentId, ...fields, time });
    const loop = event => add('context.append_loop_event', { event });
    add('metadata', { protocol_version: '1.5', created_at: base });
    add('turn.prompt', { turnId: 0, prompt: 'Recorded input is reference data only.' });
    add('context.append_message', {
      message: { role: 'user', content: [{ type: 'text', text: 'Replay this history.' }] },
    });
    add('agent.turn.started', { turnId: 0 });
    loop({ type: 'step.begin', uuid: 'step-0', turnId: '0', step: 1 });
    loop({
      type: 'content.part',
      turnId: '0',
      step: 1,
      stepUuid: 'step-0',
      part: {
        type: 'think',
        think: `Recorded reasoning: ${agentId} 中文`,
        reasoningKey: 'reasoning_content',
      },
    });
    loop({
      type: 'content.part',
      turnId: '0',
      step: 1,
      stepUuid: 'step-0',
      part: { type: 'text', text: `Recorded reply: ${agentId}` },
    });
    add('agent.message.appended', {
      message: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Recorded reply: ${agentId}` }],
        },
      },
    });
    // Both agents deliberately reuse the native tool ID and step/turn IDs.
    loop({
      type: 'tool.call',
      uuid: 'call-event',
      turnId: '0',
      step: 1,
      toolCallId: 'shared-call',
      name: 'Bash',
      args: {
        command: 'DO_NOT_EXECUTE_RECORDED_COMMAND',
        unicode: '保留',
        nested: { array: [1, false, null] },
      },
    });
    loop({
      type: 'tool.result',
      parentUuid: 'call-event',
      toolCallId: 'shared-call',
      result: {
        output: `history\n${agentId}\n`,
        isError: agentId === 'agent-1',
        note: 'Preserve historical failures',
        durationMs: 3,
      },
    });
    loop({ type: 'step.end', uuid: 'step-0', turnId: '0', step: 1, finishReason: 'tool_use' });
    add('context.apply_compaction', { summary: `Recorded summary: ${agentId}` });
    loop({ type: 'step.begin', uuid: 'step-1', turnId: '0', step: 2 });
    loop({
      type: 'content.part',
      turnId: '0',
      step: 2,
      stepUuid: 'step-1',
      part: { type: 'text', text: `Done: ${agentId}` },
    });
    loop({ type: 'step.end', uuid: 'step-1', turnId: '0', step: 2, finishReason: 'end_turn' });
    add('turn.ended', { turnId: 0, reason: 'completed' });
    add('prompt.completed', { reason: 'completed' });
    // A later source line has an older timestamp, as in the real native corpus.
    add('agent.turn.ended', { turnId: 0, outcome: 'done', kind: 'event' }, base + 140);
    const wire = path.join(directory, 'raw/session/agents', agentId, 'wire.jsonl');
    fs.mkdirSync(path.dirname(wire), { recursive: true });
    fs.writeFileSync(wire, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  }
  const count = Object.values(agents).reduce((sum, events) => sum + events.length, 0);
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      schema_version: 'agent-trajectory-export/1.0',
      session_id: 'native-replay-integration',
      task_is_running_snapshot: false,
      task_exit_code: 0,
      cutoff: { timestamp_ms: base + 10000 },
      statistics: {
        agent_count: 2,
        event_count: count,
        tool_calls: 2,
        tool_results: 2,
        thinking_blocks: 2,
        compactions: 2,
        decision_count: 4,
      },
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'raw/session/state.json'),
    JSON.stringify({
      id: 'native-replay-integration',
      version: 2,
      lastTurnReason: 'completed',
      agents: { main: { type: 'main' }, 'agent-1': { type: 'sub', parentAgentId: 'main' } },
    }),
  );
  const timeline = Object.entries(agents)
    .flatMap(([agentId, events]) =>
      events.map((raw, index) => ({
        schema_version: 'agent-event/1.0',
        agent_id: agentId,
        event_id: `${agentId}:${index + 1}`,
        source_line: index + 1,
        source_file: `raw/session/agents/${agentId}/wire.jsonl`,
        timestamp_ms: raw.time,
        event_type: raw.type,
        raw,
      })),
    )
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  fs.writeFileSync(
    path.join(directory, 'events.timeline.jsonl'),
    timeline.map(event => JSON.stringify(event)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(directory, 'diagnostics.json'),
    JSON.stringify({ issues: [], pending_tool_calls: {}, orphan_tool_results: {} }),
  );
  const checksums = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else
        checksums.push(
          `${crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(directory, name)))
            .digest('hex')}  ${name}`,
        );
    }
  };
  visit('');
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
  return count;
}

function tarMember(name, bytes) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

function archiveExport(directory, destination) {
  const members = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else members.push(tarMember(`export/${name}`, fs.readFileSync(path.join(directory, name))));
    }
  };
  visit('');
  fs.writeFileSync(destination, zlib.gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])));
}

test('native source reader preserves every source location and rejects traversal archives', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-replay-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const count = makeExport(directory);
  const source = await readNativeSource(directory);
  assert.equal(source.expected.size, count);
  assert.equal(source.agents.length, 2);
  assert.equal(
    source.agents.reduce((sum, agent) => sum + agent.historicalToolErrors, 0),
    1,
  );
  const archive = path.join(directory, 'unsafe.tar.gz');
  fs.writeFileSync(
    archive,
    zlib.gzipSync(
      Buffer.concat([tarMember('../wire.jsonl', Buffer.from('{}\n')), Buffer.alloc(1024)]),
    ),
  );
  await assert.rejects(readNativeSource(archive), /Unsafe archive name/);
});

test('offline acceptance guards reject network, process launch, model imports and writes', async () => {
  const before = fs.writeFileSync;
  const guard = installOfflineGuards();
  try {
    assert.throws(() => require('node:child_process').spawn('do-not-launch'), /forbidden/);
    assert.throws(() => require('node:http').get('http://127.0.0.1/'), /forbidden/);
    assert.throws(() => require('openai'), /forbidden/);
    assert.throws(() => fs.writeFileSync('/do-not-write', ''), /forbidden/);
    assert.equal(guard.attempts.length, 4);
  } finally {
    guard.restore();
  }
  assert.equal(fs.writeFileSync, before);
});

test('native directory and archive replay preserve both agents, tool failures and seek/reset', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-replay-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const count = makeExport(source);
  const archive = path.join(directory, 'native.tar.gz');
  archiveExport(source, archive);
  const reports = [];
  for (const input of [source, archive]) {
    const report = await verifyNativeReplay(input);
    assert.equal(report.passed, true);
    assert.equal(report.sourceEvents, count);
    assert.equal(report.playback.consumedEvents, count);
    assert.equal(report.historicalToolErrors, 1);
    assert.deepEqual(report.offline.attemptedOperations, []);
    assert.equal(report.offline.sourceFilesUnchanged, true);
    assert.equal(
      report.agents.reduce((sum, agent) => sum + agent.thinking, 0),
      2,
    );
    reports.push(report);
  }
  assert.deepEqual(reports[0].contentHashes, reports[1].contentHashes);
  assert.equal(reports[0].playback.displaySha256, reports[1].playback.displaySha256);
});

const realInput = process.env.HARNESS_NATIVE_REPLAY_INPUT;
test(
  'opt-in native corpus fully replays without live execution',
  { skip: !realInput },
  async () => {
    const report = await verifyNativeReplay(realInput);
    assert.equal(report.passed, true);
    assert.equal(report.playback.consumedEvents, report.sourceEvents);
    assert.deepEqual(report.offline.attemptedOperations, []);
    // Dataset-independent by default; pin a specific acceptance corpus when supplied.
    if (process.env.HARNESS_NATIVE_REPLAY_EXPECTED_EVENTS)
      assert.equal(report.sourceEvents, Number(process.env.HARNESS_NATIVE_REPLAY_EXPECTED_EVENTS));
  },
);
