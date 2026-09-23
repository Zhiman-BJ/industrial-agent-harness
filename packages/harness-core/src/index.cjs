const {resolve} = require('@industrial-agent-harness/capability-broker');
const {capabilities, listDomains, listSkills} = require('@industrial-agent-harness/domain-skills');
const {listMcpServers} = require('@industrial-agent-harness/domain-mcp');

function resourceCatalog(domain) {return {skills: listSkills(domain), mcpServers: listMcpServers(domain)};}

function effectiveCapabilities(registry, disabled = {}) {
  const disabledSkills = new Set(disabled.skills || []);
  const disabledMcp = new Set(disabled.mcpServers || []);
  return registry.map(item => {
    const mcpTools = new Set(listMcpServers(item.domain).filter(server => disabledMcp.has(server.id)).flatMap(server => server.toolIds || []));
    return {...item, skills: item.skills.filter(skill => !disabledSkills.has(skill.id)), tools: item.tools.filter(tool => !mcpTools.has(tool.id))};
  });
}

function resolveProjectTask(domain, request, previous, registry = capabilities, disabled = {}) {
  if (!listDomains(registry).some(item => item.id === domain)) throw Error('Choose a valid project domain.');
  if (request?.domain && request.domain !== domain) throw Error(`This project is fixed to the ${domain} domain.`);
  const result = resolve({...request, domain}, effectiveCapabilities(registry, disabled), previous);
  result.trace.push({level: 'L0', event: 'resource.policy', detail: {disabledSkills: disabled.skills || [], disabledMcpServers: disabled.mcpServers || []}});
  return result;
}

module.exports = {resolveProjectTask, resourceCatalog, effectiveCapabilities};
