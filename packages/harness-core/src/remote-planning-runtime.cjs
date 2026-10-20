const fs = require('node:fs');
const path = require('node:path');
const {
  IndustrialRuntime,
  createWorkspacePlugin,
  createRemoteRuntime,
  runtimeFiles,
  hash,
} = require('@industrial-agent-harness/domain-runtime');

const PLAN = 'project.remote.plan';
const PREPARE = 'project.remote.prepare';
const VERSION = '1.0.0';
const { releasePreparedSession } = require('./remote-preparation-session.cjs');

function approvalText(plan) {
  const text =
    `Destination / 目标: ${plan.destination}\nFiles / 文件 (${plan.files.length}, ${plan.totalBytes} bytes):\n` +
    plan.files.map(file => `${file.path} (${file.sizeBytes} bytes)`).join('\n') +
    `\nManifest SHA-256: ${plan.manifestDigest}\n` +
    `Allowed tools for this task, subject to live availability / 本次任务允许的工具，以环境实际可用项为准: ${plan.tools.join(', ')}\n` +
    (plan.remember
      ? 'Automatically sync future changes to these exact files / 自动同步以上文件的后续修改。'
      : 'Upload this version only / 仅上传本次版本。') +
    '\nAdded files or tools require another batch approval / 新增文件或工具需再次批量确认。';
  if (Buffer.byteLength(text) > 32768)
    throw Error(
      'The complete task approval exceeds the display limit. Select a smaller task file/tool scope.',
    );
  return text;
}

// Planning is local. Only an approved, immutable task plan can activate a remote
// transport; the transport and planner share the same canonical Runtime store.
function createRemotePlanningRuntime(options) {
  const { settings, domain, directory, registry, onStatus } = options;
  const projectDir = fs.realpathSync(options.projectDir);
  let binding = settings.project(projectDir, domain);
  if (!binding.canonicalProjectId)
    binding = settings.update(projectDir, domain, {
      canonicalProjectId: hash(`${projectDir}\0${domain}`),
    });
  const projectId = binding.canonicalProjectId;
  let identity = settings.identity();
  let remote;
  let closed = false;
  let disposal;
  const plans = new Map();
  const grants = new Map();
  const executing = new Map();
  const sessions = new Map();
  const protectedPaths = [
    directory,
    settings.directory,
    path.join(projectDir, 'remote-results'),
  ].filter(Boolean);
  const local = createWorkspacePlugin({
    domain,
    environment: settings.environment,
    protectedPaths,
  });
  local.tools = local.tools.filter(tool => tool.descriptor.id !== 'project.task.run');
  const workspaceCapabilities = local.capabilities.map(capability => ({
    ...capability,
    tools: capability.tools.filter(tool =>
      local.tools.some(item => item.descriptor.id === tool.id),
    ),
  }));
  const preparationCapability = {
    id: 'project.remote',
    domain,
    title: 'Prepare remote task',
    stages: [],
    alwaysAvailable: true,
    priority: 0,
    keywords: [],
    skills: [],
    verification: [],
    tools: [
      { id: PLAN, summary: 'Select all task inputs and tools for one batch approval.' },
      {
        id: PREPARE,
        summary: 'Approve the task plan once, upload and check the live remote environment.',
      },
    ],
  };
  const assertCurrent = () => {
    const current = settings.project(projectDir, domain);
    if (
      closed ||
      current.location !== 'remote' ||
      current.canonicalProjectId !== projectId ||
      settings.identity() !== identity
    )
      throw Error('Remote configuration changed. Refresh this chat before preparing the task.');
  };
  const receipt = (action, value) => {
    const file = path.join(
      runtimeFiles.runDirectory(projectDir, action.id),
      'remote-preparation.json',
    );
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    return {
      executionSucceeded: true,
      artifacts: [{ kind: 'remote.preparation', file }],
      diagnostics: [],
      toolVersion: VERSION,
    };
  };
  const planFor = (reviewId, ownerId, taskId) => {
    const plan = plans.get(reviewId);
    settings.approvalReview(projectDir, domain, reviewId);
    if (!plan || plan.ownerId !== ownerId || plan.taskId !== taskId)
      throw Error('This preparation plan belongs to another task. Plan the current task again.');
    return plan;
  };
  const loadRemote = async (chatId, signal, plan) => {
    signal.throwIfAborted();
    if (remote) await remote.close();
    remote = undefined;
    const current = settings.project(projectDir, domain);
    if (current.canonicalProjectId !== projectId || current.gatewayContract !== 'mcp-v1')
      throw Error('The remote project identity or protocol changed. Reopen this project.');
    const candidate = createRemoteRuntime({
      settings,
      projectDir,
      domain,
      directory,
      registry,
      onStatus,
      workspaceRuntime: workspace,
      workspaceCapabilities: [...workspaceCapabilities, preparationCapability],
      prepareInputs: ({ signal: inputSignal }) =>
        settings.ensurePrepared(projectDir, domain, { signal: inputSignal }),
    }).runtime;
    const preparationBinding = settings.sessionBinding(projectDir, domain, chatId);
    const context = candidate.context(chatId);
    context.controller = new AbortController();
    const abort = () => context.controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      let discoveryError;
      try {
        signal.throwIfAborted();
        await candidate.inspect(context);
        signal.throwIfAborted();
        const activeTools = plan.tools.filter(id =>
          candidate.remoteTools.some(tool => tool.id === id),
        );
        if (
          candidate.inventory?.capabilitySnapshotHash !== plan.capabilitySnapshotHash ||
          !activeTools.length ||
          (plan.explicitTools && activeTools.length !== plan.tools.length)
        )
          throw Error(
            'Remote capabilities changed. Review one updated task plan before continuing.',
          );
      } catch (error) {
        discoveryError = error;
      }
      // Discovery can acquire the single available sandbox without creating an
      // invocation journal. Confirm its release even if discovery was cancelled.
      try {
        await releasePreparedSession(settings, projectDir, domain, chatId, {
          expectedClientSessionId: preparationBinding.clientSessionId,
        });
      } catch (error) {
        throw Error(
          [discoveryError?.message, 'Remote preparation cleanup: ' + error.message]
            .filter(Boolean)
            .join(' '),
          { cause: error },
        );
      }
      if (discoveryError) throw discoveryError;
      signal.throwIfAborted();
      await context.client.close();
      context.client = settings.sessionClient(projectDir, domain, chatId);
      // Only the reviewed tools enter the Broker scope, even when discovery
      // returns more tools from the active Pack.
      remote = candidate;
      return candidate;
    } catch (error) {
      await candidate.close().catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      context.controller = null;
    }
  };
  const preparationTools = [
    {
      descriptor: {
        schemaVersion: '1',
        id: PLAN,
        version: VERSION,
        risk: 'read-only',
        verification: [],
      },
      guide: {
        inputs: {
          files: ['exact/project/input'],
          tools: ['remote.tool.id (optional subset)'],
          remember: true,
        },
        description:
          'Chat and inspect/edit local files first. Select the complete task input and dependency file list using project files and trusted Pack guidance. Create missing inputs locally first. This read-only step returns an immutable plan artifact with reviewId, destination, all files and named remote tools. No files are uploaded. Then call project.remote.prepare with reviewId for ONE batch approval. Remember defaults true: only these exact approved paths may refresh automatically; extra files/tools require a new combined plan. Never use local project.task.run for a remote task.',
      },
      execute: async ({ inputs, action, signal, ownerId }) => {
        assertCurrent();
        const review = await settings.review(projectDir, domain, inputs.files, {
          remember: inputs.remember ?? true,
          signal,
        });
        for (const file of review.files)
          runtimeFiles.projectFile(projectDir, file.path, protectedPaths);
        // The first successful check pins the configured service identity.
        identity = settings.identity();
        const client = settings.client({}, { signal, identity });
        let info;
        try {
          info = await client.info({ signal });
        } finally {
          await client.close();
        }
        signal.throwIfAborted();
        assertCurrent();
        if (
          settings.read().service?.gatewayContract !== 'mcp-v1' ||
          !/^[a-f0-9]{64}$/.test(info.capabilitySnapshotHash || '')
        )
          throw Error('Automatic task preparation requires the current remote service contract.');
        const catalogs = info.domainCatalog?.filter(item => item.domain === domain);
        const available = [
          ...new Set(
            (catalogs?.length === 1 ? catalogs[0].packs || [] : [])
              .filter(pack => pack.domain === domain)
              .flatMap(pack => pack.profiles || [])
              .flatMap(profile => profile.worker?.toolIds || []),
          ),
        ];
        const tools = inputs.tools ?? available;
        if (
          !Array.isArray(tools) ||
          !tools.length ||
          tools.length > 128 ||
          new Set(tools).size !== tools.length ||
          tools.some(
            id =>
              typeof id !== 'string' ||
              !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id) ||
              !available.includes(id) ||
              (workspace.tools.has(id) && !remote?.remoteTools.some(t => t.id === id)),
          )
        )
          throw Error('Choose a bounded set of tools declared by the remote Pack.');
        const plan = Object.freeze({
          ...review,
          tools: Object.freeze([...tools].sort()),
          explicitTools: inputs.tools !== undefined,
          capabilitySnapshotHash: info.capabilitySnapshotHash,
          ownerId,
          taskId: executing.get(ownerId)?.taskId,
        });
        // A batch must be fully visible; never approve an omitted tail.
        approvalText(plan);
        for (const [id, old] of plans) if (old.ownerId === ownerId) plans.delete(id);
        plans.set(review.id, plan);
        return receipt(action, { ...plan, reviewId: plan.id, status: 'awaiting_batch_approval' });
      },
    },
    {
      descriptor: {
        schemaVersion: '1',
        id: PREPARE,
        version: VERSION,
        risk: 'mutating',
        effect: 'external',
        verification: ['project.remote.prepared'],
      },
      guide: {
        inputs: { reviewId: 'id from project.remote.plan artifact' },
        description:
          'Present one approval for the immutable plan, upload all selected inputs, and check live protected tool availability. Success authorizes only the listed remote tools for this task; repeated calls need no extra clicks. Added paths or tools need a fresh plan. A ready environment is not engineering verification. If unavailable, continue local conversation; explain the failure and re-plan when ready.',
      },
      execute: async ({ inputs, action, signal, ownerId }) => {
        assertCurrent();
        const context = executing.get(ownerId);
        const plan = planFor(inputs.reviewId, ownerId, context?.taskId);
        await settings.sync(projectDir, domain, inputs.reviewId, { signal });
        plans.delete(inputs.reviewId);
        assertCurrent();
        const ready = await loadRemote(ownerId, signal, plan);
        const activeTools = Object.freeze(
          plan.tools.filter(id => ready.remoteTools.some(tool => tool.id === id)),
        );
        context.pendingGrant = Object.freeze({
          taskId: context.taskId,
          identity,
          remoteProjectId: ready.binding.remoteProjectId,
          capabilitySnapshotHash: plan.capabilitySnapshotHash,
          tools: activeTools,
          files: Object.freeze(plan.files.map(file => file.path)),
          remember: plan.remember,
          manifestDigest: plan.manifestDigest,
        });
        return receipt(action, {
          status: 'ready',
          tools: activeTools,
          unavailableTools: plan.tools.filter(id => !activeTools.includes(id)),
          destination: plan.destination,
          files: plan.files,
          remember: plan.remember,
          verification: 'not_run',
          authorization: 'listed remote tools for this task only',
        });
      },
    },
  ];
  const workspace = new IndustrialRuntime(projectDir, domain, {
    directory: path.join(directory || path.join(settings.directory, 'core'), 'remote-workspaces'),
    projectRef: { schemaVersion: '1', projectId, domain },
    stateProvider: local.stateProvider,
    tools: [...local.tools, ...preparationTools],
    verifiers: {
      ...local.verifiers,
      'project.remote.prepared': () => ({
        status: 'not_run',
        reason: 'Remote environment preparation does not verify an engineering result.',
        metrics: {},
      }),
    },
  });
  protectedPaths.push(workspace.directory);
  const validGrant = (chatId, taskId, toolId) => {
    const grant = grants.get(chatId),
      current = settings.project(projectDir, domain);
    return Boolean(
      taskId &&
        grant?.taskId === taskId &&
        grant.identity === settings.identity() &&
        current.location === 'remote' &&
        current.canonicalProjectId === projectId &&
        current.remoteProjectId === grant.remoteProjectId &&
        (grant.remember || current.manifestDigest === grant.manifestDigest) &&
        remote?.inventory?.capabilitySnapshotHash === grant.capabilitySnapshotHash &&
        JSON.stringify([...(current.files || [])].sort()) ===
          JSON.stringify([...grant.files].sort()) &&
        grant.tools.includes(toolId),
    );
  };
  const facade = {
    project: workspace.project,
    projectDir,
    domain,
    hostRuntimeOnly: true,
    hostOnlyEnv: [settings.configuration().credentialEnv].filter(Boolean),
    diagnosticsRuntime: workspace,
    get closed() {
      return closed;
    },
    get capabilities() {
      const allowed = new Set([...grants.values()].flatMap(grant => grant.tools));
      return [
        ...workspaceCapabilities,
        preparationCapability,
        ...(remote?.capabilities || [])
          .filter(c => c.id === 'remote.software')
          .map(c => ({
            ...c,
            tools: c.tools.filter(tool => allowed.has(tool.id)),
          })),
      ];
    },
    inspect: () => workspace.inspect(),
    descriptors: scope => workspace.descriptors(scope),
    compatibilityKey: () => hash(`${projectId}:${identity}`),
    forSession(chatId) {
      if (sessions.has(chatId)) return sessions.get(chatId);
      const session = new Proxy(facade, {
        get(target, property) {
          if (property === 'requiresExplicitApproval')
            return (request, context) => {
              if (
                remote?.remoteTools.some(tool => tool.id === request.toolId) &&
                !validGrant(chatId, context?.taskId, request.toolId)
              )
                throw Error(
                  'Prepare this task with project.remote.plan then project.remote.prepare for one batch approval.',
                );
              return request.toolId === PREPARE;
            };
          if (property === 'hasStandingApproval')
            return (request, context) => validGrant(chatId, context?.taskId, request.toolId);
          if (property === 'approvalPreview')
            return (request, context) => {
              if (request.toolId !== PREPARE) return workspace.approvalPreview(request);
              const plan = planFor(request.inputs.reviewId, chatId, context?.taskId);
              return {
                ...workspace.approvalPreview(request),
                title: 'Approve remote task / 批量授权远端任务',
                text: approvalText(plan),
                truncated: false,
              };
            };
          if (property === 'describeTool')
            return (id, scope) =>
              remote?.remoteTools.some(tool => tool.id === id)
                ? remote.describeTool(id, scope, remote.context(chatId))
                : workspace.describeTool(id, scope);
          if (property === 'execute')
            return async (request, policy = {}) => {
              if (executing.has(chatId))
                throw Error('A task action is already running in this chat.');
              const context = { taskId: policy.taskId };
              executing.set(chatId, context);
              try {
                let result;
                if (remote?.remoteTools.some(tool => tool.id === request.toolId))
                  result = await remote.forSession(chatId).execute(request, {
                    ...policy,
                    approval:
                      policy.approval === true && validGrant(chatId, policy.taskId, request.toolId),
                  });
                else result = await workspace.execute(request, { ...policy, ownerId: chatId });
                if (result.action.status === 'completed' && context.pendingGrant)
                  grants.set(chatId, context.pendingGrant);
                return result;
              } finally {
                executing.delete(chatId);
              }
            };
          if (property === 'cancel')
            return () => {
              workspace.cancel(chatId);
              if (remote?.contexts.has(chatId)) remote.cancel(remote.contexts.get(chatId));
            };
          if (property === 'waitForIdle')
            return async () => {
              await workspace.waitForIdle(chatId);
              await remote?.contexts.get(chatId)?.execution;
            };
          if (property === 'close' || property === 'releaseOwner')
            return async () => {
              await workspace.releaseOwner(chatId);
              if (remote?.contexts.has(chatId)) await remote.forSession(chatId).close();
              grants.delete(chatId);
              sessions.delete(chatId);
            };
          if (property === 'status') return () => settings.task(projectDir, domain, chatId);
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      sessions.set(chatId, session);
      return session;
    },
    close() {
      if (executing.size) throw Error('Cannot close a running remote task.');
      if (disposal) return disposal;
      // ProjectRuntimes replaces idle bundles synchronously. Release the store
      // before awaiting transport cleanup so a replacement can reopen it.
      const workspaceClosing = workspace.close();
      closed = true;
      disposal = Promise.all([workspaceClosing, remote?.close()]);
      return disposal;
    },
  };
  for (const name of [
    'get',
    'readArtifact',
    'listRuns',
    'listActions',
    'listVerifications',
    'listCheckpoints',
    'latestCheckpoint',
    'assertProjectBound',
  ])
    facade[name] = (...args) => workspace[name](...args);
  return {
    runtime: facade,
    configurationCurrent: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    get capabilities() {
      return facade.capabilities;
    },
    stateDiagnostics: [],
    protectedPaths,
    packId: 'builtin-remote',
    packVersion: VERSION,
  };
}
module.exports = { createRemotePlanningRuntime };
