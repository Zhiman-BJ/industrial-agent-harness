'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStagedDemo, loadReplayInput, readReplayImage } = require('../src/index.cjs');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aDQAAAABJRU5ErkJggg==',
  'base64',
);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-staged-demo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'source.png');
  fs.writeFileSync(imagePath, PNG);
  return { root, imagePath, directory: path.join(root, 'demo') };
}
test('constructed stages retain immutable snapshots and never fabricate tool execution', async t => {
  const { directory, imagePath } = setup(t);
  createStagedDemo({
    directory,
    title: 'Complex development board',
    stages: [
      { id: 'board', title: 'Board', imagePath, description: 'Constructed board geometry' },
      {
        id: 'assembly',
        title: 'Assembly',
        imagePath,
        description: 'Constructed component geometry',
        componentCount: 12,
      },
    ],
  });
  const bundle = await loadReplayInput(directory);
  assert.equal(bundle.manifest.demo.constructed, true);
  assert.equal(bundle.manifest.source.kind, 'constructed-demo');
  assert.equal(
    bundle.events.some(
      record => record.event.type === 'tool' || record.event.type === 'industrial-result',
    ),
    false,
  );
  assert.equal(bundle.events[0].event.replayRole, 'user');
  assert.equal(bundle.manifest.replayStages.length, 2);
  assert.equal(bundle.manifest.replayStages[1].componentCount, 12);
  assert.match(bundle.events.at(-1).event.result.summary, /no engineering verification/);
  const png = readReplayImage(bundle, 'snapshot-assembly');
  assert.equal(png.width, 1);
  assert.equal(png.mime, 'image/png');
  assert.deepEqual(fs.readFileSync(imagePath), PNG);
  assert.throws(() => createStagedDemo({ directory, stages: [] }), /Invalid/);
  assert.throws(
    () => createStagedDemo({ directory, stages: [{ id: 'board', title: 'Board', imagePath }] }),
    /must be new/,
  );
  assert.equal(fs.existsSync(path.join(directory, 'recording.json')), true);
});
test('an invalid image removes only the newly-created incomplete output', t => {
  const { directory, imagePath } = setup(t);
  fs.writeFileSync(imagePath, 'not a PNG');
  assert.throws(
    () => createStagedDemo({ directory, stages: [{ id: 'board', title: 'Board', imagePath }] }),
    /size|PNG/,
  );
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readFileSync(imagePath, 'utf8'), 'not a PNG');
});
