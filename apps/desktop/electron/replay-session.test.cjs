const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ReplaySession, loadTurns } = require('./replay-session.cjs');

// Mirrors the on-disk layout of a harness-recording bundle (#104): the
// recorder's own tests own the format; these fixtures only exercise grouping,
// torn-tail tolerance and paced re-emission.
function writeBundle(records, { tornTail = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-session-'));
  const lines = records.map(record => JSON.stringify(record));
  if (tornTail) lines.push('{"seq":99,"relMs":600,"event":{"type":"text","text":"写到一半');
  fs.writeFileSync(
    path.join(directory, 'recording.json'),
    JSON.stringify({ events: { file: 'events.jsonl' } }),
  );
  fs.writeFileSync(path.join(directory, 'events.jsonl'), lines.join('\n') + '\n');
  return directory;
}

const record = (turn, seq, relMs, event) => ({
  seq,
  relMs,
  origin: { chatId: 'chat-main', projectId: 'proj', turnId: turn, eventRevision: seq },
  event,
});

const TWO_TURNS = [
  record('turn-1', 1, 10, { type: 'text', text: '第一轮' }),
  record('turn-1', 2, 20, { type: 'done', result: { status: 'success' } }),
  record('turn-2', 3, 30, { type: 'text', text: '第二轮' }),
  record('turn-2', 4, 40, { type: 'done', result: { status: 'success' } }),
];

test('loadTurns groups records by turn in recording order and tolerates a torn tail', () => {
  const directory = writeBundle(TWO_TURNS, { tornTail: true });
  const turns = loadTurns(directory);
  assert.deepEqual(
    turns.map(turn => turn.map(item => item.event.text ?? item.event.type)),
    [
      ['第一轮', 'done'],
      ['第二轮', 'done'],
    ],
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('replay emits each turn in order through the emit it was constructed with', async () => {
  const directory = writeBundle(TWO_TURNS);
  const emitted = [];
  const previousBundle = process.env.REPLAY_BUNDLE;
  process.env.REPLAY_BUNDLE = directory;
  const session = new ReplaySession(
    '/project',
    () => ({}),
    () => {},
    () => {},
    event => emitted.push(event),
    () => ({}),
  );
  assert.deepEqual([...session.pendingApprovals, ...session.pendingQuestions], []);

  await session.run('第一轮的问题');
  assert.deepEqual(
    emitted.map(event => event.type),
    ['text', 'done'],
  );
  await session.run('第二轮的问题');
  assert.deepEqual(
    emitted.map(event => event.text ?? event.type),
    ['第一轮', 'done', '第二轮', 'done'],
  );

  // 轮次用尽后：诚实为空（不重放、不编造），TaskService 会结算为 incomplete。
  emitted.length = 0;
  await session.run('多出来的一轮');
  assert.deepEqual(emitted, []);
  if (previousBundle === undefined) delete process.env.REPLAY_BUNDLE;
  else process.env.REPLAY_BUNDLE = previousBundle;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a long recorded wait compresses to the display cap', async () => {
  const directory = writeBundle([
    record('turn-1', 1, 5, { type: 'text', text: '开始' }),
    record('turn-1', 2, 6005, { type: 'done', result: { status: 'success' } }),
  ]);
  const previousBundle = process.env.REPLAY_BUNDLE;
  process.env.REPLAY_BUNDLE = directory;
  const session = new ReplaySession(
    '',
    () => ({}),
    () => {},
    () => {},
    () => {},
    () => ({}),
  );
  const startedAt = Date.now();
  await session.run();
  const wall = Date.now() - startedAt;
  // 6s 录制间隙按 harness-replay 默认压缩（>5s → 1.5s）；宽窗防 CI 抖动。
  assert.ok(wall < 4500, `compressed wait took ${wall}ms`);
  if (previousBundle === undefined) delete process.env.REPLAY_BUNDLE;
  else process.env.REPLAY_BUNDLE = previousBundle;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('interrupt stops emission mid-turn', async () => {
  const directory = writeBundle([
    record('turn-1', 1, 1, { type: 'text', text: '前半' }),
    record('turn-1', 2, 60, { type: 'done', result: { status: 'success' } }),
  ]);
  const emitted = [];
  let firstEmitted;
  const sawFirst = new Promise(resolve => {
    firstEmitted = resolve;
  });
  const previousBundle = process.env.REPLAY_BUNDLE;
  process.env.REPLAY_BUNDLE = directory;
  const session = new ReplaySession(
    '',
    () => ({}),
    () => {},
    () => {},
    event => {
      emitted.push(event);
      firstEmitted();
    },
    () => ({}),
  );
  const running = session.run();
  await sawFirst;
  session.interrupt();
  await running;
  assert.deepEqual(
    emitted.map(event => event.type),
    ['text'],
  );
  if (previousBundle === undefined) delete process.env.REPLAY_BUNDLE;
  else process.env.REPLAY_BUNDLE = previousBundle;
  fs.rmSync(directory, { recursive: true, force: true });
});
