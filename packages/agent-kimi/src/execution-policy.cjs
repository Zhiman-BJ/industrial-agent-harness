// Derive this turn's resources; leave saved user preferences intact.
// Protected industrial sessions keep external MCP behind the audited host
// Runtime. Application plugins pass only when they explicitly declare
// protectedSafe (host-side execution, enable-is-authorization, and every call
// recorded through the diagnostics log sink); any other enabled plugin is
// excluded and surfaces as a structured resources-filtered event.
function executionPolicy(runtime, plugins, protectedIndustrial, externalRuntimeIds = []) {
  if (!protectedIndustrial) return { runtime, plugins, excluded: null };
  const disabled = new Set(runtime.disabledMcpServers || []);
  const allowed = new Set(externalRuntimeIds);
  const hosted = (runtime.externalServers || []).filter(server =>
    server.tools.every(tool => allowed.has(tool.id)),
  );
  const enabledPlugins = (plugins || []).filter(plugin => plugin?.enabled?.() === true);
  const safePlugins = enabledPlugins.filter(plugin => plugin.protectedSafe === true);
  const excluded = {
    externalMcp: (runtime.externalServers || [])
      .filter(server => !disabled.has(server.id))
      .filter(server => !hosted.includes(server))
      .map(server => server.id),
    plugins: enabledPlugins
      .filter(plugin => !safePlugins.includes(plugin))
      .map(plugin => plugin.name),
  };
  return {
    runtime: { ...runtime, externalServers: hosted, hostRuntimeExternal: true },
    plugins: safePlugins,
    excluded: excluded.externalMcp.length || excluded.plugins.length ? excluded : null,
  };
}
module.exports = { executionPolicy };
