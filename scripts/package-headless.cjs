#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const target = path.resolve(process.argv[2] || path.join(root, 'dist', 'headless'));
if (target === root || !target.startsWith(`${root}${path.sep}`) && !process.argv[2]) throw Error('Invalid headless output directory.');
if (fs.existsSync(target)) throw Error(`Output already exists: ${target}`);
fs.mkdirSync(path.dirname(target), {recursive: true});
const result = spawnSync('pnpm', ['--filter', '@industrial-agent-harness/cli', 'deploy', '--legacy', '--prod', target], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const entry = path.join(target, 'src', 'main.cjs');
const skill = path.join(target, 'node_modules', '@industrial-agent-harness', 'domain-skills', 'skills', 'chip-netlist-inspect', 'SKILL.md');
const agent = path.join(target, 'node_modules', '@industrial-agent-harness', 'agent-kimi', 'src', 'index.cjs');
const mcp = createRequire(fs.realpathSync(agent)).resolve('@industrial-agent-harness/domain-mcp');
const runtime = path.join(target, 'node_modules', '@industrial-agent-harness', 'domain-runtime', 'src', 'index.cjs');
const contracts = createRequire(fs.realpathSync(runtime)).resolve('@industrial-agent-harness/contracts');
for (const file of [entry, skill, mcp, runtime, contracts]) if (!fs.existsSync(file)) throw Error(`Incomplete headless package: ${file}`);
fs.writeFileSync(path.join(target, 'industrial-harness.cjs'), '#!/usr/bin/env node\nvoid require("./src/main.cjs").main();\n', {mode: 0o755});
fs.writeFileSync(path.join(target, 'HEADLESS-README.txt'), 'Industrial Agent Harness headless package\n\nRun with Node.js 22.13 or newer:\n  node industrial-harness.cjs run --project-dir DIR --domain DOMAIN --task TEXT --scope-only\n  node industrial-harness.cjs bench --suite FILE --output-dir DIR\n\nAgent execution additionally needs a Kimi CLI executable and model API key in the environment. This package contains the Harness CLI, Broker, Skill files, MCP registry, Kimi SDK integration, and observed-context SQLite store. Full diagnostic JSONL is saved under ~/.industrial-agent-harness/logs by default. It does not bundle the Kimi CLI or industrial executables. The current MCP registry has no default servers.\n');
process.stdout.write(`${target}\n`);
