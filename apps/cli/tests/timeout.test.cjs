const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('../src/args.cjs');
const { scheduleTimeout } = require('../src/lib/timeout.cjs');
const { run } = require('../src/main.cjs');

function clock() {
  let elapsed = 0n;
  let sequence = 0;
  const pending = new Map();
  return {
    pending,
    timers: {
      now: () => elapsed * 1000000n,
      setTimer(callback, delay) {
        assert.ok(Number.isInteger(delay) && delay > 0 && delay <= 2147483647);
        const id = ++sequence;
        pending.set(id, { callback, delay, due: elapsed + BigInt(delay) });
        return id;
      },
      clearTimer: id => pending.delete(id),
    },
    advance(milliseconds) {
      elapsed += BigInt(milliseconds);
      for (const [id, item] of [...pending]) {
        if (item.due <= elapsed && pending.delete(id)) item.callback();
      }
    },
  };
}

test('CLI accepts positive decimal durations without a two-hour or numeric-precision cap', () => {
  const base = ['run', '--project-dir', '.', '--domain', 'chip', '--task', 'Inspect'];
  assert.equal(parseArgs(base).timeoutMs, undefined);
  for (const value of ['1', '7200001', '2592000000', '9007199254740993', '1' + '0'.repeat(80)])
    assert.equal(parseArgs([...base, '--timeout-ms', value]).timeoutMs, value);
  for (const value of ['0', '-1', '1.5', 'Infinity', 'NaN', '0x1000', '1e9'])
    assert.throws(() => parseArgs([...base, '--timeout-ms', value]), /positive integer/);
});

test('omitting the timeout allocates no clock or timer', () => {
  assert.equal(
    scheduleTimeout(undefined, () => assert.fail('No deadline'), {
      now: () => assert.fail('No clock needed'),
      setTimer: () => assert.fail('No timer needed'),
    }),
    undefined,
  );
});

test('long deadlines survive multiple Node timer chunks and fire exactly once', () => {
  const time = clock();
  const results = [];
  scheduleTimeout('4294967304', value => results.push(value), time.timers);
  assert.equal([...time.pending.values()][0].delay, 2147483647);
  time.advance(2147483647);
  assert.deepEqual(results, []);
  assert.equal([...time.pending.values()][0].delay, 2147483647);
  time.advance(2147483647);
  assert.deepEqual(results, []);
  assert.equal([...time.pending.values()][0].delay, 10);
  time.advance(9);
  assert.deepEqual(results, []);
  time.advance(1);
  assert.deepEqual(results, [4294967304]);
  assert.equal(time.pending.size, 0);
  time.advance(100);
  assert.equal(results.length, 1);
});

test('durations beyond Number precision remain exact in timing and JSON events', () => {
  const time = clock();
  const results = [];
  scheduleTimeout('9007199254740993', value => results.push(value), time.timers);
  time.advance('9007199254740992');
  assert.deepEqual(results, []);
  assert.equal([...time.pending.values()][0].delay, 1);
  time.advance(1);
  assert.equal(JSON.stringify(results), '["9007199254740993"]');
});

test('cancelling after a timer chunk removes the pending timeout and ignores queued callbacks', () => {
  const time = clock();
  const cancel = scheduleTimeout(
    '2147483657',
    () => assert.fail('Cancelled deadline'),
    time.timers,
  );
  time.advance(2147483647);
  const queued = [...time.pending.values()][0].callback;
  cancel();
  cancel();
  assert.equal(time.pending.size, 0);
  queued();
  time.advance(100);
  assert.equal(time.pending.size, 0);
});

test('CLI completes with a 30-day deadline and preserves timeout cancellation with exit 124', async t => {
  for (const timeoutMs of ['2592000000', '1']) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-timeout-'));
    t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
    const rows = [];
    let interrupted = false;
    class Session {
      constructor(_directory, _scope, _artifact, _disclose, emit) {
        this.emit = emit;
      }
      async run() {
        await new Promise(resolve => {
          this.finish = resolve;
          this.timer = setTimeout(resolve, 25);
        });
        this.emit({ type: 'done', result: { status: 'completed' } });
      }
      async interrupt() {
        interrupted = true;
        clearTimeout(this.timer);
        this.finish();
      }
      async close() {
        clearTimeout(this.timer);
      }
    }
    const code = await run(
      {
        projectDir,
        domain: 'chip',
        task: 'Inspect netlist signals',
        timeoutMs,
        chatDir: path.join(projectDir, 'chats'),
        stateDir: path.join(projectDir, 'state'),
      },
      { write: line => rows.push(JSON.parse(line)) },
      { KIMI_API_KEY: 'test-key', INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'config') },
      Session,
    );
    const expired = timeoutMs === '1';
    assert.equal(code, expired ? 124 : 0);
    assert.equal(interrupted, expired);
    assert.equal(rows.at(-1).status, expired ? 'timeout' : 'completed');
    assert.equal(rows.filter(row => row.type === 'timeout').length, expired ? 1 : 0);
    if (expired) assert.equal(rows.find(row => row.type === 'timeout').timeoutMs, 1);
  }
});
