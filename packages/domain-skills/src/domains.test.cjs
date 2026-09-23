const test = require('node:test');
const assert = require('node:assert/strict');
const capabilities = require('./capabilities.cjs');
const {listDomains} = require('./domains.cjs');

test('domain options follow registered capabilities', () => {
  assert.deepEqual(listDomains(capabilities), [{id: 'chip', label: 'Chip', emoji: '💠'}, {id: 'pcb', label: 'PCB', emoji: '🔌'}]);
  assert.deepEqual(listDomains([...capabilities, {domain: 'mechanical_cad'}]).find(item => item.id === 'mechanical_cad'), {id: 'mechanical_cad', label: 'Mechanical Cad', emoji: '⚙️'});
});
