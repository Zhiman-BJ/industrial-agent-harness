'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createRecorder } = require('../src/recorder.cjs');
const { loadBundle } = require('../src/loader.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recording-'));
}

const META = { chatId: 'chat-1', projectId: 'proj-1', turnId: 'turn-1', eventRevision: 1 };

function successFlow(recorder) {
  recorder.record({ type: 'text', text: '让我检查布局。' }, { ...META, eventRevision: 1 });
  recorder.record(
    { type: 'tool', id: 't1', name: 'read_layout', arguments: '{}' },
    { ...META, eventRevision: 2 },
  );
  recorder.record(
    { type: 'tool-result', id: 't1', error: false, message: '', output: 'ok', outputBytes: 2 },
    { ...META, eventRevision: 3 },
  );
  recorder.record({ type: 'done', result: { status: 'success' } }, { ...META, eventRevision: 4 });
}

test('records an ordered single-chat stream and seals complete', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1', projectId: 'proj-1' });
  recorder.start();
  successFlow(recorder);
  const sealed = recorder.stop();
  assert.equal(sealed.status, 'complete');

  const bundle = loadBundle(dir);
  assert.equal(bundle.manifest.status, 'complete');
  assert.equal(bundle.manifest.outcome, 'success');
  assert.equal(bundle.manifest.events.count, 4);
  assert.equal(bundle.events.length, 4);
  assert.deepEqual(
    bundle.events.map(record => record.seq),
    [1, 2, 3, 4],
  );
  const rel = bundle.events.map(record => record.relMs);
  assert.deepEqual(
    rel,
    [...rel].sort((a, b) => a - b),
    'relMs must be non-decreasing',
  );
  assert.equal(bundle.warnings.length, 0);
});

test('events from other chats never leak into the bundle', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  const foreign = { chatId: 'chat-2', projectId: 'proj-2', turnId: 'turn-9', eventRevision: 1 };
  assert.equal(recorder.record({ type: 'text', text: '其他会话' }, foreign), false);
  successFlow(recorder);
  recorder.stop();
  assert.equal(recorder.stats().ignoredForeign, 1);

  const bundle = loadBundle(dir);
  assert.equal(bundle.events.length, 4);
  assert.ok(bundle.events.every(record => record.origin.chatId === 'chat-1'));
});

test('stop without a terminal event seals incomplete with an explicit reason', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.record({ type: 'text', text: '进行中' }, META);
  const sealed = recorder.stop();
  assert.equal(sealed.status, 'incomplete');
  assert.equal(sealed.incompleteReason, 'stopped-before-completion');
  assert.equal(loadBundle(dir).manifest.incompleteReason, 'stopped-before-completion');
});

test('dispose marks app interruption without inventing a terminal event', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  successFlow(recorder);
  const sealed = recorder.dispose();
  assert.equal(sealed.status, 'incomplete');
  assert.equal(sealed.incompleteReason, 'app-shutdown');
  const bundle = loadBundle(dir);
  assert.equal(bundle.manifest.status, 'incomplete');
  // A terminal event that happened to be recorded stays recorded; the bundle
  // is still sealed as interrupted rather than rebranded complete.
  assert.equal(bundle.manifest.outcome, 'success');
});

test('a crashed recording (status recording) loads as interrupted evidence', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.record({ type: 'text', text: '崩溃前' }, META);
  recorder.record({ type: 'tool', id: 't1', name: 'x', arguments: '{}' }, META);
  // Simulate a crash: nothing is sealed, the last append is torn.
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.appendFileSync(eventsPath, '{"seq":3,"at":"2026-10-11T00:00:00.000Z"');

  const bundle = loadBundle(dir);
  assert.equal(bundle.manifest.status, 'incomplete');
  assert.equal(bundle.manifest.incompleteReason, 'app-shutdown');
  assert.equal(bundle.manifest.interruptedUnmarked, true);
  assert.equal(bundle.events.length, 2);
  assert.ok(bundle.warnings.some(warning => warning.includes('events:truncated')));
  assert.ok(bundle.warnings.some(warning => warning.includes('count-mismatch')));
});

test('recorder faults seal incomplete and never throw into the live task', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  // Break the output so the next append fails: replace events.jsonl with a
  // directory of the same name.
  fs.rmSync(path.join(dir, 'events.jsonl'));
  fs.mkdirSync(path.join(dir, 'events.jsonl'));
  assert.equal(recorder.record({ type: 'text', text: 'boom' }, META), false);
  assert.equal(recorder.stats().phase, 'sealed');
  assert.equal(recorder.stats().sealedAs.incompleteReason, 'recorder-error');
  // The live-task contract: record() must not throw even when already sealed
  // or when the disk is full.
  assert.doesNotThrow(() => recorder.record({ type: 'done', result: { status: 'success' } }, META));
});

test('caps stop the recording instead of corrupting it', () => {
  const dir = tempDir();
  const recorder = createRecorder({
    directory: dir,
    chatId: 'chat-1',
    limits: { maxEvents: 2 },
  });
  recorder.start();
  recorder.record({ type: 'text', text: '一' }, META);
  recorder.record({ type: 'text', text: '二' }, META);
  assert.equal(recorder.record({ type: 'text', text: '三' }, META), false);
  assert.equal(recorder.stats().sealedAs.incompleteReason, 'cap-exceeded');
  const bundle = loadBundle(dir);
  assert.equal(bundle.manifest.status, 'incomplete');
  assert.equal(bundle.events.length, 2);
});

test('oversize single events are skipped visibly, not truncated', () => {
  const dir = tempDir();
  const recorder = createRecorder({
    directory: dir,
    chatId: 'chat-1',
    limits: { maxEventBytes: 256 },
  });
  recorder.start();
  recorder.record({ type: 'text', text: '小事件' }, META);
  recorder.record({ type: 'text', text: 'x'.repeat(4096) }, META);
  recorder.record({ type: 'done', result: { status: 'success' } }, META);
  recorder.stop();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8'));
  assert.equal(manifest.skippedOversize, 1);
  assert.equal(loadBundle(dir).events.length, 2);
});

test('assets are hashed, indexed, and survive a directory copy', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.record({ type: 'text', text: '看这个布局' }, META);
  recorder.noteAsset({
    id: 'layout-gds',
    type: 'artifact-snapshot',
    bytes: Buffer.from('GDSII fake bytes'),
    filename: 'layout.bin',
    mediaType: 'application/octet-stream',
    source: { artifactId: 'art-1', actionId: 'act-1', originalPath: '/private/var/layout.gds' },
  });
  recorder.record({ type: 'done', result: { status: 'success' } }, META);
  recorder.stop();

  // Portability: copy to another directory, no original project anywhere.
  const copy = tempDir();
  fs.cpSync(dir, path.join(copy, 'bundle'), { recursive: true });
  const bundle = loadBundle(path.join(copy, 'bundle'));
  assert.equal(bundle.manifest.assets.length, 1);
  assert.equal(bundle.manifest.assets[0].status, 'present');
  assert.equal(bundle.missingAssets.length, 0);
});

test('failed asset capture degrades to a missing-asset entry', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  const ok = recorder.noteAsset({
    id: 'good',
    type: 'image',
    bytes: Buffer.from('png'),
    filename: 'a.png',
  });
  assert.equal(ok, true);
  // A filename that collides with a directory breaks the write; the recorder
  // records a missing entry instead of aborting.
  fs.mkdirSync(path.join(dir, 'assets', 'b.png'));
  const degraded = recorder.noteAsset({
    id: 'bad',
    type: 'image',
    bytes: Buffer.from('png'),
    filename: 'b.png',
  });
  assert.equal(degraded, false);
  recorder.record({ type: 'done', result: { status: 'success' } }, META);
  recorder.stop();
  const bundle = loadBundle(dir);
  assert.deepEqual(bundle.missingAssets, ['bad']);
});

test('initial turns before recording start are summarized, not fabricated', () => {
  const dir = tempDir();
  const recorder = createRecorder({
    directory: dir,
    chatId: 'chat-1',
    initialTurns: [
      { turnId: 'turn-0', startedAt: '2026-10-10T08:00:00.000Z', summary: '早期布图讨论' },
    ],
  });
  recorder.start();
  recorder.record({ type: 'done', result: { status: 'success' } }, META);
  recorder.stop();
  const bundle = loadBundle(dir);
  assert.equal(bundle.manifest.chat.initialSnapshot.included, true);
  assert.equal(bundle.manifest.chat.initialSnapshot.turns.length, 1);
  assert.equal(bundle.manifest.chat.initialSnapshot.turns[0].turnId, 'turn-0');
});
