const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { devUserDataDirectory } = require('./dev-data.cjs');

test('development profiles are scoped to the checkout', () => {
  assert.equal(
    devUserDataDirectory('/repo/apps/desktop', [], {}),
    path.join('/repo/apps/desktop', '.user-data'),
  );
});

test('selftest launches keep their temporary profiles', () => {
  for (const flag of ['--chat-selftest', '--packaged-smoke', '--install-experience-selftest'])
    assert.equal(devUserDataDirectory('/repo', [flag], {}), null, flag);
});

test('INDUSTRIAL_DEV_USER_DATA opts into an explicit shared profile', () => {
  assert.equal(
    devUserDataDirectory('/repo', [], { INDUSTRIAL_DEV_USER_DATA: '/shared/profile' }),
    '/shared/profile',
  );
  // Selftest isolation wins over the explicit override.
  assert.equal(
    devUserDataDirectory('/repo', ['--chat-selftest'], {
      INDUSTRIAL_DEV_USER_DATA: '/shared/profile',
    }),
    null,
  );
});
