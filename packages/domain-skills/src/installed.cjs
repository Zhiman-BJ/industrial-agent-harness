const fs = require('node:fs');
const path = require('node:path');
const { PackManager } = require('@industrial-agent-harness/pack-manager');
const { distributionDomain } = require('./distribution.cjs');
const staticCapabilities = require('@zhiman-bj/industrial-domain-packs').consumerMetadata()
  .capabilities;
const { loadDomainPacks } = require('./packs.cjs');
const staticSkills = require('./consumer.cjs');
const { listDomains, builtInDomains } = require('./domains.cjs');

function builtInPackDirectory(provider) {
  // Resolve deployed pnpm resources from the owning module's ancestors. A
  // release marker stops lookup before it can fall through to a source checkout.
  for (let directory = __dirname; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'domain-packs', provider.packDirectory);
    const exists = fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory();
    if (exists) return candidate;
    if (
      fs.existsSync(path.join(directory, 'HARNESS-PACKAGE.json')) ||
      path.dirname(directory) === directory
    )
      break;
  }
  return require('@zhiman-bj/industrial-domain-packs').sourceDirectory(
    provider.packId ||
      require('@zhiman-bj/industrial-domain-packs')
        .hostPacks()
        .find(item => item.provider.packDirectory === provider.packDirectory)?.id,
  );
}

function loadRegistry() {
  if (!process.env.INDUSTRIAL_HARNESS_PACK_STORE) {
    const providerPacks = loadDomainPacks();
    const capabilities = [
      ...staticCapabilities,
      ...providerPacks.flatMap(pack => pack.capabilities),
    ].filter(item => !distributionDomain || item.domain === distributionDomain);
    return {
      domains: listDomains(capabilities),
      capabilities,
      skills: staticSkills
        .listSkills()
        .map(item => ({ ...item, file: staticSkills.skillFile(item.id) })),
      providerPacks,
      runtimePacks: providerPacks
        .filter(pack => pack.runtime)
        .map(pack => ({
          id: pack.id,
          domain: pack.domain,
          version: pack.version,
          runtime: pack.runtime,
          directory: builtInPackDirectory(pack.provider),
          runtimeProtectedPaths: [require('@zhiman-bj/industrial-domain-packs').root],
        })),
    };
  }
  const manager = new PackManager();
  const bundles = manager
    .list()
    .filter(bundle => !distributionDomain || bundle.domain === distributionDomain);
  const packDomains = bundles
    .map(bundle => ({ id: bundle.domain, label: bundle.label, emoji: bundle.emoji }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const domains = [...builtInDomains(), ...packDomains];
  const capabilities = bundles.flatMap(bundle => bundle.capabilities);
  const skills = [
    ...staticSkills
      .listSkills()
      .filter(skill => skill.domain === '*')
      .map(skill => ({ ...skill, file: staticSkills.skillFile(skill.id) })),
    ...bundles.flatMap(bundle =>
      bundle.skills.map(skill => ({
        id: skill.id,
        domain: skill.domain,
        title: skill.title,
        enabledByDefault: true,
        ...(skill.external ? { external: skill.external } : {}),
        file: path.join(bundle.location, ...skill.file.split('/')),
      })),
    ),
  ];
  const providerPacks = bundles.flatMap(bundle =>
    bundle.providerPacks.map(pack => ({
      ...pack,
      provider: {
        ...pack.provider,
        installedDirectory: path.join(bundle.location, 'domain-packs', pack.provider.packDirectory),
      },
    })),
  );
  const ids = new Set();
  for (const domain of domains) {
    if (ids.has(domain.id)) throw Error('Duplicate installed Domain.');
    ids.add(domain.id);
  }
  for (const skill of skills)
    if (!fs.statSync(skill.file, { throwIfNoEntry: false })?.isFile())
      throw Error(`Missing installed Skill: ${skill.id}`);
  const runtimePacks = bundles.flatMap(bundle =>
    bundle.providerPacks
      .filter(pack => pack.runtime)
      .map(pack => ({
        id: pack.id,
        domain: pack.domain,
        version: pack.version,
        runtime: pack.runtime,
        managed: true,
        runtimeEnvironment: manager.runtimeAssets.environment(bundle.runtimeAssets),
        runtimeProtectedPaths: [manager.runtimeAssets.directory],
        directory: path.join(bundle.location, 'domain-packs', pack.provider.packDirectory),
      })),
  );
  return { domains, capabilities, skills, providerPacks, runtimePacks };
}

function installedSkills(domain) {
  return loadRegistry()
    .skills.filter(item => item.domain === '*' || !domain || item.domain === domain)
    .map(({ file, ...item }) => item);
}

function materializeInstalledSkills(scope, directory, environment = process.env) {
  if (!process.env.INDUSTRIAL_HARNESS_PACK_STORE)
    return staticSkills.materializeSkills(scope, directory, environment);
  const { materializeSkillDirectories } = require('./skill-resources.cjs');
  const { skills, providerPacks } = loadRegistry();
  return materializeSkillDirectories(
    scope.skills.map(id => {
      const item = skills.find(skill => skill.id === id);
      if (!item) throw Error(`Unknown installed Skill: ${id}`);
      let source = path.dirname(item.file),
        suffix;
      if (item.external) {
        const provider = providerPacks.find(
          pack => pack.id === item.external.providerPackId,
        )?.provider;
        if (!provider) throw Error('Skill requires its registered Domain Pack.');
        source = path.join(
          require('./pack-resources.cjs').resourceDirectory(provider, environment),
          ...item.external.resourcePath.split('/'),
        );
        suffix = staticSkills.integrationSuffix(item.external.nativeToolPrefix);
      }
      return { name: id.replace(/[^a-zA-Z0-9.-]/g, '-'), source, suffix };
    }),
    directory,
  );
}

module.exports = {
  builtInPackDirectory,
  loadRegistry,
  installedSkills,
  materializeInstalledSkills,
};
