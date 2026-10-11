'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { validateManifest, validateEventStream, validateBundle } = require('../src/validate.cjs');
const { createRecorder } = require('../src/recorder.cjs');
const { loadBundle, RecordingError } = require('../src/loader.cjs');
const { createManifest } = require('../src/manifest.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recording-'));
}

function validManifest() {
  return createManifest({
    recordingId: 'rec-test',
    chatId: 'chat-1',
    projectId: 'proj-1',
    startedAt: '2026-10-11T00:00:00.000Z',
  });
}

test('a healthy manifest passes', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
});

test('unknown schema versions are rejected explicitly', () => {
  const manifest = { ...validManifest(), schemaVersion: 2 };
  const errors = validateManifest(manifest);
  assert.equal(errors[0].code, 'manifest:schema-version');
  assert.match(errors[0].detail, /supports 1 only/);
});

test('incomplete status requires a known reason', () => {
  const manifest = { ...validManifest(), status: 'incomplete', incompleteReason: '因为' };
  assert.equal(validateManifest(manifest)[0].code, 'manifest:incomplete-reason');
});

test('asset paths must stay inside the bundle', () => {
  for (const evil of [
    '../escape.bin',
    '/abs/path.bin',
    'a/../../b',
    'c:\\win',
    'C:/abs',
    'assets\\evil.png',
  ]) {
    const manifest = validManifest();
    manifest.assets = [
      {
        id: 'a1',
        type: 'image',
        relativePath: evil,
        mediaType: 'image/png',
        bytes: 3,
        sha256: 'a'.repeat(64),
        status: 'present',
      },
    ];
    assert.equal(validateManifest(manifest)[0].code, 'asset:path');
  }
});

test('a reviewed demo bundle must have applied redaction', () => {
  const manifest = validManifest();
  manifest.redaction = {
    applied: false,
    mode: 'original',
    rulesVersion: null,
    reviewed: 'approved',
    reviewNote: null,
  };
  assert.equal(validateManifest(manifest)[0].code, 'manifest:redaction');
});

test('event stream rejects duplicate, gapped, and regressed sequences', () => {
  const line = (seq, relMs) =>
    JSON.stringify({
      seq,
      at: '2026-10-11T00:00:00.000Z',
      relMs,
      origin: { chatId: 'c', projectId: null, turnId: 't', eventRevision: 1 },
      event: { type: 'text', text: 'x' },
    });
  const cases = [
    [line(1, 0), line(1, 1)], // duplicate seq
    [line(1, 0), line(3, 1)], // gap
    [line(1, 5), line(2, 1)], // time regression
  ];
  for (const stream of cases) {
    const text = stream.join('\n') + '\n';
    const { errors } = validateEventStream(text);
    assert.ok(errors.length > 0, `expected rejection for ${text}`);
  }
});

test('unknown event types are rejected by name', () => {
  const text =
    JSON.stringify({
      seq: 1,
      at: '2026-10-11T00:00:00.000Z',
      relMs: 0,
      origin: { chatId: 'c', projectId: null, turnId: 't', eventRevision: 1 },
      event: { type: 'brand-new-event' },
    }) + '\n';
  const { errors } = validateEventStream(text);
  assert.equal(errors[0].code, 'events:unknown-type');
  assert.match(errors[0].detail, /brand-new-event/);
});

test('a truncated stream without a trailing newline is flagged', () => {
  const text = JSON.stringify({
    seq: 1,
    at: '2026-10-11T00:00:00.000Z',
    relMs: 0,
    origin: { chatId: 'c', projectId: null, turnId: 't', eventRevision: 1 },
    event: { type: 'text', text: 'x' },
  });
  const { errors } = validateEventStream(text);
  assert.ok(errors.some(error => error.code === 'events:truncated'));
});

test('complete bundles require a terminal event', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.record(
    { type: 'text', text: '没有终点' },
    { chatId: 'chat-1', projectId: null, turnId: 't', eventRevision: 1 },
  );
  recorder.stop(); // seals incomplete: stopped-before-completion
  const sealed = JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8'));
  assert.equal(sealed.status, 'incomplete');

  // Forged completeness must be caught by the bundle validator.
  const forged = { ...sealed, status: 'complete' };
  delete forged.incompleteReason;
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(forged, null, 2));
  const errors = validateBundle(dir);
  assert.ok(errors.some(error => error.code === 'bundle:complete-without-terminal'));
  assert.throws(() => loadBundle(dir), RecordingError);
});

test('asset hash and size mismatches are detected', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.noteAsset({
    id: 'a1',
    type: 'image',
    bytes: Buffer.from('original'),
    filename: 'a.png',
  });
  recorder.record(
    { type: 'done', result: { status: 'success' } },
    { chatId: 'chat-1', projectId: null, turnId: 't', eventRevision: 1 },
  );
  recorder.stop();
  fs.writeFileSync(path.join(dir, 'assets', 'a.png'), 'tampered');
  const errors = validateBundle(dir);
  assert.ok(errors.some(error => error.code === 'asset:size' || error.code === 'asset:hash'));
});

test('missing bundle pieces produce deterministic load errors', () => {
  const dir = tempDir();
  assert.throws(
    () => loadBundle(dir),
    error => error.code === 'bundle:unreadable-manifest',
  );
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(validManifest()));
  assert.throws(
    () => loadBundle(dir),
    error => error.code === 'bundle:unreadable-events',
  );
});

test('validator and loader agree on a recorded success bundle', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.record(
    { type: 'text', text: 'ok' },
    { chatId: 'chat-1', projectId: null, turnId: 't', eventRevision: 1 },
  );
  recorder.record(
    { type: 'done', result: { status: 'success' } },
    { chatId: 'chat-1', projectId: null, turnId: 't', eventRevision: 2 },
  );
  recorder.stop();
  assert.deepEqual(validateBundle(dir), []);
  const bundle = loadBundle(dir);
  assert.equal(bundle.manifest.status, 'complete');
  assert.equal(bundle.manifest.outcome, 'success');
});

test('a real in-bundle symlink is caught, but a symlinked bundle root is fine', () => {
  const dir = tempDir();
  const recorder = createRecorder({ directory: dir, chatId: 'chat-1' });
  recorder.start();
  recorder.noteAsset({ id: 'a1', type: 'image', bytes: Buffer.from('png'), filename: 'a.png' });
  recorder.record(
    { type: 'done', result: { status: 'success' } },
    { chatId: 'chat-1', projectId: null, turnId: 't', eventRevision: 1 },
  );
  recorder.stop();

  // os.tmpdir() on macOS is behind /var -> /private/var; a bundle living
  // there must still validate cleanly (regression guard for the lstat fix).
  assert.ok(validateBundle(dir).every(error => error.code !== 'asset:symlink'));

  // Replacing the asset with a symlink pointing outside the bundle must fail.
  const outside = path.join(tempDir(), 'outside.bin');
  fs.writeFileSync(outside, 'escape payload');
  fs.rmSync(path.join(dir, 'assets', 'a.png'));
  fs.symlinkSync(outside, path.join(dir, 'assets', 'a.png'));
  const errors = validateBundle(dir);
  assert.ok(errors.some(error => error.code === 'asset:symlink'));
});
