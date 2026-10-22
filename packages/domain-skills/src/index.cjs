const { loadDomainPacks } = require('./packs.cjs');
const domainPacks = loadDomainPacks();
const capabilities = [
  ...require('@zhiman-bj/industrial-domain-packs').consumerMetadata().capabilities,
  ...domainPacks.flatMap(pack => pack.capabilities),
];
const { listDomains } = require('./domains.cjs');
const { listSkills, materializeSkills } = require('./consumer.cjs');
const { loadRegistry, installedSkills, materializeInstalledSkills } = require('./installed.cjs');

module.exports = {
  packGatewayAdapter: require('@zhiman-bj/industrial-domain-packs').gatewayAdapter,
  ...require('./installed.cjs'),
  packSourceDirectory: require('@zhiman-bj/industrial-domain-packs').sourceDirectory,
  packReleaseIdentity: require('@zhiman-bj/industrial-domain-packs').identity,
  capabilities,
  listDomains,
  listSkills: installedSkills,
  materializeSkills: materializeInstalledSkills,
  domainPacks,
  loadRegistry,
  ...require('./pack-resources.cjs'),
};
