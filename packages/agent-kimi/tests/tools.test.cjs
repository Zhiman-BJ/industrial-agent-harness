const test = require('node:test');
const assert = require('node:assert/strict');
const {externalTools} = require('../src/index.cjs');

test('Kimi receives only current Broker tools and stale calls are rejected', async () => {
  let scope = {capabilityIds: ['chip.rtl.netlist.inspect'], tools: ['eda.netlist.inspect']};
  const tools = externalTools(() => scope, async id => ({id, kind: 'netlist'}), id => ({capability: id}));
  assert.deepEqual(tools.map(tool => tool.name), ['industrial_capability_detail', 'eda_netlist_inspect']);
  const result = await tools[1].handler({artifactId: 'sample'});
  assert.match(result.output, /sample/);
  scope = {capabilityIds: ['chip.verification.waveform.inspect'], tools: ['eda.waveform.inspect']};
  await assert.rejects(tools[1].handler({artifactId: 'sample'}), /outside/);
});

test('general project tasks receive no industrial tools', () => {
  const tools = externalTools(() => ({capabilityIds: [], tools: []}), async () => null, () => null);
  assert.deepEqual(tools, []);
});
