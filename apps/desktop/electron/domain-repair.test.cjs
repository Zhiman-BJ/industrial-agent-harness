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
    await assert.rejects(handler({}, { domain }), /official source/);
  assert.equal(ensured, 0);
});
test('legacy repair IPC rejects old bundles without invoking legacy software download', async () => {
  let calls = 0;
  const handler = domainRepairHandler({
    manager: { list: () => [{ domain: 'legacy', runtimeAssets: [] }] },
    isManaged: () => true,
    repairLegacy: async () => {
      calls++;
    },
  });
  await assert.rejects(handler({}, { domain: 'legacy' }), /official source/);
  await assert.rejects(handler({}, { domain: 'missing' }), /not installed/);
  assert.equal(calls, 0);
});
