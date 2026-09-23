const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {prepareSessionFiles} = require('../src/index.cjs');

test('Kimi session receives only selected repository skills and an isolated MCP config', t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-source-'));
  t.after(() => fs.rmSync(source, {recursive: true, force: true}));
  fs.writeFileSync(path.join(source, 'config.toml'), 'default_model = "industrial"\n');
  const directory = prepareSessionFiles({domain: 'chip', skills: ['chip.netlist.inspect'], tools: []}, {shareDir: source, disabledMcpServers: []});
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  assert.deepEqual(fs.readdirSync(path.join(directory, 'skills')), ['chip-netlist-inspect']);
  assert.match(fs.readFileSync(path.join(directory, 'config.toml'), 'utf8'), /^extra_skill_dirs = \[/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'mcp.json'))), {mcpServers: {}});
});
