const fs = require('node:fs');
const path = require('node:path');

// Add reviewed, version-pinned domain MCP providers here. Each declaration must
// list every canonical tool exposed by its server so scope selection stays bounded.
const servers = Object.freeze([]);

function listMcpServers(domain) {
  return servers.filter(item => !domain || item.domain === domain).map(({config, ...item}) => ({...item, enabledByDefault: true}));
}

function selectMcpServers(scope, disabledIds = [], registry = servers) {
  const disabled = new Set(disabledIds);
  return registry.filter(item => item.domain === scope.domain && !disabled.has(item.id) && item.toolIds.length > 0 && item.toolIds.every(id => scope.tools.includes(id)));
}

function writeMcpConfig(shareDir, selected) {
  const mcpServers = Object.fromEntries(selected.map(item => [item.id, item.config]));
  const file = path.join(shareDir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({mcpServers}, null, 2), {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return file;
}

module.exports = {listMcpServers, selectMcpServers, writeMcpConfig};
