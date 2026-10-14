const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const { executeTask, runtimeFiles } = require('@industrial-agent-harness/domain-runtime');
const { publicServer } = require('./external-registry.cjs');

function publicTool(descriptor, metadata = {}, guide = {}) {
  return {
    id: descriptor.id,
    title: descriptor.title || guide.title || metadata.title || metadata.name || descriptor.id,
    description:
      descriptor.description ||
      guide.description ||
      guide.summary ||
      metadata.description ||
      metadata.summary ||
      '',
    ...(descriptor.risk ? { risk: descriptor.risk } : {}),
  };
}

function displayTools(tools, capabilities = []) {
  const metadata = new Map(
    capabilities.flatMap(item => item.tools || []).map(tool => [tool.id, tool]),
  );
  return tools.map(tool => ({
    ...tool,
    guide: { ...metadata.get(tool.descriptor?.id), ...tool.guide },
  }));
}

function runtimeTools(pack, registry, options) {
  const bundle = options.runtimeBundle;
  if (bundle?.runtime.hostRuntimeOnly && bundle.runtime.domain === pack.domain)
    return bundle.runtime.remoteTools.map(descriptor => ({ descriptor }));
  if (bundle?.packId === pack.id && bundle.domainTools)
    return displayTools(bundle.domainTools, bundle.capabilities);
  const runtimePack = (registry.runtimePacks || []).find(item => item.id === pack.id);
  if (!runtimePack)
    throw Error(`Cannot load registered tool provider ${pack.provider.id}: missing Runtime Pack.`);
  try {
    const root = fs.realpathSync(runtimePack.directory);
    const entry = fs.realpathSync(path.join(root, runtimePack.runtime.entry));
    if (!entry.startsWith(root + path.sep)) throw Error('Runtime entry escaped the verified Pack.');
    // Match the project Runtime loader after a verified same-version repair.
    // Existing plugin instances keep their original closures and execution state.
    for (const cached of Object.keys(require.cache))
      if (cached.startsWith(root + path.sep)) delete require.cache[cached];
    // Trusted Pack factories construct descriptors and deferred execution functions.
    // Catalog reads never inspect a project, start a backend, or execute a tool.
    const plugin = require(entry).createRuntimePlugin({
      environment: { ...(options.environment || process.env), ...runtimePack.runtimeEnvironment },
      managed: Boolean(runtimePack.managed),
      runtimeApi: { executeTask, runtimeFiles },
    });
    if (!Array.isArray(plugin.tools)) throw Error('Runtime Pack did not register tools.');
    return displayTools(plugin.tools, plugin.capabilities);
  } catch (error) {
    throw Error(`Cannot load registered tool provider ${pack.provider.id}: ${error.message}`, {
      cause: error,
    });
  }
}

function listToolProviders(domain, external = [], options = {}) {
  const registry = options.registry || loadRegistry();
  return [
    ...(registry.providerPacks || [])
      .filter(pack => !domain || pack.provider.domain === domain)
      .map(pack => {
        const declared = pack.provider.tools;
        const provider = { ...pack.provider };
        for (const key of ['config', 'tools', 'sourceFiles', 'installedDirectory'])
          delete provider[key];
        const metadata = new Map((declared || []).map(tool => [tool.id, tool]));
        const hasRuntime =
          provider.transport === 'runtime' ||
          (registry.runtimePacks || []).some(item => item.id === pack.id) ||
          options.runtimeBundle?.packId === pack.id;
        let catalogError;
        let tools;
        try {
          tools = hasRuntime
            ? runtimeTools(pack, registry, options).map(tool => {
                if (!tool.descriptor?.id)
                  throw Error(`Invalid Runtime tool in provider ${provider.id}.`);
                return publicTool(tool.descriptor, metadata.get(tool.descriptor.id), tool.guide);
              })
            : (declared || []).map(tool => publicTool(tool, tool));
          if (new Set(tools.map(tool => tool.id)).size !== tools.length)
            throw Error(`Duplicate registered tool in provider ${provider.id}.`);
        } catch {
          // One unavailable Pack must not hide the other providers. Do not expose
          // factory exceptions, which can contain private environment values.
          tools = [];
          catalogError = 'Could not load this tool provider. Check Runtime diagnostics.';
        }
        const standaloneMcp =
          hasRuntime && provider.transport !== 'runtime'
            ? {
                transport: provider.transport || 'stdio',
                tools: (declared || []).map(tool => publicTool(tool, tool)),
              }
            : undefined;
        return {
          ...provider,
          transport: hasRuntime ? 'runtime' : provider.transport || 'stdio',
          enabledByDefault: true,
          toolIds: tools.map(tool => tool.id),
          // A provider policy also covers declared tools that its current profile
          // cannot register. Keep them out of the displayed active tool count.
          declaredToolIds: (declared || []).map(tool => tool.id),
          tools,
          catalogSource: hasRuntime ? 'runtime-descriptors' : 'provider-manifest',
          ...(standaloneMcp ? { standaloneMcp } : {}),
          ...(catalogError ? { catalogError } : {}),
        };
      }),
    ...external.map(server => ({
      ...publicServer(server),
      toolIds: server.tools.map(tool => tool.id),
      tools: server.tools.map(tool => publicTool(tool, tool)),
      catalogSource: 'external-discovery',
    })),
  ];
}

module.exports = { listToolProviders };
