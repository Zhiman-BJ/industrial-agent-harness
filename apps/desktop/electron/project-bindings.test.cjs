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
  const third = path.join(root, 'third');
  fs.mkdirSync(sample); fs.mkdirSync(second); fs.mkdirSync(third);
  let state = readBindings(path.join(root, 'config'), sample);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].domain, 'chip');
  state = addBinding(state, second, 'pcb', 'Board project');
  assert.equal(state.projects.length, 2);
  assert.equal(state.projects[1].domain, 'pcb');
  assert.equal(state.projects[1].name, 'Board project');
  saveBindings(path.join(root, 'config'), state);
  assert.deepEqual(readBindings(path.join(root, 'config'), sample), state);
  assert.throws(() => addBinding(state, sample, 'chip'), /already belongs/);
  assert.throws(() => addBinding(state, third, ''), /Choose a project domain/);
});

test('existing sample bindings acquire a domain while legacy unset values remain editable', t => {
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

test('the sample name no longer duplicates its domain badge', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sample-name-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sample = path.join(root, 'sample');
  const config = path.join(root, 'config');
  fs.mkdirSync(sample); fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'projects.json'), JSON.stringify({projects: [{id: 'chip-sobel-example', name: 'Chip · Sobel example', path: sample, domain: 'chip'}], activeId: 'chip-sobel-example'}));
  assert.equal(readBindings(config, sample).projects[0].name, 'Sobel example');
});
