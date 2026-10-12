const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const {
  IndustrialRuntime,
  createWorkspacePlugin,
  executeTask,
  openToolSession,
  runtimeFiles,
} = require('@industrial-agent-harness/domain-runtime');
const {
  ExternalMcpRegistry,
  createExternalRuntimePlugin,
} = require('@industrial-agent-harness/domain-mcp');
const { RemoteSettings } = require('./remote-settings.cjs');
const { createRemoteRuntime } = require('@industrial-agent-harness/domain-runtime');
const { defaultResourceDirectory } = require('./resource-settings.cjs');

function createProjectRuntime({
  projectDir,
  domain,
  directory,
  environment = process.env,
  registry,
  connectionStore,
  remoteSettings = new RemoteSettings({
    directory: defaultResourceDirectory(environment),
    environment,
  }),
  onRemoteStatus,
}) {
  const execution = remoteSettings.project(projectDir, domain);
  registry ||= loadRegistry(environment, {
    projectDir,
    remote: execution.location === 'remote',
    connectionStore,
  });
  if (execution.location === 'remote')
    return createRemoteRuntime({
      settings: remoteSettings,
      projectDir,
      domain,
      directory,
      registry,
      connectionStore,
      onStatus: onRemoteStatus,
    });
  const remoteRevision = remoteSettings.identity();
  const packs = (registry.runtimePacks || []).filter(pack => pack.domain === domain);
  if (packs.length > 1) throw Error('A project must resolve exactly one trusted Domain Runtime.');
  const pack = packs[0];
  const root = pack && fs.realpathSync(pack.directory);
  const entry = pack && fs.realpathSync(path.join(root, pack.runtime.entry));
  if (entry && !entry.startsWith(root + path.sep))
    throw Error('Runtime entry escaped the verified Pack.');
  // A verified same-version repair can replace entry/helpers at the same
  // pathname. New project runtimes must execute the current verified bytes.
  // Existing runtime instances and shared Core/npm modules remain untouched.
  if (root)
    for (const cached of Object.keys(require.cache))
      if (cached.startsWith(root + path.sep)) delete require.cache[cached];
  const runtimeView = pack?.runtimeEnvironmentResolver?.({ projectDir });
  const environmentIdentity = runtimeView?.identity;
  const configurationIdentity = runtimeView?.configurationIdentity || environmentIdentity;
  const environmentCurrent = () => {
    const current = pack?.runtimeEnvironmentResolver?.({ projectDir });
    return (
      !current || (current.configurationIdentity || current.identity) === configurationIdentity
    );
  };
  const effectiveEnvironment = runtimeView?.environment || pack?.runtimeEnvironment || {};
  const allowedTools =
    runtimeView && !runtimeView.legacy
      ? new Set(runtimeView.executableToolIds || runtimeView.readyToolIds)
      : null;
  const plugin = entry
    ? require(entry).createRuntimePlugin({
        environment: { ...environment, ...effectiveEnvironment },
        managed: Boolean(pack.managed),
        runtimeApi: {
          executeTask,
          openToolSession,
          runtimeFiles,
          resolveDependency: pack.resolveDependency,
        },
      })
    : {};
  if (allowedTools) {
    plugin.tools = (plugin.tools || []).filter(tool => allowedTools.has(tool.descriptor.id));
    plugin.capabilities = (plugin.capabilities || [])
      .map(capability => ({
        ...capability,
        tools: capability.tools.filter(tool => allowedTools.has(tool.id)),
      }))
      .filter(capability => capability.tools.length);
  }
  for (const tool of plugin.tools || []) {
    const execute = tool.execute;
    tool.execute = async context => {
      const release = pack?.acquireRuntimeUse?.();
      try {
        if (!environmentCurrent())
          throw Error('Runtime environment changed. Refresh the project before executing.');
        await pack?.validateRuntimeEnvironment?.({ projectDir, signal: context.signal });
        const result = await execute(context);
        // Native failure/cancellation may already contain receipts and cleanup
        // evidence. Never throw them away before the canonical collector runs.
        try {
          if (result.executionSucceeded === true && !context.signal?.aborted)
            await pack?.validateRuntimeEnvironment?.({ projectDir });
          if (!environmentCurrent())
            throw Error('Runtime environment changed during execution. Check it before retrying.');
          if (context.signal?.aborted)
            throw Error('Action was cancelled; retained output does not establish acceptance.');
        } catch (error) {
          return {
            ...result,
            executionSucceeded: false,
            executionVeto: {
              code: 'RUNTIME_VALIDATION_VETO',
              reason: String(error.message).slice(0, 4096),
            },
            diagnostics: [...(result.diagnostics || []), String(error.message)],
          };
        }
        return result;
      } finally {
        release?.();
      }
    };
  }
  const protectedPaths = [
    root,
    ...(pack?.runtimeProtectedPaths || []),
    directory,
    ...(plugin.protectedPaths || []),
    ...(plugin.workspaceProtectedPaths?.(projectDir) || []),
  ].filter(Boolean);
  for (const relative of runtimeFiles.validateInputRules(plugin.workspaceInputs)) {
    protectedPaths.push(path.join(fs.realpathSync(projectDir), ...relative.split('/')));
  }
  let stateDiagnostics = [];
  const workspace = createWorkspacePlugin({
    domain,
    environment,
    protectedPaths,
    inputRules: plugin.workspaceInputs,
    inspectionDiagnostics: () => stateDiagnostics,
  });
  // Workspace scripts keep their existing execution rules, while an environment
  // selection cannot change under any active project action.
  for (const tool of workspace.tools) {
    const execute = tool.execute;
    tool.execute = async context => {
      const release = pack?.acquireRuntimeUse?.();
      try {
        return await execute(context);
      } finally {
        release?.();
      }
    };
  }
  const externalRegistry = new ExternalMcpRegistry(defaultResourceDirectory(environment));
  const externalServers = externalRegistry.records();
  const externalRevision = JSON.stringify(
    externalServers.map(server => [server.id, server.revision]),
  );
  const external = createExternalRuntimePlugin({
    servers: externalServers,
    environment,
    registry: externalRegistry,
  });
  const matches = () => !plugin.matchesProject || plugin.matchesProject(projectDir);
  const stateProvider = async context => {
    const common = await workspace.stateProvider(context);
    if (environmentIdentity)
      common.inputHashes['runtime-identity/environment'] = pack.runtimeEnvironmentResolver({
        projectDir,
      }).identity;
    if (!plugin.stateProvider || !matches()) return common;
    let observed;
    try {
      observed = await plugin.stateProvider(context);
      stateDiagnostics = [];
    } catch (error) {
      stateDiagnostics = [String(error.message).slice(0, 4096)];
      return common;
    }
    return { ...observed, inputHashes: { ...common.inputHashes, ...observed.inputHashes } };
  };
  const runtime = new IndustrialRuntime(projectDir, domain, {
    directory,
    stateProvider,
    tools: [...workspace.tools, ...(plugin.tools || []), ...external.tools],
    verifiers: { ...workspace.verifiers, ...(plugin.verifiers || {}), ...external.verifiers },
    dispose: () => Promise.all([external.dispose(), plugin.dispose?.()]),
    releaseOwner: ownerId =>
      Promise.all([external.releaseOwner(ownerId), plugin.releaseOwner?.(ownerId)]),
  });
  protectedPaths.push(runtime.directory);
  return {
    runtime,
    configurationCurrent: () =>
      environmentCurrent() &&
      remoteSettings.project(projectDir, domain).location === 'local' &&
      remoteSettings.identity() === remoteRevision &&
      externalRevision ===
        JSON.stringify(externalRegistry.records().map(server => [server.id, server.revision])),
    get stateDiagnostics() {
      return stateDiagnostics;
    },
    get capabilities() {
      return [...workspace.capabilities, ...(matches() ? plugin.capabilities || [] : [])];
    },
    protectedPaths: [...protectedPaths, runtime.directory],
    packId: pack?.id || 'project-workspace',
    packVersion: pack?.version || '1.0.0',
  };
}
function readProjectRecords({
  projectDir,
  domain,
  directory,
  environment = process.env,
  remoteSettings = new RemoteSettings({
    directory: defaultResourceDirectory(environment),
    environment,
  }),
}) {
  const execution = remoteSettings.project(projectDir, domain);
  if (execution.location === 'remote') {
    if (!execution.canonicalProjectId) return null;
    return IndustrialRuntime.openRecords(projectDir, domain, {
      directory: path.join(
        directory || path.join(remoteSettings.directory, 'core'),
        'remote-workspaces',
      ),
      projectRef: { schemaVersion: '1', projectId: execution.canonicalProjectId, domain },
    });
  }
  return IndustrialRuntime.openRecords(projectDir, domain, { directory });
}
module.exports = { createProjectRuntime, readProjectRecords };
