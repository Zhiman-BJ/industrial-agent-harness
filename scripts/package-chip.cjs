#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'domain-packs', 'chip');
const target = path.resolve(process.argv[2] || path.join(root, 'dist', 'chip-pack'));
if (fs.existsSync(target)) throw Error(`Output already exists: ${target}`);
fs.mkdirSync(path.dirname(target), {recursive: true});
fs.cpSync(source, target, {recursive: true, filter: file => !['.venv', '.venv-kimi', '__pycache__', '.DS_Store'].includes(path.basename(file)) && !file.endsWith('.pyc')});
for (const file of ['install.sh', 'chip-harness.sh', 'bind-kimi.sh', 'eda-harness/uv.lock', 'eda-harness/src/eda_harness/server/mcp.py', 'eda-harness/skills/eda-core/SKILL.md']) {
  if (!fs.existsSync(path.join(target, file))) throw Error(`Incomplete Chip Pack: ${file}`);
}
process.stdout.write(`${target}\n`);
