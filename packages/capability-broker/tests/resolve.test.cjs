const test = require('node:test');
const assert = require('node:assert/strict');
const {resolve, discloseDetail, assertToolAllowed} = require('../src/index.cjs');
const registry = require('../../domain-skills/src/capabilities.cjs');

test('progressive disclosure selects only matching domain and stage', () => {
  const result = resolve({domain: 'chip', stage: 'rtl', task: 'Inspect the netlist signals'}, registry);
  assert.deepEqual(result.scope.capabilityIds, ['chip.rtl.netlist.inspect']);
  assert.deepEqual(result.scope.tools, ['eda.netlist.inspect']);
  assert.deepEqual(result.trace.map(item => item.level), ['L0', 'L1', 'L1', 'L2', 'L2', 'L2', 'L3']);
  assert.equal(result.trace.find(item => item.event === 'detail.deferred').detail.toolSchemas, 1);
  assert.throws(() => assertToolAllowed(result.scope, 'pcb.board.inspect'), /outside/);
  assert.equal(discloseDetail(result.scope, registry, result.matches[0].id).tools[0].schema.artifactId, 'string');
});

test('scope changes replace old capabilities', () => {
  const first = resolve({domain: 'chip', stage: 'rtl', task: 'netlist'}, registry);
  const next = resolve({domain: 'pcb', stage: 'layout', task: 'Inspect PCB board'}, registry, first.scope);
  assert.deepEqual(next.scope.tools, ['pcb.board.inspect']);
  assert.equal(next.trace.find(item => item.event === 'scope.replace').detail.previous, first.scope.version);
  assert.throws(() => discloseDetail(next.scope, registry, 'chip.rtl.netlist.inspect'), /outside/);
});

test('automatic context resolves from task or selected artifact', () => {
  const pcb = resolve({task: 'Inspect the PCB board routing'}, registry);
  assert.equal(pcb.scope.domain, 'pcb');
  assert.equal(pcb.scope.stage, 'layout');
  assert.deepEqual(pcb.scope.capabilityIds, ['pcb.layout.inspect']);
  assert.ok(pcb.contexts.some(item => item.domain === 'chip' && item.stage === 'physical'));
  const waveform = resolve({task: 'Inspect this artifact', artifactKind: 'waveform'}, registry);
  assert.deepEqual(waveform.scope.capabilityIds, ['chip.verification.waveform.inspect']);
  const unknown = resolve({task: 'Plan an unrelated activity'}, registry);
  assert.deepEqual(unknown.scope.capabilityIds, []);
  assert.equal(unknown.scope.domain, null);
});
