'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createRecorder } = require('../src/recorder.cjs');
const { exportDemoBundle, markDemoReview } = require('../src/demo-export.cjs');
const { loadBundle, validateBundle } = require('../src/index.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recording-demo-'));
}

const META = { chatId: 'chat-1', projectId: 'proj-1', turnId: 'turn-1', eventRevision: 1 };

function recordOriginal(directory) {
  const recorder = createRecorder({ directory, chatId: 'chat-1', projectId: 'proj-1' });
  recorder.start();
  recorder.record({ type: 'text', text: '在 /Users/roger/work/board.gds 上运行检查。' }, META);
  recorder.record(
    {
      type: 'tool',
      id: 't1',
      name: 'http_request',
      arguments: JSON.stringify({
        url: 'https://ci:pw@192.168.1.10/api',
        api_key: 'sk-AbCdEf1234567890Zz',
      }),
    },
    { ...META, eventRevision: 2 },
  );
  recorder.noteAsset({
    id: 'shot-1',
    type: 'image',
    bytes: Buffer.from('fake-png-bytes'),
    filename: 'shot-1.png',
  });
  recorder.record({ type: 'done', result: { status: 'success' } }, { ...META, eventRevision: 3 });
  recorder.stop();
}

function snapshot(directory) {
  const files = {};
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    const full = path.join(directory, entry);
    if (fs.statSync(full).isFile()) files[entry] = fs.readFileSync(full);
  }
  return files;
}

test('demo export redacts text, keeps structure, and leaves the original untouched', () => {
  const original = tempDir();
  const demo = path.join(tempDir(), 'demo');
  recordOriginal(original);
  const before = snapshot(original);

  const report = exportDemoBundle(original, demo, { approvedAssets: ['shot-1'] });

  assert.equal(report.events, 3);
  assert.equal(report.assetsIncluded, 1);
  assert.equal(report.reviewStatus, 'unreviewed');

  // Original bundle: byte-identical after export.
  assert.deepEqual(
    Object.fromEntries(Object.entries(snapshot(original)).map(([k, v]) => [k, v.toString()])),
    Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])),
  );

  const demoBundle = loadBundle(demo);
  assert.equal(demoBundle.manifest.redaction.applied, true);
  assert.equal(demoBundle.manifest.redaction.mode, 'demo');
  assert.equal(demoBundle.manifest.recordingId.slice(-5), '-demo');
  assert.deepEqual(validateBundle(demo), []);

  const textEvent = demoBundle.events.find(record => record.event.type === 'text');
  assert.equal(textEvent.event.text, '在 ~/work/board.gds 上运行检查。');
  const toolEvent = demoBundle.events.find(record => record.event.type === 'tool');
  const args = JSON.parse(toolEvent.event.arguments);
  assert.equal(args.api_key, '[REDACTED]');
  assert.match(args.url, /\[REDACTED\]@\[REDACTED_ENDPOINT\]/);
  // Replay anchors survive redaction.
  assert.equal(toolEvent.seq, 2);
  assert.equal(toolEvent.origin.chatId, 'chat-1');
  assert.equal(toolEvent.event.id, 't1');
});

test('unapproved assets are excluded as explicit gaps, approved bytes are unmodified', () => {
  const original = tempDir();
  const demo = path.join(tempDir(), 'demo');
  recordOriginal(original);

  const report = exportDemoBundle(original, demo, { approvedAssets: [] });
  assert.equal(report.assetsIncluded, 0);
  assert.equal(report.assetsExcluded, 1);

  const bundle = loadBundle(demo);
  assert.deepEqual(bundle.missingAssets, ['shot-1']);
  assert.equal(bundle.manifest.assets[0].status, 'missing');
  assert.ok(!fs.existsSync(path.join(demo, 'assets', 'shot-1.png')));

  const approved = exportDemoBundle(original, path.join(tempDir(), 'demo2'), {
    approvedAssets: ['shot-1'],
  });
  assert.equal(approved.assetsIncluded, 1);
  const copied = fs.readFileSync(path.join(approved.directory, 'assets', 'shot-1.png'));
  assert.equal(copied.toString(), 'fake-png-bytes');
});

test('human review status is recorded on the demo copy only', () => {
  const original = tempDir();
  const demo = path.join(tempDir(), 'demo');
  recordOriginal(original);
  exportDemoBundle(original, demo, {});

  const redaction = markDemoReview(demo, { status: 'approved', note: '人工核对 2026-10-11' });
  assert.equal(redaction.reviewed, 'approved');
  assert.equal(redaction.reviewNote, '人工核对 2026-10-11');
  assert.ok(redaction.reviewedAt);
  assert.deepEqual(validateBundle(demo), []);
  assert.throws(() => markDemoReview(original, { status: 'approved' }), /demo copies only/);
});

test('export refuses to overwrite a non-bundle directory or its own source', () => {
  const original = tempDir();
  recordOriginal(original);
  const foreign = tempDir();
  fs.writeFileSync(path.join(foreign, 'important.txt'), 'do not delete');
  assert.throws(() => exportDemoBundle(original, foreign, {}), /non-bundle directory/);
  assert.equal(fs.readFileSync(path.join(foreign, 'important.txt')).toString(), 'do not delete');
  assert.throws(() => exportDemoBundle(original, original, {}), /must differ/);
  assert.deepEqual(validateBundle(original), []);
});

test('selected literals are redacted across the whole demo copy', () => {
  const original = tempDir();
  const demo = path.join(tempDir(), 'demo');
  const recorder = createRecorder({ directory: original, chatId: 'chat-1' });
  recorder.start();
  recorder.record({ type: 'text', text: '客户甲 的 Acme 供应链数据已完成。' }, META);
  recorder.record({ type: 'done', result: { status: 'success' } }, { ...META, eventRevision: 2 });
  recorder.stop();

  exportDemoBundle(original, demo, { literals: ['客户甲', 'Acme'] });
  const bundle = loadBundle(demo);
  const text = bundle.events.find(record => record.event.type === 'text');
  assert.equal(text.event.text, '[REDACTED] 的 [REDACTED] 供应链数据已完成。');
});

test('an interrupted original exports honestly as an incomplete demo', () => {
  const original = tempDir();
  const recorder = createRecorder({ directory: original, chatId: 'chat-1' });
  recorder.start();
  recorder.record({ type: 'text', text: '进行中 /Users/roger/x' }, META);
  // No stop(): crash state, loaded as interrupted evidence by the loader.

  const demo = path.join(tempDir(), 'demo');
  const report = exportDemoBundle(original, demo, {});
  assert.equal(report.events, 1);
  const bundle = loadBundle(demo);
  assert.equal(bundle.manifest.status, 'incomplete');
  assert.equal(bundle.manifest.incompleteReason, 'app-shutdown');
  assert.equal(bundle.events[0].event.text, '进行中 ~/x');
});
