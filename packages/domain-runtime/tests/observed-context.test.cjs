const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ObservedContextStore} = require('../src/index.cjs');

test('observed file facts and checkpoints survive restart and detect changed content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-context-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const projectDir = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(projectDir);
  const file = path.join(projectDir, 'wave.vcd');
  fs.writeFileSync(file, 'first');
  let store = new ObservedContextStore(projectDir, 'chip', {directory: stateDir});
  const artifact = await store.observeArtifact({id: 'wave-1', kind: 'waveform', file});
  assert.equal(artifact.verificationStatus, 'not_run');
  const initial = await store.checkpoint();
  assert.equal((await store.checkpoint()).id, initial.id);
  assert.equal(store.readPage(initial.id).artifacts[0].sha256, artifact.sha256);
  assert.equal((await store.readArtifact('wave-1')).relativePath, 'wave.vcd');
  store.close();

  store = new ObservedContextStore(projectDir, 'chip', {directory: stateDir});
  assert.equal((await store.anchor()).checkpointId, initial.id);
  fs.writeFileSync(file, 'second');
  await assert.rejects(store.readArtifact('wave-1'), /changed/);
  const changed = await store.checkpoint();
  assert.equal(changed.parentId, initial.id);
  assert.deepEqual(changed.state.artifacts, []);
  assert.deepEqual(changed.state.staleArtifactIds, ['wave-1']);
  assert.equal(store.readPage(initial.id).artifacts[0].sha256, artifact.sha256);
  store.close();
});

test('observed artifacts reject project escape and changing domain gets separate state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-context-boundary-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const outside = path.join(root, 'outside.vcd');
  fs.writeFileSync(outside, 'x');
  const options = {directory: path.join(root, 'state')};
  const chip = new ObservedContextStore(projectDir, 'chip', options);
  await assert.rejects(chip.observeArtifact({id: 'outside', kind: 'waveform', file: outside}), /inside the project/);
  const pcb = new ObservedContextStore(projectDir, 'pcb', options);
  assert.notEqual(chip.projectId, pcb.projectId);
  chip.close(); pcb.close();
});
