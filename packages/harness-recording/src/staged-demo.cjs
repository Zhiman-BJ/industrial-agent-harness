'use strict';

// Author explicitly constructed demonstrations from already rendered snapshots.
// These events describe presentation, never a model/tool execution or acceptance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createManifest, uuidLike } = require('./manifest.cjs');
const { validateBundle } = require('./validate.cjs');
const { MAX_IMAGE_BYTES, readReplayImage, validateReplayStages } = require('./replay-assets.cjs');

function createStagedDemo({
  directory,
  stages,
  title,
  prompt = '请逐步展示这块复杂开发板从板体到完整 3D 装配的形成过程。',
  recordingId = 'constructed-staged-demo',
  stageDurationMs = 5000,
  startedAt = '2026-10-22T00:00:00.000Z',
}) {
  if (
    !Array.isArray(stages) ||
    stages.length < 1 ||
    stages.length > 100 ||
    !Number.isFinite(stageDurationMs) ||
    stageDurationMs < 100 ||
    !uuidLike(recordingId)
  )
    throw Error('Invalid constructed demonstration configuration');
  if (fs.existsSync(directory)) throw Error('Constructed demonstration destination must be new');
  const images = stages.map(stage => {
    if (
      !uuidLike(stage.id) ||
      typeof stage.title !== 'string' ||
      typeof stage.imagePath !== 'string'
    )
      throw Error('Each stage requires an id, title and snapshot path');
    const stat = fs.statSync(stage.imagePath);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
      throw Error('Stage snapshot exceeds image bounds');
    return { stage, bytes: fs.readFileSync(stage.imagePath) };
  });
  if (new Set(stages.map(stage => stage.id)).size !== stages.length)
    throw Error('Stage identifiers must be unique');
  const manifest = createManifest({
    recordingId,
    chatId: recordingId,
    displayName: title || 'Constructed staged demonstration',
    startedAt,
  });
  manifest.source = {
    kind: 'constructed-demo',
    capturedVia: 'authored-stages-and-rendered-snapshots',
  };
  manifest.demo = {
    constructed: true,
    title: title || 'Constructed staged demonstration',
    note: '构造演示：预先编排的几何阶段及真实渲染快照；不代表实时设计执行、电气正确性或工程验收。',
  };
  manifest.replayStages = [];
  const events = [];
  function push(event, relMs, source) {
    const seq = events.length + 1;
    const turnId = event.replayTurnId || 'constructed-demo';
    events.push({
      seq,
      at: new Date(Date.parse(startedAt) + relMs).toISOString(),
      relMs,
      origin: { chatId: recordingId, projectId: null, turnId },
      event: { replayRole: 'assistant', ...event, replayAgentId: 'main', replayTurnId: turnId },
      ...(source ? { source } : {}),
    });
    return seq;
  }
  push({ type: 'text', text: prompt, replayRole: 'user' }, 0);
  const prepared = images.map(({ stage, bytes }, index) => {
    const assetId = `snapshot-${stage.id}`;
    const asset = {
      id: assetId,
      type: 'image',
      status: 'present',
      relativePath: `assets/${stage.id}.png`,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    const relMs = index * stageDurationMs;
    const atSeq = push(
      { type: 'text', text: `### ${stage.title}\n\n${stage.description || ''}\n\n` },
      relMs,
      {
        eventId: `constructed-${stage.id}`,
        sourceFile: 'stages.json',
        sourceLine: index + 1,
        timestampMs: Date.parse(startedAt) + relMs,
        type: 'constructed-stage',
        raw: {
          id: stage.id,
          title: stage.title,
          description: stage.description || '',
          kind: 'constructed-demo',
          snapshotSha256: asset.sha256,
        },
      },
    );
    manifest.assets.push(asset);
    manifest.replayStages.push({
      id: stage.id,
      title: stage.title,
      description: stage.description || '',
      atSeq,
      assetId,
      ...(Number.isInteger(stage.componentCount) ? { componentCount: stage.componentCount } : {}),
    });
    push(
      { type: 'status', message: `构造演示快照 ${index + 1}/${stages.length}` },
      relMs + stageDurationMs - 100,
    );
    return { asset, bytes };
  });
  push(
    {
      type: 'done',
      result: {
        status: 'success',
        summary: 'Constructed presentation finished; no engineering verification performed.',
      },
    },
    stages.length * stageDurationMs,
  );
  manifest.status = 'complete';
  manifest.outcome = 'success';
  manifest.events = {
    file: 'events.jsonl',
    count: events.length,
    firstSeq: 1,
    lastSeq: events.length,
  };
  if (validateReplayStages(manifest).length) throw Error('Invalid constructed stages');
  fs.mkdirSync(directory);
  try {
    fs.mkdirSync(path.join(directory, 'assets'));
    for (const { asset, bytes } of prepared)
      fs.writeFileSync(path.join(directory, asset.relativePath), bytes);
    fs.writeFileSync(
      path.join(directory, 'events.jsonl'),
      events.map(JSON.stringify).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(directory, 'recording.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    const errors = validateBundle(directory);
    if (errors.length) throw Error(JSON.stringify(errors));
    const bundle = { manifest, events, sourceDirectory: directory };
    for (const { asset } of prepared) readReplayImage(bundle, asset.id);
    return bundle;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createStagedDemo };
