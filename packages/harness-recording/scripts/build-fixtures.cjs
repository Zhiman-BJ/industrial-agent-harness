'use strict';

// Builds the synthetic fixture bundles under fixtures/ (#104 acceptance:
// minimal success plus damaged/interrupted samples usable directly by replay
// development and tests). Run from the package root:
//   node scripts/build-fixtures.cjs
// Output is deterministic (fixed ids and clocks) so diffs stay reviewable.

const fs = require('node:fs');
const path = require('node:path');

const { createRecorder } = require('../src/recorder.cjs');

const ROOT = path.join(__dirname, '..', 'fixtures');

// Fixed clock: each call advances 250ms so relMs grows deterministically.
function fixedClock(startMs = Date.parse('2026-10-11T09:00:00.000Z')) {
  let tick = 0;
  return () => new Date(startMs + tick++ * 250).toISOString();
}

const META = { chatId: 'chat-demo', projectId: 'proj-demo', turnId: 'turn-1', eventRevision: 1 };

function buildBundle(name, build) {
  const directory = path.join(ROOT, name);
  fs.rmSync(directory, { recursive: true, force: true });
  const recorder = createRecorder({
    directory,
    chatId: 'chat-demo',
    projectId: 'proj-demo',
    displayName: '演示：布局检查',
    recordingId: `rec-${name}`,
    now: fixedClock(),
  });
  recorder.start();
  build(recorder);
  console.log(`built ${name}`);
}

function demoConversation(recorder, { toolError = false, cancelled = false } = {}) {
  recorder.record(
    { type: 'text', text: '检查这版 Sobel 布局的连线。' },
    { ...META, eventRevision: 1 },
  );
  recorder.record(
    {
      type: 'todo',
      items: [
        { title: '读取布局', status: 'in_progress' },
        { title: '核对电源网络', status: 'pending' },
      ],
    },
    { ...META, eventRevision: 2 },
  );
  recorder.record(
    { type: 'tool', id: 't1', name: 'inspect_layout', arguments: '{"file":"sobel_layout.gds"}' },
    { ...META, eventRevision: 3 },
  );
  recorder.record(
    {
      type: 'tool-result',
      id: 't1',
      error: toolError,
      message: toolError ? '布局文件解析失败' : '',
      output: toolError ? 'ValueError: unmatched layer' : '3 layers, 214 instances, 0 opens',
      outputBytes: toolError ? 27 : 35,
    },
    { ...META, eventRevision: 4 },
  );
  if (cancelled) {
    recorder.record({ type: 'text', text: '先停在这里。' }, { ...META, eventRevision: 5 });
    recorder.record(
      { type: 'done', result: { status: 'cancelled' } },
      { ...META, eventRevision: 6 },
    );
    return;
  }
  recorder.record(
    { type: 'text', text: toolError ? '工具失败，汇报问题。' : '电源网络全部连通。' },
    { ...META, eventRevision: 5 },
  );
  recorder.record(
    { type: 'done', result: { status: toolError ? 'success' : 'success' } },
    { ...META, eventRevision: 6 },
  );
}

buildBundle('success-demo', recorder => {
  demoConversation(recorder);
  recorder.noteAsset({
    id: 'layout-snapshot',
    type: 'artifact-snapshot',
    bytes: Buffer.from('GDSII-demo-bytes-for-replay-development'),
    filename: 'sobel-layout.snapshot.bin',
    mediaType: 'application/octet-stream',
    source: {
      artifactId: 'art-demo-1',
      actionId: 'act-demo-1',
      originalPath: 'outputs/sobel_layout.gds',
    },
  });
  recorder.stop();
});

buildBundle('tool-failure-demo', recorder => {
  demoConversation(recorder, { toolError: true });
  recorder.stop();
});

buildBundle('cancelled-demo', recorder => {
  demoConversation(recorder, { cancelled: true });
  recorder.stop();
});

// Interrupted: never sealed, torn final line — the crash signature a loader
// must present as explicit incomplete evidence instead of failing silently.
buildBundle('interrupted-demo', recorder => {
  recorder.record(
    { type: 'text', text: '长任务进行中，进程被中断。' },
    { ...META, eventRevision: 1 },
  );
  recorder.record(
    { type: 'tool', id: 't1', name: 'long_run', arguments: '{}' },
    { ...META, eventRevision: 2 },
  );
  const eventsPath = path.join(ROOT, 'interrupted-demo', 'events.jsonl');
  fs.appendFileSync(eventsPath, '{"seq":3,"at":"2026-10-11T09:00:00.750Z');
});

// Damaged samples for validator/loader tests: each is a valid recorder
// output that is then corrupted in exactly one deterministic way.
function damage(name, mutate) {
  const directory = path.join(ROOT, name);
  fs.rmSync(directory, { recursive: true, force: true });
  const recorder = createRecorder({
    directory,
    chatId: 'chat-demo',
    projectId: 'proj-demo',
    recordingId: `rec-${name}`,
    now: fixedClock(Date.parse('2026-10-11T10:00:00.000Z')),
  });
  recorder.start();
  recorder.record({ type: 'text', text: '将被损坏的样例。' }, { ...META, eventRevision: 1 });
  recorder.record({ type: 'done', result: { status: 'success' } }, { ...META, eventRevision: 2 });
  recorder.stop();
  mutate(directory);
  console.log(`built ${name}`);
}

damage('corrupted-seq', directory => {
  const eventsPath = path.join(directory, 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  lines[1] = lines[1].replace('"seq":2', '"seq":1');
  const manifestPath = path.join(directory, 'recording.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.events.count = 2;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n');
});

damage('unknown-event', directory => {
  const eventsPath = path.join(directory, 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const record = JSON.parse(lines[0]);
  record.event = { type: 'not-a-real-event-type' };
  lines[0] = JSON.stringify(record);
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n');
});

damage('missing-asset', directory => {
  const manifestPath = path.join(directory, 'recording.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.assets = [
    {
      id: 'lost-image',
      type: 'image',
      relativePath: 'assets/lost.png',
      mediaType: 'image/png',
      bytes: 0,
      sha256: '0'.repeat(64),
      status: 'missing',
      source: null,
    },
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
});

console.log('fixtures rebuilt');
