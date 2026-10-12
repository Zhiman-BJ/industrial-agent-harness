const test = require('node:test');
const assert = require('node:assert/strict');
const { domainRepairHandler } = require('./domain-repair.cjs');
test('legacy repair IPC refuses v2 Packs without touching any runtime assets', async () => {
  let ensured = 0;
  const manager = {
    list: () => [
      {
        domain: 'v2',
        executionProfiles: [{ id: 'native', assetIds: ['app'] }],
        runtimeAssets: [{ id: 'app' }, { id: 'container' }],
      },
      { domain: 'empty', executionProfiles: [] },
    ],
    runtimeAssets: {
      ensure: async () => {
        ensured++;
      },
    },
  };
  const handler = domainRepairHandler({
    manager,
    isManaged: () => true,
    repairLegacy: () => manager.runtimeAssets.ensure(),
  });
  for (const domain of ['v2', 'empty'])
    await assert.rejects(handler({}, { domain }), /Choose an execution profile/);
  assert.equal(ensured, 0);
});
test('legacy repair IPC preserves the old bundle handler and request', async () => {
  const event = { sender: 'fixture' },
    request = { domain: 'legacy' };
  const handler = domainRepairHandler({
    manager: { list: () => [{ domain: 'legacy', runtimeAssets: [] }] },
    isManaged: () => true,
    repairLegacy: async (e, r) => {
      assert.equal(e, event);
      assert.equal(r, request);
      return { installed: [] };
    },
  });
  assert.deepEqual(await handler(event, request), { installed: [] });
  await assert.rejects(handler(event, { domain: 'missing' }), /not installed/);
});
