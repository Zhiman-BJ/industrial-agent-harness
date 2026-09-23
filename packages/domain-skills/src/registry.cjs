const fs = require('node:fs');
const path = require('node:path');

// Repository-owned defaults. Project bindings store only disabled IDs.
const skills = Object.freeze([
  {id: 'chip.netlist.inspect', domain: 'chip', title: 'Inspect RTL netlist', directory: 'chip-netlist-inspect'},
  {id: 'chip.waveform.inspect', domain: 'chip', title: 'Inspect simulation waveform', directory: 'chip-waveform-inspect'},
  {id: 'chip.layout.inspect', domain: 'chip', title: 'Inspect physical layout', directory: 'chip-layout-inspect'},
  {id: 'pcb.layout.inspect', domain: 'pcb', title: 'Inspect PCB layout', directory: 'pcb-layout-inspect'},
]);

function listSkills(domain) {
  return skills.filter(item => !domain || item.domain === domain).map(({directory, ...item}) => ({...item, enabledByDefault: true}));
}

function skillFile(id) {
  const item = skills.find(skill => skill.id === id);
  if (!item) throw Error(`Unknown repository skill: ${id}`);
  const file = path.join(__dirname, '..', 'skills', item.directory, 'SKILL.md');
  if (!fs.statSync(file).isFile()) throw Error(`Missing repository skill: ${id}`);
  return file;
}

function materializeSkills(scope, directory) {
  const root = path.join(directory, 'skills');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  for (const id of scope.skills) {
    const item = skills.find(skill => skill.id === id);
    if (!item) continue;
    const target = path.join(root, item.directory);
    fs.mkdirSync(target, {mode: 0o700});
    fs.copyFileSync(skillFile(id), path.join(target, 'SKILL.md'));
  }
  return root;
}

module.exports = {listSkills, skillFile, materializeSkills};
