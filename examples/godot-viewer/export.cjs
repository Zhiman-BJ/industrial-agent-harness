const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = __dirname;
// Keep the example on the same bridge implementation as the production Viewer.
fs.copyFileSync(path.resolve(root, '../../packages/viewer-builtin/src/godot/harness_viewer_bridge.gd'), path.join(root, 'harness_viewer_bridge.gd'));
fs.mkdirSync(path.join(root, 'build'), {recursive: true});
const binary = process.env.GODOT_BIN || 'godot';
for (const args of [['--headless', '--path', root, '--editor', '--import'], ['--headless', '--path', root, '--export-release', 'Web', 'build/playground.html']]) {
  const result = spawnSync(binary, args, {stdio: 'inherit'});
  if (result.error) {console.error(`Cannot run ${binary}: ${result.error.message}`); process.exit(1);}
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('Open build/playground.html in the Godot project workspace.');
