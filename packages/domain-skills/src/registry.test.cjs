const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capabilities = require('./capabilities.cjs');
const {listSkills, skillFile, materializeSkills} = require('./registry.cjs');

test('every capability skill has a repository file and only scoped skills reach Kimi', t => {
  const expected = new Set(capabilities.flatMap(item => item.skills.map(skill => skill.id)));
  assert.deepEqual(new Set(listSkills().map(item => item.id)), expected);
  for (const id of expected) assert.match(fs.readFileSync(skillFile(id), 'utf8'), /^---\nname:/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-skills-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = materializeSkills({skills: ['chip.netlist.inspect']}, root);
  assert.deepEqual(fs.readdirSync(directory), ['chip-netlist-inspect']);
  assert.ok(fs.existsSync(path.join(directory, 'chip-netlist-inspect', 'SKILL.md')));
});
