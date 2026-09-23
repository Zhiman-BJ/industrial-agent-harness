const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {selectMcpServers, writeMcpConfig} = require('./index.cjs');

test('a server is withheld unless every declared tool is in scope and it is enabled', t => {
  const server = {id: 'fixture', domain: 'chip', toolIds: ['eda.netlist.inspect', 'eda.waveform.inspect'], config: {command: 'fixture-server'}};
  assert.deepEqual(selectMcpServers({domain: 'chip', tools: ['eda.netlist.inspect']}, [], [server]), []);
  assert.deepEqual(selectMcpServers({domain: 'chip', tools: server.toolIds}, ['fixture'], [server]), []);
  assert.deepEqual(selectMcpServers({domain: 'chip', tools: server.toolIds}, [], [server]), [server]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-mcp-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = writeMcpConfig(root, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {mcpServers: {}});
});
