const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const { gatewayConfig, providerRuntime } = require('./gateway.cjs');
const { ExternalMcpRegistry, publicServer } = require('./external-registry.cjs');
const { writeExternalGateway } = require('./external-gateway.cjs');
const { hash, externalSecrets } = require('./external-client.cjs');
const { listToolProviders } = require('./tool-providers.cjs');

function servers() {
  return loadRegistry()
    .providerPacks.filter(pack => pack.provider.transport !== 'runtime')
    .map(pack => ({
      ...pack.provider,
      toolIds: pack.provider.tools.map(tool => tool.id),
    }));
}

function listMcpServers(domain, external = []) {
  return [
    ...servers()
      .filter(item => !domain || item.domain === domain)
      .map(({ config, tools, sourceFiles, ...item }) => ({ ...item, enabledByDefault: true })),
    ...external.map(server => ({
      ...publicServer(server),
      toolIds: server.tools.map(tool => tool.id),
    })),
  ];
}

function selectMcpServers(scope, disabledIds = [], registry = servers(), external = []) {
  const disabled = new Set(disabledIds);
  const allowedTools = new Set(scope.tools);
  return registry
    .filter(
      item =>
        item.domain === scope.domain &&
        item.transport !== 'runtime' &&
        !disabled.has(item.id) &&
        item.toolIds.length > 0 &&
        (item.transport === 'gateway'
          ? item.toolIds.some(id => allowedTools.has(id))
          : item.toolIds.every(id => allowedTools.has(id))),
    )
    .map(item =>
      item.transport === 'gateway'
        ? { ...item, allowedToolIds: item.toolIds.filter(id => allowedTools.has(id)) }
        : item,
    )
    .concat(
      external
        .filter(
          server =>
            !disabled.has(server.id) && server.tools.some(tool => allowedTools.has(tool.id)),
        )
        .map(server => ({
          ...server,
          transport: 'external',
          allowedToolIds: server.tools
            .filter(tool => allowedTools.has(tool.id))
            .map(tool => tool.id),
        })),
    );
}

function writeMcpConfig(shareDir, selected, options = {}) {
  const mcpServers = Object.fromEntries(
    selected
      .filter(item => item.transport !== 'external' && item.transport !== 'runtime')
      .map(item => [
        item.id,
        item.transport === 'gateway'
          ? gatewayConfig(shareDir, item, options.projectDir, options.environment, options)
          : item.config,
      ]),
  );
  const external = selected.filter(item => item.transport === 'external');
  if (external.length)
    mcpServers['harness.external'] = writeExternalGateway(
      shareDir,
      external,
      options.projectDir,
      options.environment,
    );
  const file = path.join(shareDir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function selectedRuntimeKey(scope, disabledIds, environment, external = []) {
  return selectMcpServers(scope, disabledIds, undefined, external).map(provider => ({
    id: provider.id,
    version: provider.version,
    allowedToolIds: provider.allowedToolIds,
    ...(provider.transport === 'external'
      ? {
          revision: provider.revision,
          identity: hash({
            config: provider.config,
            references: Object.values({
              ...provider.config.envRefs,
              ...provider.config.headerEnv,
            }).map(name => [name, (environment || process.env)[name]]),
            surfaceHash: provider.surfaceHash,
          }),
        }
      : provider.transport === 'gateway'
        ? providerRuntime(provider, environment)
        : { config: provider.config }),
  }));
}
module.exports = {
  ...require('./external-runtime.cjs'),
  listMcpServers,
  listToolProviders,
  selectMcpServers,
  writeMcpConfig,
  selectedRuntimeKey,
  ExternalMcpRegistry,
  externalSecrets,
};
