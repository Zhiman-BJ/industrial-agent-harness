const fs = require('node:fs');
const path = require('node:path');

const SKILL_SOURCE = path.join(__dirname, '..', 'skills', 'computer-use', 'SKILL.md');

// Materialize the plugin skill into a session directory so Kimi loads it through the
// existing extra_skill_dirs mechanism. Returns the skills root directory.
function materializeGuiSkill(directory) {
  const root = path.join(directory, 'skills');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const target = path.join(root, 'computer-use');
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  fs.copyFileSync(SKILL_SOURCE, path.join(target, 'SKILL.md'));
  return root;
}

module.exports = {materializeGuiSkill};
