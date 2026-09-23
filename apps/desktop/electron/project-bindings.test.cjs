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
  state = addBinding(state, second);
  assert.equal(state.projects.length, 2);
  saveBindings(path.join(root, 'config'), state);
  assert.deepEqual(readBindings(path.join(root, 'config'), sample), state);
  assert.equal(addBinding(state, sample).projects.length, 2);
});
