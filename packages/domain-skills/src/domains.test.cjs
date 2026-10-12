const test = require('node:test');
const assert = require('node:assert/strict');
const { capabilities } = require('./index.cjs');
const { listDomains, isDomainOffered } = require('./domains.cjs');

test('domain options include registered Viewer-only domains', () => {
  assert.deepEqual(listDomains(capabilities), [
    { id: 'cad', label: 'CAD', emoji: '📐' },
    { id: 'chip', label: 'Chip', emoji: '💠' },
    { id: 'godot', label: 'Godot', emoji: '🎮' },
    { id: 'pcb', label: 'PCB', emoji: '🔌' },
  ]);
  assert.deepEqual(
    listDomains([...capabilities, { domain: 'mechanical_cad' }]).find(
      item => item.id === 'mechanical_cad',
    ),
    { id: 'mechanical_cad', label: 'Mechanical Cad', emoji: '⚙️' },
  );
});

test('withdrawal hides current choices while legacy and independent domains stay readable', () => {
  assert.equal(isDomainOffered('cuda'), false);
  assert.equal(isDomainOffered('third-party-domain'), true);
  assert.equal(isDomainOffered('chip'), true);
  assert.ok(listDomains([{ domain: 'cuda' }]).some(item => item.id === 'cuda'));
});
