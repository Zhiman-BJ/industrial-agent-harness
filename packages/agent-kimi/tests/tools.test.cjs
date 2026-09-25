const test = require('node:test');
const assert = require('node:assert/strict');
const {externalTools, industrialContext} = require('../src/index.cjs');

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

test('capability detail can be narrowed and stale capability calls are rejected', async () => {
  let scope = {capabilityIds: ['chip.rtl.netlist.inspect'], tools: []};
  const tools = externalTools(() => scope, async () => null, () => ({capability: 'chip.rtl.netlist.inspect', skills: [{id: 'skill', reference: 'x'.repeat(20000)}], tools: [{id: 'tool'}], verification: []}));
  await assert.rejects(tools[0].handler({capabilityId: 'chip.rtl.netlist.inspect'}), /above the 16384-byte limit/);
  assert.deepEqual(JSON.parse((await tools[0].handler({capabilityId: 'chip.rtl.netlist.inspect', section: 'tools'})).output), {capability: 'chip.rtl.netlist.inspect', tools: [{id: 'tool'}]});
  scope = {capabilityIds: [], tools: []};
  await assert.rejects(tools[0].handler({capabilityId: 'chip.rtl.netlist.inspect'}), /outside/);
});

test('artifact metadata and injected scope reject oversized responses without silent truncation', async () => {
  const scope = {domain: 'chip', stage: 'rtl', capabilityIds: ['chip.rtl.netlist.inspect'], skills: [], tools: ['eda.netlist.inspect']};
  const tools = externalTools(() => scope, async id => ({id, kind: 'netlist', payload: '中'.repeat(6000)}), () => null);
  await assert.rejects(tools[1].handler({artifactId: 'large'}), /above the 16384-byte limit/);
  assert.throws(() => industrialContext({...scope, tools: Array.from({length: 1000}, (_, index) => `tool-${index}`)}), /Industrial Context limit/);
});
