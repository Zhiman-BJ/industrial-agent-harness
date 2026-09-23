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
