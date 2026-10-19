const test = require('node:test');
const assert = require('node:assert/strict');
const { packagedAppName } = require('./app-identity.cjs');

test('packaged apps claim the product identity for their profile', () => {
  const name = packagedAppName();
  assert.equal(name, 'Industrial Agent Harness');
  // The profile name must differ from the package name used by development
  // checkouts, otherwise packaged and dev instances share one userData.
  const packageName = require('../package.json').name;
  assert.notEqual(name, packageName);
});
