const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readBindings(directory, sampleDirectory) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'projects.json'), 'utf8'));
    if (!Array.isArray(saved.projects)) throw Error('Invalid project bindings.');
    const projects = saved.projects.filter(item => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string').map(item => ({...item, name: item.id === 'chip-sobel-example' && item.name === 'Chip · Sobel example' ? 'Sobel example' : item.name, domain: typeof item.domain === 'string' ? item.domain : item.id === 'chip-sobel-example' && item.domain === undefined ? 'chip' : null, disabledSkills: Array.isArray(item.disabledSkills) ? item.disabledSkills.filter(id => typeof id === 'string') : [], disabledMcpServers: Array.isArray(item.disabledMcpServers) ? item.disabledMcpServers.filter(id => typeof id === 'string') : []}));
    return {projects, activeId: projects.some(item => item.id === saved.activeId) ? saved.activeId : null};
  } catch {
    const projects = fs.existsSync(sampleDirectory) ? [{id: 'chip-sobel-example', name: 'Sobel example', path: fs.realpathSync(sampleDirectory), domain: 'chip', disabledSkills: [], disabledMcpServers: []}] : [];
    return {projects, activeId: projects[0]?.id || null};
  }
}

function addBinding(state, directory, domain, name) {
  const actual = fs.realpathSync(directory);
  if (!fs.statSync(actual).isDirectory()) throw Error('Choose a directory.');
  if (state.projects.some(item => {
    try {return fs.realpathSync(item.path) === actual;}
    catch {return item.path === actual;}
  })) throw Error('This directory already belongs to a project.');
  if (typeof domain !== 'string' || !domain) throw Error('Choose a project domain.');
  const projectName = typeof name === 'string' ? name.trim() : path.basename(actual);
  if (!projectName || projectName.length > 100) throw Error('Enter a project name (up to 100 characters).');
  const project = {id: crypto.randomUUID(), name: projectName, path: actual, domain, disabledSkills: [], disabledMcpServers: []};
  return {projects: [...state.projects, project], activeId: project.id};
}

function saveBindings(directory, state) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, 'projects.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2), {mode: 0o600});
  fs.chmodSync(file, 0o600);
}

module.exports = {readBindings, addBinding, saveBindings};
