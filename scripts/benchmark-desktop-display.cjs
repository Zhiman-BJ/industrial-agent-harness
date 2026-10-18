const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');

// Usage: node scripts/benchmark-desktop-display.cjs [sourceDirectory]
// A comparison directory must contain both agent-events.ts and chat-history.ts.
async function main() {
  if (process.argv.length > 3)
    throw Error('Usage: node scripts/benchmark-desktop-display.cjs [sourceDirectory]');
  const root = path.resolve(__dirname, '..');
  const sourceDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(root, 'apps/desktop/src');
  const { appendDisplayEvents } = await import(
    pathToFileURL(path.join(sourceDirectory, 'agent-events.ts')).href
  );
  const { mergeHistoryEvents } = await import(
    pathToFileURL(path.join(sourceDirectory, 'chat-history.ts')).href
  );
  const results = [];
  function measure(scenario, size, operation, verify, repetitions = 5) {
    verify(operation());
    const timingsMs = [];
    let outputCount;
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const started = performance.now();
      const output = operation();
      timingsMs.push(performance.now() - started);
      verify(output);
      outputCount = Array.isArray(output) ? output.length : output.turns.length;
    }
    const sorted = [...timingsMs].sort((a, b) => a - b);
    results.push({
      scenario,
      size,
      repetitions,
      outputCount,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      timingsMs,
    });
  }
  for (const size of [2000, 4000, 8000, 16000]) {
    const events = Array.from({ length: size }, (_, i) => ({
      type: 'tool',
      id: String(i),
      name: 'ReadFile',
      arguments: '{}',
    }));
    const verify = output => assert.deepEqual(output, events);
    measure(
      'all distinct tool events in one IPC batch',
      size,
      () => appendDisplayEvents([], events),
      verify,
    );
    measure(
      'distinct tool events in individual IPC batches',
      size,
      () => {
        let state = [];
        for (const event of events) state = appendDisplayEvents(state, [event]);
        return state;
      },
      verify,
      3,
    );
  }
  for (const size of [500, 1000, 2000, 4000]) {
    const initial = Array.from({ length: size }, (_, i) => ({
      type: 'subagent-state',
      id: String(i),
      agentId: String(i),
      status: 'running',
    }));
    const updates = initial.map(event => ({ ...event, status: 'completed' }));
    measure(
      'update each subagent once in one IPC batch',
      size,
      () => appendDisplayEvents(initial, updates),
      output => {
        assert.deepEqual(output, updates);
        assert.ok(initial.every(event => event.status === 'running'));
      },
    );
    const turns = Array.from({ length: size }, (_, i) => ({
      id: String(i),
      status: 'running',
      events: [],
    }));
    const history = {
      chat: { id: 'benchmark' },
      eventRevision: 0,
      executing: true,
      turns,
    };
    const received = turns.map((turn, i) => ({
      chatId: 'benchmark',
      turnId: turn.id,
      eventRevision: i + 1,
      type: 'text',
      text: 'x',
    }));
    measure(
      'one late event per history turn',
      size,
      () => mergeHistoryEvents(history, received),
      output => {
        assert.equal(output.turns.length, size);
        assert.equal(output.eventRevision, size);
        assert.equal(output.executing, true);
        for (let index = 0; index < size; index++) {
          assert.equal(output.turns[index].id, String(index));
          assert.equal(output.turns[index].status, 'running');
          assert.deepEqual(output.turns[index].events, [received[index]]);
          assert.equal(turns[index].events.length, 0);
        }
      },
    );
  }
  process.stdout.write(
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        sourceDirectory,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        note: 'Diagnostic timings on this host only; no acceptance or responsiveness threshold is asserted. Warmup once per case. Medians exclude fixture construction and correctness assertions.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
