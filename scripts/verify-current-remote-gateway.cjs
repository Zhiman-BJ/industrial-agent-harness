// Opt-in live diagnostic: exercises the same settings, Broker and Runtime used
// by Desktop/CLI. It performs no model inference and never terminates a sandbox.
const {
  createProjectRuntime,
  resolveProjectTask,
} = require('../packages/harness-core/src/index.cjs');
async function verifyCurrentGateway({
  settings,
  projectDir,
  domain,
  toolId,
  files,
  chatId,
  directory,
  approved = false,
  onProgress = () => {},
}) {
  if (approved !== true) throw Error('Explicit input upload and execution approval is required.');
  const service = await settings.check();
  onProgress('service', service);
  if (service.status !== 'connected') throw Error(service.reason || service.status);
  let binding = settings.project(projectDir, domain);
  if (!binding.snapshotId) {
    const review = await settings.review(projectDir, domain, files);
    binding = await settings.sync(projectDir, domain, review.id);
  } else await settings.ensureSynced(projectDir, domain);
  onProgress('snapshot', {
    remoteProjectId: binding.remoteProjectId,
    snapshotId: binding.snapshotId,
  });
  const registry = { capabilities: [], domains: [{ id: domain }], runtimePacks: [] };
  const bundle = createProjectRuntime({
    projectDir,
    domain,
    directory,
    registry,
    remoteSettings: settings,
  });
  const runtime = bundle.runtime.forSession(chatId);
  try {
    const state = await runtime.inspect();
    const resolved = resolveProjectTask(
      domain,
      { task: `Execute ${toolId}`, state },
      null,
      bundle.capabilities,
      {},
      [],
      registry.domains,
      [],
    );
    if (!resolved.scope.tools.includes(toolId))
      throw Error('Requested tool was not selected by the Broker.');
    onProgress('scope', { tools: resolved.scope.tools, stateId: state.id });
    const result = await runtime.execute(
      { toolId, inputs: {}, expectedStateId: state.id },
      { scope: resolved.scope, approval: true },
    );
    const session = await settings.session(projectDir, domain, chatId);
    const task = settings.task(projectDir, domain, chatId);
    onProgress('result', {
      action: result.action.status,
      verification: result.verification.status,
      diagnostics: result.action.diagnostics,
    });
    return {
      testedAt: new Date().toISOString(),
      mode: 'shared-harness-runtime-no-model-inference',
      endpoint: settings.configuration().url,
      chatId,
      binding,
      session,
      task,
      result,
    };
  } finally {
    await bundle.runtime.close();
  }
}
module.exports = { verifyCurrentGateway };
