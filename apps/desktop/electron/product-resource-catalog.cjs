const { isDomainOffered } = require('@industrial-agent-harness/domain-skills');

// Product settings only: keep the complete registry for legacy runtime policy.
function productResourceCatalog(catalog) {
  return {
    ...catalog,
    skills: catalog.skills.filter(item => isDomainOffered(item.domain)),
    mcpServers: catalog.mcpServers.filter(item => isDomainOffered(item.domain)),
  };
}

module.exports = { productResourceCatalog };
