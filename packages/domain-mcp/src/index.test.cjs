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

test('a gateway intersects scope while installed Runtime providers stay behind canonical execution', () => {
  const { listMcpServers } = require('./index.cjs');
  const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
  for (const pack of loadRegistry().providerPacks.filter(
    pack => pack.provider.transport === 'runtime',
  )) {
    assert.ok(!listMcpServers(pack.domain).some(provider => provider.id === pack.provider.id));
    assert.ok(
      !selectMcpServers({
        domain: pack.domain,
        tools: pack.provider.tools.map(tool => tool.id),
      }).some(provider => provider.id === pack.provider.id),
    );
  }
  const gateway = {
    id: 'fixture.gateway',
    domain: 'fixture',
    transport: 'gateway',
    toolIds: ['fixture.inspect', 'fixture.edit'],
  };
  const scope = { domain: 'fixture', tools: ['fixture.inspect'] };
  assert.deepEqual(selectMcpServers(scope, [], [gateway])[0].allowedToolIds, scope.tools);
  assert.deepEqual(selectMcpServers(scope, [gateway.id], [gateway]), []);
  assert.deepEqual(selectMcpServers({ ...scope, domain: 'other' }, [], [gateway]), []);
  assert.deepEqual(selectMcpServers({ domain: 'fixture', tools: ['unknown'] }, [], [gateway]), []);
});
