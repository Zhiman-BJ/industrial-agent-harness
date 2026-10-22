'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadReplayInput, readReplayImage } = require('../src/index.cjs');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aDQAAAABJRU5ErkJggg==',
  'base64',
);

function stagedBundle(t, bytes = PNG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-replay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, '../fixtures/success-demo'), dir, { recursive: true });
  const file = path.join(dir, 'assets/stage.png');
  fs.writeFileSync(file, bytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'recording.json')));
  manifest.assets.push({
    id: 'stage-image',
    type: 'image',
    relativePath: 'assets/stage.png',
    status: 'present',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
  manifest.source.kind = 'constructed-demo';
  manifest.demo = {
    constructed: true,
    note: 'Staged geometry demonstration; no engineering verification.',
  };
  manifest.replayStages = [
    {
      id: 'board',
      title: 'Board body',
      description: 'Fixed camera snapshot',
      atSeq: 2,
      assetId: 'stage-image',
    },
  ];
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(manifest));
  return { dir, file, manifest };
}

test('declared PNG snapshots are passive, bounded and hash-bound', async t => {
  const { dir, file } = stagedBundle(t);
  const before = fs.readFileSync(file);
  const bundle = await loadReplayInput(dir);
  const image = readReplayImage(bundle, 'stage-image');
  assert.equal(image.mime, 'image/png');
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.equal(image.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => readReplayImage(bundle, '../../outside'), { code: 'replay-asset:unknown' });
  const altered = Buffer.from(PNG);
  altered[25] ^= 1;
  fs.writeFileSync(file, altered);
  assert.throws(() => readReplayImage(bundle, 'stage-image'), { code: 'replay-asset:hash' });
});
test('snapshot links, executable formats and unbounded image dimensions fail', async t => {
  const { dir, file } = stagedBundle(t);
  const bundle = await loadReplayInput(dir);
  fs.unlinkSync(file);
  fs.symlinkSync('/etc/hosts', file);
  assert.throws(() => readReplayImage(bundle, 'stage-image'), { code: 'replay-asset:link' });
  const svg = Buffer.from('<svg onload="do_not_execute()">' + '.'.repeat(100) + '</svg>');
  const unsupported = await loadReplayInput(stagedBundle(t, svg).dir);
  assert.throws(() => readReplayImage(unsupported, 'stage-image'), { code: 'replay-asset:format' });
  const huge = Buffer.from(PNG);
  huge.writeUInt32BE(100000, 16);
  const oversized = await loadReplayInput(stagedBundle(t, huge).dir);
  assert.throws(() => readReplayImage(oversized, 'stage-image'), {
    code: 'replay-asset:dimensions',
  });
});
test('stages must be ordered source positions and declared present images', async t => {
  for (const stages of [
    [null],
    [{ id: 'invalid', atSeq: 999999, title: 'bad', assetId: 'stage-image' }],
    [{ id: 'invalid', atSeq: 2, title: 'bad', assetId: 'absent' }],
  ]) {
    const { dir, manifest } = stagedBundle(t);
    manifest.replayStages = stages;
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(manifest));
    await assert.rejects(loadReplayInput(dir), { code: 'replay-asset:stage' });
  }
});
