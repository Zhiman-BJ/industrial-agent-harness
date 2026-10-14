const fs = require('node:fs');
const path = require('node:path');
const { distributionDomain } = require('./distribution.cjs');

// Only repository-owned declarations are loaded. Project files cannot add launch commands.
function loadDomainPacks() {
  const packs = require('@zhiman-bj/industrial-domain-packs').hostPacks();
  const ids = new Set();
  const toolIds = new Set();
  const capabilityIds = new Set();
  const providerIds = new Set();
  for (const pack of packs) {
    if (
      pack.schemaVersion !== 1 ||
      !pack.id ||
      ids.has(pack.id) ||
      !pack.domain ||
      !pack.version ||
      pack.provider?.version !== pack.version ||
      pack.provider?.domain !== pack.domain ||
      !['gateway', 'runtime'].includes(pack.provider?.transport)
    )
      throw Error('Invalid repository Domain Pack declaration.');
    if (
      !/^[a-z0-9][a-z0-9.-]*$/.test(pack.provider.id) ||
      providerIds.has(pack.provider.id) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(pack.provider.packDirectory) ||
      (pack.provider.transport !== 'runtime' &&
        !pack.provider.backend &&
        (!/^[A-Z][A-Z0-9_]*$/.test(pack.provider.directoryEnv) ||
          !/^[A-Z][A-Z0-9_]*$/.test(pack.provider.pythonEnv))) ||
      !/^[a-f0-9]{64}$/.test(pack.provider.sourceSha256) ||
      !Array.isArray(pack.provider.tools) ||
      !Array.isArray(pack.capabilities)
    )
      throw Error('Invalid Domain Pack provider metadata.');
    if (pack.provider.transport === 'runtime' && (!pack.runtime || pack.provider.backend))
      throw Error(
        'Host runtime providers require a runtime entry and cannot launch an MCP backend.',
      );
    if (pack.provider.transport === 'runtime' && !pack.provider.sourceFiles)
      throw Error('Host runtime providers require pinned source resources.');
    if (pack.provider.transport === 'gateway')
      require('@zhiman-bj/industrial-domain-packs').gatewayAdapter(pack.provider);
    if (pack.provider.sourceFiles) {
      const safePath = file =>
        typeof file === 'string' &&
        /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(file) &&
        !file.split('/').some(part => part === '.' || part === '..');
      const roots = pack.provider.resourceRoots;
      if (
        !Array.isArray(roots) ||
        !roots.length ||
        roots.some(file => !safePath(file)) ||
        roots.some((file, index) =>
          roots.some(
            (other, otherIndex) =>
              otherIndex !== index && (file === other || file.startsWith(other + '/')),
          ),
        ) ||
        !Object.keys(pack.provider.sourceFiles).length ||
        Object.entries(pack.provider.sourceFiles).some(
          ([file, hash]) =>
            !safePath(file) ||
            !roots.some(root => file.startsWith(root + '/')) ||
            !/^[a-f0-9]{64}$/.test(hash),
        )
      )
        throw Error('Invalid pinned provider resource inventory.');
    }
    if (
      pack.runtime &&
      (typeof pack.runtime.entry !== 'string' ||
        !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\.cjs$/.test(pack.runtime.entry) ||
        pack.runtime.entry.split('/').some(part => part === '.' || part === '..'))
    )
      throw Error('Invalid Domain runtime entry.');
    ids.add(pack.id);
    providerIds.add(pack.provider.id);
    const declared = new Map();
    for (const tool of pack.provider.tools) {
      if (
        !tool.id ||
        !tool.name ||
        toolIds.has(tool.id) ||
        declared.has(tool.id) ||
        !['read-only', 'mutating'].includes(tool.risk) ||
        (tool.risk === 'mutating' && !tool.verification?.length)
      )
        throw Error('Invalid Domain Pack tool descriptor.');
      declared.set(tool.id, tool);
      toolIds.add(tool.id);
    }
    if (new Set(pack.provider.tools.map(tool => tool.name)).size !== declared.size)
      throw Error('Duplicate upstream MCP tool name.');
    for (const capability of pack.capabilities) {
      if (
        capability.domain !== pack.domain ||
        !capability.id ||
        capabilityIds.has(capability.id) ||
        !capability.keywords?.length ||
        !Array.isArray(capability.tools) || // skills-only capabilities carry knowledge, not tools
        capability.tools.some(
          tool => JSON.stringify(tool) !== JSON.stringify(declared.get(tool.id)),
        )
      )
        throw Error('Capability does not match its Domain Pack tool declarations.');
      capabilityIds.add(capability.id);
    }
  }
  return packs.filter(pack => !distributionDomain || pack.domain === distributionDomain);
}
module.exports = { loadDomainPacks };
