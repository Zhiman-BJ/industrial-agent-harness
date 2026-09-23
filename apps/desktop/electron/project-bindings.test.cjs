const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readBindings, addBinding, saveBindings} = require('./project-bindings.cjs');

test('projects keep distinct directory bindings across restarts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-projects-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sample = path.join(root, 'sample');
  const second = path.join(root, 'second');
  fs.mkdirSync(sample); fs.mkdirSync(second);
  let state = readBindings(path.join(root, 'config'), sample);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].domain, 'chip');
  state = addBinding(state, second);
  assert.equal(state.projects.length, 2);
  assert.equal(state.projects[1].domain, undefined);
  state.projects[1].domain = 'pcb';
  saveBindings(path.join(root, 'config'), state);
  assert.deepEqual(readBindings(path.join(root, 'config'), sample), state);
  assert.equal(addBinding(state, sample).projects.length, 2);
});

test('existing sample bindings acquire a fixed domain while explicit unpinning persists', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-project-domain-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sample = path.join(root, 'sample');
  fs.mkdirSync(sample);
  const config = path.join(root, 'config');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'projects.json'), JSON.stringify({projects: [{id: 'chip-sobel-example', name: 'Sample', path: sample}], activeId: 'chip-sobel-example'}));
  const migrated = readBindings(config, sample);
  assert.equal(migrated.projects[0].domain, 'chip');
  migrated.projects[0].domain = null;
  saveBindings(config, migrated);
  assert.equal(readBindings(config, sample).projects[0].domain, null);
});
