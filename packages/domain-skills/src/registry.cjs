const fs = require('node:fs');
const path = require('node:path');
const {distributionDomain} = require('./distribution.cjs');

// Repository-owned defaults. Harness resource policy stores ID enablement only.
const skills = Object.freeze([
  {id: 'chip.netlist.inspect', domain: 'chip', title: 'Inspect RTL netlist', directory: 'chip-netlist-inspect'},
  {id: 'chip.waveform.inspect', domain: 'chip', title: 'Inspect simulation waveform', directory: 'chip-waveform-inspect'},
  {id: 'chip.layout.inspect', domain: 'chip', title: 'Inspect physical layout', directory: 'chip-layout-inspect'},
  {id: 'pcb.layout.inspect', domain: 'pcb', title: 'Inspect PCB layout', directory: 'pcb-layout-inspect'},
  {id: 'chip.eda.operate', domain: 'chip', title: 'Operate Chip Pack EDA Harness', directory: 'chip-eda-operate'},
  {id: 'pcb.design.e2e', domain: 'pcb', title: 'PCB design and repair', directory: 'pcb-design-e2e', externalPack: 'pcb-bench', nativeToolPrefix: 'pcb.bench.'},
  {id: 'godot.game.inspect', domain: 'godot', title: 'Inspect Godot game scenes', directory: 'godot-game-inspect'},
  {id: 'godot.game.develop', domain: 'godot', title: 'Develop and verify Godot games', directory: 'godot-game-develop'},
  {id: 'cad.autocad.macos', domain: 'cad', title: 'Operate AutoCAD on macOS', directory: 'cad-autocad-macos'},
  {id: 'cad.intent.loop', domain: 'cad', title: 'CAD intent loop (dimension-neutral)', directory: 'cad-intent-loop'},
  {id: 'cad.ezdxf.author', domain: 'cad', title: 'Author 2D DXF via ezdxf', directory: 'cad-ezdxf'},
  {id: 'cad.freecad.headless', domain: 'cad', title: 'Drive FreeCAD headless', directory: 'cad-freecad-headless'},
]);

function listSkills(domain) {
  return skills.filter(item => (!distributionDomain || item.domain === distributionDomain) && (!domain || item.domain === domain)).map(({directory, externalPack, nativeToolPrefix, ...item}) => ({...item, enabledByDefault: true}));
}

function skillFile(id) {
  const item = skills.find(skill => skill.id === id && (!distributionDomain || skill.domain === distributionDomain));
  if (!item) throw Error(`Unknown repository skill: ${id}`);
  const file = path.join(__dirname, '..', 'skills', item.directory, 'SKILL.md');
  if (!fs.statSync(file).isFile()) throw Error(`Missing repository skill: ${id}`);
  return file;
}

function materializeSkills(scope, directory, environment = process.env) {
  const root = path.join(directory, 'skills');
  const staged = fs.mkdtempSync(path.join(directory, '.skills-'));
  try {
    for (const id of scope.skills) {
      const item = skills.find(skill => skill.id === id && (!distributionDomain || skill.domain === distributionDomain));
      if (!item) continue;
      let source = path.dirname(skillFile(id));
      if (item.externalPack) {
        const {loadDomainPacks} = require('./packs.cjs');
        const {resourceDirectory} = require('./pack-resources.cjs');
        const provider = loadDomainPacks().find(pack => pack.id === item.externalPack)?.provider;
        if (!provider) throw Error('Skill requires its registered Domain Pack.');
        source = path.join(resourceDirectory(provider, environment), 'skills', item.directory);
      }
      const target = path.join(staged, item.directory);
      fs.cpSync(source, target, {recursive: true, dereference: false, filter: file => {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('Skill resources cannot contain symlinks.');
        return !['__pycache__', '.DS_Store'].includes(path.basename(file)) && !file.endsWith('.pyc');
      }});
      if (item.externalPack) fs.appendFileSync(path.join(target, 'SKILL.md'), `\n\n## Industrial Harness integration\n\nUse domain_tool_list to discover the current allowed tools. Each native name in this Skill maps to canonical ID ${item.nativeToolPrefix}<name>; use domain_tool_describe and domain_tool_call with that ID. The backend owns native CAD actions and receipts. Do not bypass it with Shell or direct file edits. A successful tool process or an observation is not engineering acceptance.\n`);
    }
    fs.rmSync(root, {recursive: true, force: true});
    fs.renameSync(staged, root);
  } catch (error) {
    fs.rmSync(staged, {recursive: true, force: true});
    throw error;
  }
  return root;
}

module.exports = {listSkills, skillFile, materializeSkills};
