const test = require('node:test');
const assert = require('node:assert/strict');
const {ObservedArtifactSchema} = require('../src/index.cjs');

test('file observation cannot claim engineering verification', () => {
  const candidate = {id: 'a', kind: 'netlist', relativePath: 'top.json', sizeBytes: 1, sha256: 'a'.repeat(64), source: 'project-file', verificationStatus: 'passed'};
  assert.equal(ObservedArtifactSchema.safeParse(candidate).success, false);
  assert.equal(ObservedArtifactSchema.safeParse({...candidate, verificationStatus: 'not_run'}).success, true);
});
