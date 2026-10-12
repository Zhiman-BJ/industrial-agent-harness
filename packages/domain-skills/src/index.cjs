const { distributionDomain } = require('./distribution.cjs');
const { loadDomainPacks } = require('./packs.cjs');
const domainPacks = loadDomainPacks();
const capabilities = [
  ...require('@zhiman-bj/industrial-domain-packs').consumerMetadata().capabilities,
  ...domainPacks.flatMap(pack => pack.capabilities),
].filter(item => !distributionDomain || item.domain === distributionDomain);
const { listDomains, isDomainOffered } = require('./domains.cjs');
const { listSkills, materializeSkills } = require('./consumer.cjs');
const { loadRegistry, installedSkills, materializeInstalledSkills } = require('./installed.cjs');

module.exports = {
  packGatewayAdapter: require('@zhiman-bj/industrial-domain-packs').gatewayAdapter,
  ...require('./installed.cjs'),
  packSourceDirectory: require('@zhiman-bj/industrial-domain-packs').sourceDirectory,
  packReleaseIdentity: require('@zhiman-bj/industrial-domain-packs').identity,
  capabilities,
  listDomains,
  isDomainOffered,
  listSkills: installedSkills,
  materializeSkills: materializeInstalledSkills,
  domainPacks,
  loadRegistry,
  distributionDomain,
  ...require('./pack-resources.cjs'),
};
