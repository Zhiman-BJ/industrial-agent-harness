const crypto = require('node:crypto');

function resolve(request, registry, previous) {
  const {domain, stage, task} = request;
  if (typeof domain !== 'string' || typeof stage !== 'string' || typeof task !== 'string') throw Error('Domain, stage, and task are required.');
  const text = task.trim().toLowerCase();
  if (!text) throw Error('Describe the engineering task first.');
  const trace = [];
  const record = (level, event, detail) => trace.push({level, event, detail});
  const domainCapabilities = registry.filter(item => item.domain === domain);
  record('L0', 'domain.index', {domain, count: domainCapabilities.length});
  const candidates = domainCapabilities.filter(item => item.stages.includes(stage));
  record('L1', 'capability.index', {stage, candidates: candidates.map(item => ({id: item.id, title: item.title}))});
  const scored = candidates.map(item => ({item, hits: item.keywords.filter(word => text.includes(word.toLowerCase()))}));
  const selected = scored.filter(({hits}) => hits.length).sort((a, b) => b.hits.length - a.hits.length || b.item.priority - a.item.priority || a.item.id.localeCompare(b.item.id)).slice(0, 3);
  record('L1', 'capability.resolve', {selected: selected.map(({item, hits}) => ({id: item.id, reason: `matched: ${hits.join(', ')}`})), excluded: scored.filter(({hits}) => !hits.length).map(({item}) => ({id: item.id, reason: 'no task intent match'}))});
  const skills = [...new Set(selected.flatMap(({item}) => item.skills.map(skill => skill.id)))];
  const tools = [...new Set(selected.flatMap(({item}) => item.tools.map(tool => tool.id)))];
  const scope = {version: crypto.randomUUID(), domain, stage, capabilityIds: selected.map(({item}) => item.id), skills, tools};
  record('L2', 'scope.replace', {previous: previous?.version ?? null, current: scope.version, skills, tools});
  if (selected.length) record('L2', 'skill.batch', selected.flatMap(({item}) => item.skills.map(skill => ({capability: item.id, id: skill.id, summary: skill.summary}))));
  if (selected.length) record('L2', 'tool.scope', selected.flatMap(({item}) => item.tools.map(tool => ({capability: item.id, id: tool.id, summary: tool.summary}))));
  record('L3', 'detail.deferred', {skillReferences: skills.length, toolSchemas: tools.length, reason: 'Load only on selected capability/tool invocation.'});
  return {scope, trace, matches: selected.map(({item}) => ({id: item.id, title: item.title}))};
}

function discloseDetail(scope, registry, capabilityId) {
  if (!scope.capabilityIds.includes(capabilityId)) throw Error('Capability is outside the current scope.');
  const item = registry.find(entry => entry.id === capabilityId && entry.domain === scope.domain && entry.stages.includes(scope.stage));
  if (!item) throw Error('Capability is unavailable.');
  return {capability: item.id, skills: item.skills, tools: item.tools, verification: item.verification};
}

function assertToolAllowed(scope, toolId) {
  if (!scope || !scope.tools.includes(toolId)) throw Error(`Tool ${toolId} is outside the current scope.`);
}

module.exports = {resolve, discloseDetail, assertToolAllowed};
