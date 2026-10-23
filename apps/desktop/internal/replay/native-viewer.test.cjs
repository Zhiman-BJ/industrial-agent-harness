'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRecordedViewerHost } = require('./native-viewer.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const model = '#VRML V2.0 utf8\nShape { geometry Box { size 1 1 1 } }\n';
const board = x => `(kicad_pcb (version 20240108) (generator recorded)
  (footprint "Recorded" (at ${x} 2) (model "\${KIPRJMOD}/models/part.wrl")))`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-native-viewer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = {
    sourceDirectory: directory,
    manifest: {
      chat: { displayName: 'Recorded project' },
      assets: [],
      replayStages: [],
    },
  };
  for (const [index, id] of ['initial', 'edited'].entries()) {
    const prefix = `assets/source/snapshots/${id}/`;
    fs.mkdirSync(path.join(directory, prefix, 'models'), { recursive: true });
    for (const [name, content] of [
      ['board.kicad_pcb', board(index + 1)],
      ['models/part.wrl', model],
    ]) {
      const asset = {
        id: `${id}-${path.basename(name)}`,
        relativePath: prefix + name,
        status: 'present',
        type: 'artifact-snapshot',
        bytes: Buffer.byteLength(content),
        sha256: hash(content),
      };
      fs.writeFileSync(path.join(directory, asset.relativePath), content);
      bundle.manifest.assets.push(asset);
    }
    bundle.manifest.replayStages.push({
      id,
      title: id,
      provenance: { snapshotId: id, sourceBoardSha256: hash(board(index + 1)) },
    });
  }
  const host = createRecordedViewerHost(bundle, { projectId: 'project-recorded' });
  t.after(() => host.close());
  return { bundle, host, directory };
}

test('recorded native sources open through the real Registry and KiCad runtime unchanged', async t => {
  const { host } = fixture(t);
  assert.deepEqual(host.listFiles(), []);
  assert.throws(() => host.openProjectFile('board.kicad_pcb'), /No recorded/);
  const active = host.activateStage('initial');
  assert.deepEqual(host.protocolHosts, ['kicad']);
  assert.equal(Object.isFrozen(host.protocolHosts), true);
  assert.equal(active.changed, true);
  assert.deepEqual(active.viewerKinds, ['kicad']);
  assert.deepEqual(
    host.listFiles().map(entry => entry.path),
    ['board.kicad_pcb', 'models', 'models/part.wrl'],
  );
  assert.equal(host.readFile('board.kicad_pcb').viewer, 'kicad');
  assert.equal(host.readFile('board.kicad_pcb').content, null);
  assert.equal(host.readFile('models/part.wrl').content, model);
  const artifact = host.openProjectFile('board.kicad_pcb');
  const opened = await host.openArtifact({ artifactId: artifact.id });
  assert.equal(opened.kind, 'kicad');
  assert.equal(opened.artifact.sha256, hash(board(1)));
  assert.match(opened.data.url, /^app:\/\/kicad\//);
  const resource = name =>
    host.handleProtocol(new Request(opened.data.url.replace('index.html', name)));
  const manifest = await (await resource('manifest.json')).json();
  assert.equal(manifest.boardSha256, artifact.sha256);
  assert.equal(manifest.models[0].status, 'ready');
  assert.equal(manifest.models[0].sha256, hash(model));
  assert.equal(await (await resource('source/0')).text(), board(1));
  assert.equal(await (await resource('models/0')).text(), model);
  const html = await resource('index.html');
  assert.match(html.headers.get('Content-Security-Policy'), /frame-ancestors app:\/\/viewer/);
  assert.match(html.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  host.release({ token: opened.data.token });
  assert.equal((await resource('source/0')).status, 404);
});

test('a zero-component board opens with zero model resources before native component growth', async t => {
  const { bundle, directory } = fixture(t);
  const content = `(kicad_pcb (version 20240108) (generator recorded)
    (general (thickness 1.6))
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
    (gr_rect (start 0 0) (end 100 75) (stroke (width 0.1) (type default))
      (fill none) (layer "Edge.Cuts")))`;
  const relativePath = 'assets/source/snapshots/empty/board.kicad_pcb';
  fs.mkdirSync(path.dirname(path.join(directory, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(directory, relativePath), content);
  bundle.manifest.assets.push({
    id: 'empty-board',
    relativePath,
    type: 'artifact-snapshot',
    status: 'present',
    bytes: Buffer.byteLength(content),
    sha256: hash(content),
  });
  bundle.manifest.replayStages.push({
    id: 'empty',
    title: 'Empty board',
    provenance: { snapshotId: 'empty', sourceBoardSha256: hash(content) },
  });
  const host = createRecordedViewerHost(bundle);
  t.after(() => host.close());
  host.activateStage('empty');
  const first = await host.openArtifact({ artifactId: host.openProjectFile('board.kicad_pcb').id });
  const manifest = await (
    await host.handleProtocol(new Request(first.data.url.replace('index.html', 'manifest.json')))
  ).json();
  assert.equal(manifest.boardSha256, hash(content));
  assert.deepEqual(manifest.models, []);
  assert.equal((await host.handleProtocol(new Request(first.data.url))).status, 200);
  host.activateStage('initial');
  assert.equal((await host.handleProtocol(new Request(first.data.url))).status, 404);
  const next = await host.openArtifact({ artifactId: host.openProjectFile('board.kicad_pcb').id });
  const grown = await (
    await host.handleProtocol(new Request(next.data.url.replace('index.html', 'manifest.json')))
  ).json();
  assert.equal(grown.models.length, 1);
  assert.equal(grown.models[0].status, 'ready');
});

test('historical stage changes and reset invalidate old artifacts and native sessions', async t => {
  const { host } = fixture(t);
  host.activateStage('initial');
  const first = host.openProjectFile('board.kicad_pcb');
  const view = await host.openArtifact({ artifactId: first.id });
  assert.equal(host.activateStage('initial').changed, false);
  host.activateStage('edited');
  assert.equal((await host.handleProtocol(new Request(view.data.url))).status, 404);
  await assert.rejects(host.openArtifact({ artifactId: first.id }), /no longer active/);
  const second = host.openProjectFile('board.kicad_pcb');
  assert.equal(second.sha256, hash(board(2)));
  await host.openArtifact({ artifactId: second.id });
  host.activateStage(null);
  assert.equal(host.snapshot().stageId, null);
  assert.deepEqual(host.listFiles(), []);
  await assert.rejects(host.openArtifact({ artifactId: second.id }), /no longer active/);
});

test('a stage change while a native open is pending cannot return a stale Viewer', async t => {
  const { host } = fixture(t);
  host.activateStage('initial');
  const artifact = host.openProjectFile('board.kicad_pcb');
  const opening = host.openArtifact({ artifactId: artifact.id });
  host.activateStage('edited');
  await assert.rejects(opening, /changed|no longer active/);
});

test('every source and model is bound to recorded bytes rather than a fresh runtime hash', async t => {
  const { bundle, host, directory } = fixture(t);
  const asset = bundle.manifest.assets.find(asset =>
    asset.relativePath.endsWith('initial/models/part.wrl'),
  );
  const file = path.join(directory, asset.relativePath);
  fs.writeFileSync(file, model.replace('1 1 1', '2 2 2'));
  assert.throws(() => host.activateStage('initial'), /hash changed/);
  fs.writeFileSync(file, model);
  host.activateStage('initial');
  const artifact = host.openProjectFile('board.kicad_pcb');
  const view = await host.openArtifact({ artifactId: artifact.id });
  fs.writeFileSync(file, model.replace('1 1 1', '2 2 2'));
  const response = await host.handleProtocol(
    new Request(view.data.url.replace('index.html', 'models/0')),
  );
  assert.equal(response.status, 409);
});

test('undeclared local models are not accepted even when the production runtime can read them', async t => {
  const { bundle } = fixture(t);
  bundle.manifest.assets = bundle.manifest.assets.filter(
    asset => !asset.relativePath.endsWith('initial/models/part.wrl'),
  );
  const host = createRecordedViewerHost(bundle);
  t.after(() => host.close());
  host.activateStage('initial');
  const artifact = host.openProjectFile('board.kicad_pcb');
  await assert.rejects(host.openArtifact({ artifactId: artifact.id }), /recorded snapshot hash/);
});

test('paths, symlinks, source identity and file limits fail closed', t => {
  const { bundle, host, directory } = fixture(t);
  assert.throws(() => host.activateStage('absent'), /No native snapshot/);
  host.activateStage('initial');
  for (const relative of [
    '../board.kicad_pcb',
    '/etc/hosts',
    'models\\part.wrl',
    'absent.kicad_pcb',
  ])
    assert.throws(() => host.readFile(relative), /declared|outside/);
  const modelPath = path.join(directory, 'assets/source/snapshots/edited/models/part.wrl');
  fs.unlinkSync(modelPath);
  fs.symlinkSync('/etc/hosts', modelPath);
  assert.throws(() => host.activateStage('edited'), /links are forbidden/);
  const changed = structuredClone(bundle);
  changed.manifest.replayStages[0].provenance.sourceBoardSha256 = '0'.repeat(64);
  assert.throws(() => createRecordedViewerHost(changed), /recorded source hash/);
  const oversized = structuredClone(bundle);
  oversized.manifest.assets[0].bytes = 17 * 1024 * 1024;
  assert.throws(() => createRecordedViewerHost(oversized), /bounded/);
});
