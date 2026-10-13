const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { IndustrialRuntime } = require('./industrial.cjs');
const { createWorkspacePlugin } = require('./workspace.cjs');
const {
  DomainStateSchema,
  ToolDescriptorSchema,
  ActionRequestSchema,
  IndustrialCheckpointSchema,
  IndustrialActionRecordSchema,
  RunRecordSchema,
  IndustrialVerificationResultSchema,
  ArtifactRefSchema,
} = require('@industrial-agent-harness/contracts');
const { hash, writePrivateJson } = require('./remote-client.cjs');

// The project owns one canonical cache; chats own disposable transports and durable
// remote reconnect identities. No professional software is loaded on this host.
class RemoteRuntime {
  constructor({ settings, projectDir, domain, directory, registry, onStatus = () => {} }) {
    this.settings = settings;
    this.projectDir = fs.realpathSync(projectDir);
    this.domain = domain;
    this.binding = settings.project(projectDir, domain);
    this.configuration = settings.identity();
    if (
      this.binding.protocol !== '1.1' ||
      !this.binding.canonicalProjectId ||
      !this.binding.snapshotId ||
      this.binding.serviceIdentity !== this.configuration
    )
      throw Error('Choose and confirm files to upload before running remotely.');
    this.registry = registry;
    this.remoteTools = [];
    this.contexts = new Map();
    this.hostOnlyEnv = [settings.configuration().credentialEnv].filter(Boolean);
    this.hostRuntimeOnly = true;
    this.onStatus = onStatus;
    this.closed = false;
    const workspace = createWorkspacePlugin({
      domain,
      protectedPaths: [directory, settings.directory].filter(Boolean),
      environment: settings.environment,
    });
    workspace.tools = workspace.tools.filter(tool => tool.descriptor.id !== 'project.task.run');
    this.workspaceCapabilities = workspace.capabilities.map(item => ({
      ...item,
      tools: item.tools.filter(tool => workspace.tools.some(t => t.descriptor.id === tool.id)),
    }));
    this.capabilities = this.workspaceCapabilities;
    this.workspace = new IndustrialRuntime(projectDir, domain, {
      directory: path.join(directory || path.join(settings.directory, 'core'), 'remote-workspaces'),
      projectRef: { schemaVersion: '1', projectId: this.binding.canonicalProjectId, domain },
      stateProvider: workspace.stateProvider,
      tools: workspace.tools,
      verifiers: workspace.verifiers,
    });
    this.project = this.workspace.project;
    this.diagnosticsRuntime = this.workspace;
    this.control = settings.client({ remoteProjectId: this.binding.remoteProjectId, domain });
  }
  current() {
    const binding = this.settings.project(this.projectDir, this.domain);
    return (
      !this.closed &&
      this.settings.identity() === this.configuration &&
      binding.location === 'remote' &&
      binding.remoteProjectId === this.binding.remoteProjectId &&
      binding.snapshotId === this.binding.snapshotId
    );
  }
  compatibilityKey() {
    return hash(
      JSON.stringify([
        this.configuration,
        this.binding.remoteProjectId,
        this.binding.snapshotId,
        this.binding.files,
        this.inventory?.capabilitySnapshotHash,
      ]),
    );
  }
  assertCurrent() {
    if (!this.current()) throw Error('Remote project configuration changed. Refresh this chat.');
    this.workspace.assertProjectBound();
  }
  context(chatId) {
    if (this.closed) throw Error('Remote runtime is closed.');
    if (typeof chatId !== 'string' || !/^[a-f0-9-]{36}$/i.test(chatId))
      throw Error('Remote execution requires a persistent chat identity.');
    let context = this.contexts.get(chatId);
    if (context?.releasing)
      throw Error('Remote chat transport is closing. Wait before reconnecting.');
    if (!context) {
      context = {
        chatId,
        client: this.settings.sessionClient(this.projectDir, this.domain, chatId),
        executing: false,
      };
      this.contexts.set(chatId, context);
    }
    return context;
  }
  forSession(chatId) {
    const context = this.context(chatId);
    if (context.facade) return context.facade;
    const release = async () => {
      const current = this.contexts.get(chatId);
      if (!current) return;
      if (current.executing) throw Error('Cannot close a running remote chat transport.');
      if (current.releasing) return current.releasing;
      current.releasing = (async () => {
        await current.client.close();
        if (this.contexts.get(chatId) === current) this.contexts.delete(chatId);
      })();
      try {
        await current.releasing;
      } finally {
        if (this.contexts.get(chatId) === current) current.releasing = null;
      }
    };
    context.facade = new Proxy(this, {
      get: (target, property) => {
        if (property === 'inspect') return () => target.inspect(target.context(chatId));
        if (property === 'execute')
          return (request, policy) => target.execute(request, policy, target.context(chatId));
        if (property === 'describeTool')
          return (id, scope) => target.describeTool(id, scope, target.context(chatId));
        if (property === 'cancel') return () => target.cancel(target.contexts.get(chatId));
        if (property === 'status') return () => target.status({ chatId });
        if (property === 'close' || property === 'releaseOwner') return release;
        if (property === 'waitForIdle')
          return () => target.contexts.get(chatId)?.execution || Promise.resolve();
        if (property === 'compatibilityKey') return () => hash(target.compatibilityKey() + chatId);
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return context.facade;
  }
  status(context) {
    return context ? this.settings.task(this.projectDir, this.domain, context.chatId) : null;
  }
  publish(context, value) {
    const status = {
      ...value,
      chatId: context.chatId,
      remoteProjectId: this.binding.remoteProjectId,
      serviceIdentity: this.configuration,
    };
    writePrivateJson(this.settings.taskFile(this.projectDir, this.domain, context.chatId), status);
    this.onStatus(status);
  }
  async recover(context) {
    const pending = this.status(context);
    if (
      !pending ||
      (!pending.needsImport && !['submitting', 'running', 'unknown'].includes(pending.status))
    )
      return;
    const unknown = message => {
      this.publish(context, { ...pending, status: 'unknown', outcome: 'unknown' });
      throw Error(message);
    };
    let invocation;
    try {
      invocation = await context.client.invocation(pending.invocationId);
    } catch (error) {
      if (error.status === 404)
        return unknown('The previous remote invocation outcome is unknown. Do not replay it.');
      throw error;
    }
    if (!invocation || invocation.id !== pending.invocationId)
      return unknown('Saved remote invocation identity changed; its outcome is unknown.');
    if (['running', 'unknown'].includes(invocation.status))
      return unknown('The previous remote invocation is still running or its outcome is unknown.');
    const completed =
      invocation.status === 'completed' &&
      invocation.outcome === 'completed' &&
      invocation.result &&
      typeof invocation.result === 'object' &&
      !Array.isArray(invocation.result);
    const notSubmitted =
      invocation.status === 'failed' &&
      invocation.outcome === 'not_submitted' &&
      (invocation.result === undefined || invocation.result === null);
    if (!completed && !notSubmitted)
      return unknown(
        'Remote invocation returned an invalid terminal result; its outcome is unknown.',
      );
    if (completed) {
      try {
        await this.importResult(invocation.result, context, pending.action, pending.inputHashes);
      } catch (error) {
        this.publish(context, {
          ...pending,
          status: 'unknown',
          outcome: 'unknown',
          needsImport: true,
        });
        throw error;
      }
    }
    this.publish(context, {
      ...pending,
      status: invocation.status,
      outcome: invocation.outcome,
      needsImport: false,
    });
    return true;
  }
  async inspect(context) {
    this.assertCurrent();
    await this.settings.ensureSynced(this.projectDir, this.domain);
    const [response, inventory] = await Promise.all([
      this.control.state(),
      this.control.capabilities(),
    ]);
    const state = DomainStateSchema.parse(response.state);
    if (
      state.projectId !== this.project.projectId ||
      state.domain !== this.domain ||
      response.snapshotId !== this.binding.snapshotId
    )
      throw Error('Remote state differs from the uploaded project snapshot.');
    const expected = Object.fromEntries(
      this.settings
        .snapshot(this.projectDir, this.binding.files)
        .manifest.files.map(f => [f.path, f.sha256]),
    );
    // Runtime identity hashes may be added by the server; every uploaded file must match.
    if (Object.entries(expected).some(([key, digest]) => state.inputHashes[key] !== digest))
      throw Error('Remote state input hashes differ from the uploaded files.');
    if (
      inventory.domain !== this.domain ||
      !/^[a-f0-9]{64}$/.test(inventory.capabilitySnapshotHash) ||
      !Array.isArray(inventory.tools) ||
      inventory.tools.length > 128
    )
      throw Error('Invalid remote capability catalog.');
    this.remoteTools = inventory.tools.map(tool =>
      ToolDescriptorSchema.parse(tool.descriptor || tool),
    );
    this.inventory = inventory;
    this.state = state;
    const trusted = (this.registry.capabilities || [])
      .filter(item => item.domain === this.domain)
      .map(item => ({
        ...item,
        tools: item.tools.filter(tool => this.remoteTools.some(remote => remote.id === tool.id)),
      }))
      .filter(item => item.tools.length);
    const described = new Set(trusted.flatMap(item => item.tools.map(tool => tool.id)));
    const tools = this.remoteTools
      .filter(tool => !described.has(tool.id))
      .map(tool => ({
        id: tool.id,
        summary:
          'Execute this remote software tool in the bound sandbox. Describe its inputs before calling.',
      }));
    this.capabilities = [
      ...this.workspaceCapabilities,
      ...trusted,
      ...(tools.length
        ? [
            {
              id: 'remote.software',
              domain: this.domain,
              title: 'Remote software and sandbox',
              stages: [],
              alwaysAvailable: true,
              priority: 0,
              keywords: [],
              skills: [],
              tools,
              verification: [...new Set(this.remoteTools.flatMap(tool => tool.verification))],
            },
          ]
        : []),
    ];
    this.workspace.put('state', state.id, state);
    // Recovery imports immutable history. Another chat may already have advanced
    // the project, so fetch the authoritative head again after importing it.
    if (context && (await this.recover(context))) return this.inspect();
    return this.state;
  }
  descriptors(scope) {
    return [...this.workspace.descriptors(), ...this.remoteTools].filter(
      tool => !scope || scope.tools.includes(tool.id),
    );
  }
  async describeTool(id, scope, context) {
    if (!scope?.tools.includes(id)) throw Error('Tool is outside the current Broker scope.');
    const descriptor = this.remoteTools.find(tool => tool.id === id);
    if (!descriptor) return this.workspace.describeTool(id, scope);
    if (!context) throw Error('Remote tool discovery requires a chat binding.');
    const detail = await context.client.describeTool(id);
    if (detail.tool?.id && detail.tool.id !== id) throw Error('Remote tool identity changed.');
    return {
      descriptor,
      guide: {
        description: detail.description || detail.tool?.description || '',
        inputs: detail.inputs || detail.inputSchema || detail.guide?.inputs || {},
      },
    };
  }
  async importResult(result, context, expectedAction, expectedInputHashes) {
    // Canonical parsers and immutable store writes run before facts become visible.
    result = {
      ...result,
      action: IndustrialActionRecordSchema.parse(result.action),
      run: RunRecordSchema.parse(result.run),
      verification: IndustrialVerificationResultSchema.parse(result.verification),
      artifacts: result.artifacts.map(ref => ArtifactRefSchema.parse(ref)),
    };
    const state = DomainStateSchema.parse(result.state),
      checkpoint = IndustrialCheckpointSchema.parse(result.checkpoint);
    if (
      state.projectId !== this.project.projectId ||
      state.domain !== this.domain ||
      checkpoint.state.id !== state.id ||
      JSON.stringify(checkpoint.state) !== JSON.stringify(state) ||
      hash(JSON.stringify(checkpoint.state)) !== checkpoint.stateHash ||
      result.action.projectId !== this.project.projectId ||
      result.action.domain !== this.domain ||
      result.run.domain !== this.domain ||
      result.run.projectId !== this.project.projectId ||
      result.run.id !== result.action.runId ||
      JSON.stringify(result.run.actionIds) !== JSON.stringify([result.action.id]) ||
      checkpoint.runId !== result.run.id ||
      JSON.stringify(checkpoint.actionIds) !== JSON.stringify([result.action.id]) ||
      JSON.stringify([...checkpoint.artifactIds].sort()) !==
        JSON.stringify(state.artifacts.map(ref => ref.id).sort()) ||
      result.run.status !== result.action.status ||
      result.run.status === 'running' ||
      !result.action.endedAt ||
      !result.run.endedAt ||
      result.action.stateId !== result.run.stateId ||
      result.verification.id !== result.action.verification.id ||
      JSON.stringify(result.verification) !== JSON.stringify(result.action.verification) ||
      JSON.stringify([...result.action.artifactIds].sort()) !==
        JSON.stringify(result.artifacts.map(ref => ref.id).sort()) ||
      JSON.stringify([...result.verification.evidence.artifactIds].sort()) !==
        JSON.stringify([...result.action.artifactIds].sort()) ||
      JSON.stringify(Object.entries(result.verification.evidence.inputHashes).sort()) !==
        JSON.stringify(Object.entries(result.action.inputHashes).sort()) ||
      !expectedInputHashes ||
      JSON.stringify(Object.entries(result.action.inputHashes).sort()) !==
        JSON.stringify(Object.entries(expectedInputHashes).sort()) ||
      (result.verification.status === 'passed' &&
        (result.action.status !== 'completed' ||
          !state.verificationIds.includes(result.verification.id) ||
          !this.remoteTools
            .find(tool => tool.id === result.action.toolId)
            ?.verification.includes(result.verification.verifierId))) ||
      (expectedAction &&
        (result.action.toolId !== expectedAction.toolId ||
          result.action.stateId !== expectedAction.expectedStateId ||
          JSON.stringify(result.action.inputs) !== JSON.stringify(expectedAction.inputs))) ||
      result.artifacts.some(
        ref =>
          ref.projectId !== this.project.projectId ||
          ref.runId !== result.run.id ||
          ref.actionId !== result.action.id ||
          JSON.stringify(Object.entries(ref.inputHashes).sort()) !==
            JSON.stringify(Object.entries(result.action.inputHashes).sort()),
      )
    )
      throw Error('Remote result identity differs from this project action.');
    const objects = [];
    for (const ref of result.artifacts) {
      const artifact = await context.client.artifact(ref.id, ref);
      if (JSON.stringify(artifact.ref) !== JSON.stringify(ref))
        throw Error('Remote artifact metadata changed.');
      objects.push(artifact);
    }
    for (const { ref, content } of objects) {
      const file = path.join(this.workspace.blobDirectory, ref.sha256);
      if (!fs.existsSync(file)) fs.writeFileSync(file, content, { flag: 'wx', mode: 0o400 });
      else if (hash(fs.readFileSync(file)) !== ref.sha256)
        throw Error('Local remote artifact cache is corrupt.');
    }
    this.workspace.transaction(() => {
      for (const [kind, value] of [
        ['run', result.run],
        ['action', result.action],
        ['verification', result.verification],
        ['state', state],
        ['checkpoint', checkpoint],
        ...result.artifacts.map(ref => ['artifact', ref]),
      ])
        this.workspace.put(kind, value.id, value);
    });
    this.state = state;
    this.checkpoint = checkpoint;
    return result;
  }
  async execute(request, { scope, approval = false } = {}, context) {
    if (!context) throw Error('Remote execution requires a chat binding.');
    if (context.executing) throw Error('This remote chat already has a running invocation.');
    context.executing = true;
    context.controller = new AbortController();
    context.execution = this.executeOne(request, { scope, approval }, context);
    try {
      return await context.execution;
    } catch (error) {
      // This is a local forwarding/rejection record. The separate invocation journal
      // retains unknown remote outcomes; no transport failure establishes acceptance.
      const local = await this.workspace.inspect();
      const failed = await this.workspace.execute(
        { ...request, expectedStateId: local.id },
        {
          scope: {
            projectId: this.project.projectId,
            domain: this.domain,
            stateId: local.id,
            tools: [],
          },
          approval: false,
        },
      );
      const verification = {
        ...failed.verification,
        id: crypto.randomUUID(),
        reason: String(error.message).slice(0, 4096),
      };
      const action = { ...failed.action, diagnostics: [verification.reason], verification };
      this.workspace.transaction(() => {
        this.workspace.put('verification', verification.id, verification);
        this.workspace.put('action', action.id, action, true);
      });
      const current = this.state || local;
      const checkpoint = this.workspace.createCheckpoint(current, failed.run, action);
      this.checkpoint = checkpoint;
      return { ...failed, action, verification, state: current, checkpoint };
    } finally {
      context.executing = false;
      context.execution = null;
      context.controller = null;
    }
  }
  async executeOne(request, policy, context) {
    const state = await this.inspect(context);
    const action = ActionRequestSchema.parse({ ...this.project, ...request });
    if (
      action.projectId !== state.projectId ||
      action.domain !== state.domain ||
      action.expectedStateId !== state.id ||
      policy.scope?.projectId !== state.projectId ||
      policy.scope?.domain !== state.domain ||
      policy.scope?.stateId !== state.id ||
      !policy.scope.tools.includes(action.toolId)
    )
      throw Error('Remote action has an invalid or stale Broker scope.');
    const descriptor = this.descriptors().find(tool => tool.id === action.toolId);
    if (!descriptor) throw Error('Remote tool is unavailable.');
    if (descriptor.risk === 'mutating' && policy.approval !== true)
      throw Error('Remote action requires approval in this chat.');
    if (!this.remoteTools.some(tool => tool.id === action.toolId)) {
      const local = await this.workspace.inspect();
      return this.workspace.execute(
        { ...action, expectedStateId: local.id },
        { ...policy, scope: { ...policy.scope, stateId: local.id }, ownerId: context.chatId },
      );
    }
    const invocation = {
      invocationId: crypto.randomUUID(),
      snapshotId: this.binding.snapshotId,
      capabilitySnapshotHash: this.inventory.capabilitySnapshotHash,
      action,
    };
    const pending = {
      invocationId: invocation.invocationId,
      toolId: action.toolId,
      action,
      inputHashes: state.inputHashes,
      status: 'submitting',
      outcome: 'unknown',
    };
    // Durable identity precedes grant issuance and the MCP mutation. Reopening queries it.
    this.publish(context, pending);
    let dispatched = false;
    try {
      if (context.controller.signal.aborted)
        throw Object.assign(Error('Remote call stopped before dispatch.'), {
          outcome: 'not_submitted',
        });
      const grant = await context.client.grant({
        ...invocation,
        scope: {
          projectId: policy.scope.projectId,
          domain: policy.scope.domain,
          stateId: policy.scope.stateId,
          tools: policy.scope.tools.filter(id => this.remoteTools.some(tool => tool.id === id)),
        },
        approval: { decision: 'approved', source: 'harness-host' },
      });
      invocation.invocationGrantId = grant.invocationGrantId;
      if (context.controller.signal.aborted)
        throw Object.assign(Error('Remote call stopped before dispatch.'), {
          outcome: 'not_submitted',
        });
      this.publish(context, { ...pending, status: 'running' });
      dispatched = true;
      const response = await context.client.callTool(action.toolId, action.inputs, {
        invocation,
        signal: context.controller.signal,
      });
      if (response.invocationId !== invocation.invocationId || !response.result)
        throw Object.assign(Error('Remote invocation returned no matching canonical result.'), {
          outcome:
            response.invocationId === invocation.invocationId &&
            response.outcome === 'not_submitted'
              ? 'not_submitted'
              : 'unknown',
        });
      // Preserve the recoverable result before downloading/verifying its artifacts.
      this.publish(context, { ...pending, status: response.status, needsImport: true });
      const result = await this.importResult(response.result, context, action, state.inputHashes);
      this.publish(context, {
        ...pending,
        status: response.status,
        outcome: 'completed',
        needsImport: false,
      });
      return result;
    } catch (error) {
      const safe = !dispatched || error.outcome === 'not_submitted';
      this.publish(context, {
        ...pending,
        status: safe ? 'failed' : 'unknown',
        outcome: safe ? 'not_submitted' : 'unknown',
        code: error.code || 'REMOTE_EXECUTION_ERROR',
      });
      throw error;
    }
  }
  cancel(context) {
    // Cancellation stops the local wait. Only the service can confirm computation stopped.
    context?.controller?.abort();
    if (context && this.status(context)?.status === 'running')
      this.publish(context, { ...this.status(context), status: 'unknown', outcome: 'unknown' });
  }
  async waitForIdle() {
    await Promise.allSettled([...this.contexts.values()].map(context => context.execution));
  }
  readArtifact(id) {
    return this.workspace.readArtifact(id);
  }
  latestCheckpoint() {
    if (!this.state) return null;
    if (this.checkpoint?.state.id === this.state.id) return this.checkpoint;
    return (
      this.workspace.listCheckpoints().findLast(item => item.state.id === this.state.id) || null
    );
  }
  listRuns() {
    return this.workspace.listRuns();
  }
  listActions() {
    return this.workspace.listActions();
  }
  listVerifications() {
    return this.workspace.listVerifications();
  }
  listCheckpoints() {
    return this.workspace.listCheckpoints();
  }
  async close() {
    if ([...this.contexts.values()].some(c => c.executing))
      throw Error('Cannot close a running remote action.');
    this.closed = true;
    await Promise.all([...this.contexts.values()].map(context => context.client.close()));
    await this.control.close();
    await this.workspace.close();
  }
}
function createRemoteRuntime(options) {
  const runtime = new RemoteRuntime(options);
  return {
    runtime,
    configurationCurrent: () => runtime.current(),
    stateDiagnostics: [],
    get capabilities() {
      return runtime.capabilities;
    },
    protectedPaths: [runtime.workspace.directory, options.settings.directory],
    packId: 'builtin-remote',
    packVersion: '1.1',
  };
}
module.exports = { RemoteRuntime, createRemoteRuntime };
