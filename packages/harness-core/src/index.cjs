const { ChatStore, defaultChatDirectory, deriveChatTitle } = require('./chat-store.cjs');
const { createProjectRuntime, readProjectRecords } = require('./project-runtime.cjs');
const sessionResources = require('./session-resources.cjs');
const { availableMemoryBytes } = require('./available-memory.cjs');
const { resolve, resolveFromState } = require('@industrial-agent-harness/capability-broker');
const {
  capabilities,
  listDomains,
  listSkills,
} = require('@industrial-agent-harness/domain-skills');
const { listMcpServers, ExternalMcpRegistry } = require('@industrial-agent-harness/domain-mcp');
const {
  ResourceSettings,
  defaultResourceDirectory,
  effectiveResourcePolicy,
} = require('./resource-settings.cjs');

function resourceCatalog(domain, external = []) {
  return { skills: listSkills(domain), mcpServers: listMcpServers(domain, external) };
}
function runtimeCapabilities(registry, bundle) {
  return [
    ...registry.capabilities.filter(
      item => !bundle?.runtime.hostRuntimeOnly || item.domain !== bundle.runtime.domain,
    ),
    ...(bundle?.capabilities || []),
  ];
}

function effectiveCapabilities(registry, disabled = {}) {
  const disabledSkills = new Set(disabled.skills || []);
  const disabledMcp = new Set(disabled.mcpServers || []);
  // Resolve providers once per request so newly installed Packs remain visible.
  const disabledToolsByDomain = new Map();
  if (disabledMcp.size)
    for (const server of listMcpServers()) {
      if (!disabledMcp.has(server.id)) continue;
      if (!disabledToolsByDomain.has(server.domain))
        disabledToolsByDomain.set(server.domain, new Set());
      for (const id of server.toolIds || []) disabledToolsByDomain.get(server.domain).add(id);
    }
  return registry.map(item => {
    const disabledTools = disabledToolsByDomain.get(item.domain);
    return {
      ...item,
      skills: item.skills.filter(skill => !disabledSkills.has(skill.id)),
      tools: item.tools.filter(tool => !disabledTools?.has(tool.id)),
    };
  });
}

function resolveProjectTask(
  domain,
  request,
  previous,
  registry = capabilities,
  disabled = {},
  external = [],
  validDomains = listDomains(registry),
) {
  if (!validDomains.some(item => item.id === domain)) throw Error('Choose a valid project domain.');
  if (request?.domain && request.domain !== domain)
    throw Error(`This project is fixed to the ${domain} domain.`);
  const resolver = request?.state ? resolveFromState : resolve;
  const result = resolver(
    { ...request, domain },
    effectiveCapabilities(registry, disabled),
    previous,
  );
  const enabledExternal = external.filter(
    server => !(disabled.mcpServers || []).includes(server.id),
  );
  // Registered host services enter the shared Runtime approval/action boundary;
  // their observations never establish engineering acceptance.
  const extensions = enabledExternal;
  if (extensions.length) {
    const tools = extensions.flatMap(server => server.tools.map(tool => tool.id));
    result.scope.tools = [...new Set([...result.scope.tools, ...tools])];
    const replaced = result.trace.find(row => row.event === 'scope.replace');
    if (replaced) replaced.detail.tools = result.scope.tools;
    result.trace.push({
      level: 'L0',
      event: 'mcp.external.index',
      detail: extensions.map(server => ({
        id: server.id,
        title: server.title,
        tools: server.tools.length,
        scope: 'user-registered host service',
      })),
    });
    result.trace.push({
      level: 'L2',
      event: 'mcp.external.scope',
      detail: {
        tools,
        reason:
          'Explicitly registered general services are available across project domains; details remain deferred.',
      },
    });
    result.trace.push({
      level: 'L3',
      event: 'mcp.external.deferred',
      detail: { providers: extensions.length, toolSchemas: tools.length },
    });
  }
  result.trace.push({
    level: 'L0',
    event: 'resource.policy',
    detail: {
      disabledSkills: disabled.skills || [],
      disabledMcpServers: disabled.mcpServers || [],
    },
  });
  return result;
}

module.exports = {
  createProjectRuntime,
  readProjectRecords,
  runtimeCapabilities,
  RemoteSettings: require('./remote-settings.cjs').RemoteSettings,
  ...sessionResources,
  availableMemoryBytes,
  ChatStore,
  defaultChatDirectory,
  deriveChatTitle,
  resolveProjectTask,
  resourceCatalog,
  effectiveCapabilities,
  ResourceSettings,
  defaultResourceDirectory,
  effectiveResourcePolicy,
  ExternalMcpRegistry,
};
