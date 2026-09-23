const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const directory = path.resolve(__dirname, '../.venv-kimi');
const python = path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(python)) {
  const created = spawnSync('uv', ['venv', '--python', '3.13', directory], {stdio: 'inherit'});
  if (created.status !== 0) process.exit(created.status || 1);
}
const installed = spawnSync('uv', ['pip', 'install', '--python', python, 'kimi-cli==1.51.0'], {stdio: 'inherit'});
process.exitCode = installed.status === 0 ? 0 : 1;
