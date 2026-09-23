const test = require('node:test');
const assert = require('node:assert/strict');
const {resolveProjectTask} = require('../src/index.cjs');

test('a project domain constrains capability resolution without a desktop process', () => {
  const result = resolveProjectTask('chip', {task: 'Inspect netlist signals'});
  assert.equal(result.scope.domain, 'chip');
  assert.deepEqual(result.scope.capabilityIds, ['chip.rtl.netlist.inspect']);
  assert.throws(() => resolveProjectTask('chip', {task: 'Inspect PCB board', domain: 'pcb'}), /fixed to the chip domain/);
  assert.throws(() => resolveProjectTask('missing', {task: 'Inspect netlist'}), /valid project domain/);
});

test('a project-disabled skill is absent from scope, detail, and the disclosure trace', () => {
  const {effectiveCapabilities} = require('../src/index.cjs');
  const {capabilities} = require('@industrial-agent-harness/domain-skills');
  const {discloseDetail} = require('@industrial-agent-harness/capability-broker');
  const disabled = {skills: ['chip.netlist.inspect'], mcpServers: []};
  const result = resolveProjectTask('chip', {task: 'Inspect netlist signals'}, undefined, capabilities, disabled);
  assert.deepEqual(result.scope.skills, []);
  assert.deepEqual(result.scope.tools, ['eda.netlist.inspect']);
  assert.deepEqual(discloseDetail(result.scope, effectiveCapabilities(capabilities, disabled), 'chip.rtl.netlist.inspect').skills, []);
  assert.ok(result.trace.some(entry => entry.event === 'resource.policy' && entry.detail.disabledSkills.includes('chip.netlist.inspect')));
});
