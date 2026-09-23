const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readBindings(directory, sampleDirectory) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'projects.json'), 'utf8'));
    if (!Array.isArray(saved.projects)) throw Error('Invalid project bindings.');
    const projects = saved.projects.filter(item => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string');
    return {projects, activeId: projects.some(item => item.id === saved.activeId) ? saved.activeId : null};
  } catch {
    const projects = fs.existsSync(sampleDirectory) ? [{id: 'chip-sobel-example', name: 'Chip · Sobel example', path: fs.realpathSync(sampleDirectory)}] : [];
    return {projects, activeId: projects[0]?.id || null};
  }
}

function addBinding(state, directory) {
  const actual = fs.realpathSync(directory);
  if (!fs.statSync(actual).isDirectory()) throw Error('Choose a directory.');
  const existing = state.projects.find(item => item.path === actual);
  const project = existing || {id: crypto.randomUUID(), name: path.basename(actual), path: actual};
  return {projects: existing ? state.projects : [...state.projects, project], activeId: project.id};
}

function saveBindings(directory, state) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, 'projects.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2), {mode: 0o600});
  fs.chmodSync(file, 0o600);
}

module.exports = {readBindings, addBinding, saveBindings};
