const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectMcpServers, writeMcpConfig } = require('./index.cjs');

test('a server is withheld unless every declared tool is in scope and it is enabled', t => {
  const server = {
    id: 'fixture',
    domain: 'chip',
    toolIds: ['eda.netlist.inspect', 'eda.waveform.inspect'],
    config: { command: 'fixture-server' },
  };
  assert.deepEqual(
    selectMcpServers({ domain: 'chip', tools: ['eda.netlist.inspect'] }, [], [server]),
    [],
  );
  assert.deepEqual(
    selectMcpServers({ domain: 'chip', tools: server.toolIds }, ['fixture'], [server]),
    [],
  );
  assert.deepEqual(selectMcpServers({ domain: 'chip', tools: server.toolIds }, [], [server]), [
    server,
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-mcp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = writeMcpConfig(root, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { mcpServers: {} });
});

test('registered gateway intersects the current scope while direct providers retain all-or-nothing disclosure', () => {
  const gateway = {
    id: 'fixture.gateway',
    domain: 'fixture-domain',
    transport: 'gateway',
    toolIds: ['fixture.read', 'fixture.write'],
  };
  const direct = { ...gateway, id: 'fixture.direct', transport: 'stdio' };
  const scope = { domain: 'fixture-domain', tools: ['fixture.read'] };
  assert.deepEqual(selectMcpServers(scope, [], [gateway, direct]), [
    { ...gateway, allowedToolIds: scope.tools },
  ]);
  assert.deepEqual(selectMcpServers(scope, [gateway.id], [gateway, direct]), []);
  assert.deepEqual(
    selectMcpServers({ ...scope, domain: 'another-domain' }, [], [gateway, direct]),
    [],
  );
  assert.deepEqual(selectMcpServers({ ...scope, tools: ['unknown'] }, [], [gateway, direct]), []);
});
