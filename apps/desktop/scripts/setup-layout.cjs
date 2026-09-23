const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const desktop = path.resolve(__dirname, '..');
const envDir = path.join(desktop, '.venv-klayout');
const commands = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3.12'], ['python3.11'], ['python3.10'], ['python3'], ['python']];
let selected;
for (const [command, ...prefix] of commands) {
  const check = spawnSync(command, [...prefix, '--version'], {stdio: 'ignore'});
  if (check.status === 0) {selected = [command, ...prefix]; break;}
}
if (!selected) throw Error('Python 3 is required for the KLayout viewer.');
const [command, ...prefix] = selected;
if (!fs.existsSync(envDir)) {
  const created = spawnSync(command, [...prefix, '-m', 'venv', envDir], {stdio: 'inherit'});
  if (created.status !== 0) process.exit(created.status || 1);
}
const python = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const installed = spawnSync(python, ['-m', 'pip', 'install', 'klayout==0.30.12'], {stdio: 'inherit'});
process.exitCode = installed.status === 0 ? 0 : 1;
