const {
  createSession,
  createExternalTool,
  bundledExecutable,
  KIMI_CODE_VERSION,
} = require('./code-session.cjs');
const { createKimiPaths } = require('./legacy-paths.cjs');
const { thinkingEffort } = require('./model-config.cjs');
const { materializeAgentProfiles, nativeAgentProfile } = require('./agent-profiles.cjs');
const { z } = require('zod');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { materializeSkills } = require('@industrial-agent-harness/domain-skills');
const {
  selectMcpServers,
  writeMcpConfig,
  selectedRuntimeKey,
  externalSecrets,
} = require('@industrial-agent-harness/domain-mcp');
const { validatePromptImages, imageContent } = require('./image-input.cjs');
const { createDiagnosticLog } = require('./diagnostic-log.cjs');
const { createProcessSandbox } = require('./process-sandbox.cjs');
const { applicationTools } = require('./application-tools.cjs');
const { runtimeTools } = require('./runtime-tools.cjs');
const { prepareProjectWorkspace } = require('./project-workspace.cjs');

const canonicalNames = {
  'eda.netlist.inspect': 'eda_netlist_inspect',
  'eda.waveform.inspect': 'eda_waveform_inspect',
  'eda.layout.inspect': 'eda_layout_inspect',
  'pcb.board.inspect': 'pcb_board_inspect',
};

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
const MAX_INDUSTRIAL_CONTEXT_BYTES = 8 * 1024;

function boundedJson(value, resource) {
  const output = JSON.stringify(value);
  if (typeof output !== 'string') throw Error(`${resource} has no serializable result.`);
  const bytes = Buffer.byteLength(output, 'utf8');
  if (bytes > MAX_TOOL_OUTPUT_BYTES)
    throw Error(
      `${resource} result is ${bytes} bytes, above the ${MAX_TOOL_OUTPUT_BYTES}-byte limit. Request a narrower capability section or artifact.`,
    );
  return output;
}

function scopeKey(scope) {
  return JSON.stringify({
    domain: scope.domain,
    stage: scope.stage,
    capabilityIds: scope.capabilityIds,
    skills: scope.skills,
    tools: scope.tools,
  });
}

function industrialContext(scope, anchor = null, externalServers = []) {
  const externalIds = new Set(externalServers.flatMap(server => server.tools.map(tool => tool.id)));
  const displayScope = { ...scope, tools: scope.tools.filter(id => !externalIds.has(id)) };
  let context = scope.capabilityIds.length
    ? `Industrial Context (current Broker scope): ${scopeKey(displayScope)}. Use industrial_capability_detail to load details when needed. Artifact metadata tools are read-only. Treat viewer output as inspection, not engineering verification.`
    : 'No industrial capability was selected for this task. Work within the chosen project using standard Kimi tools.';
  if (selectMcpServers(scope).length)
    context +=
      '\nA project-bound Domain MCP is available. Use domain_tool_list for allowed canonical IDs, domain_tool_describe for a selected schema, and domain_tool_call to recover persisted domain context before engineering work. Core file observations are separate from domain execution and acceptance evidence.';
  if (scope.tools.some(id => externalIds.has(id)))
    context +=
      '\nUser-registered external MCP tools are available. Use external_tool_list, external_tool_describe, then external_tool_call. Screenshots are returned as images. These host services may control applications outside the project; roots are context, not an OS sandbox. Caller approval remains required. Treat their outputs as unverified observations; submit industrial actions through Domain Runtime and inspect engineering acceptance separately. Never automatically repeat an uncertain external mutation.';
  const readHint = scope.capabilityIds.length
    ? 'Use industrial_context_read for more registered artifacts or after compaction.'
    : 'Select an industrial capability to enable checkpoint detail tools.';
  const withAnchor = value =>
    `${context}\nObserved project checkpoint: ${JSON.stringify(value)}. These are file observations with content hashes, not engineering verification. ${readHint}`;
  let complete = anchor ? withAnchor(anchor) : context;
  complete +=
    '\nExecution boundary: native Shell, WriteFile and child MCP processes cannot modify the project or access host Docker. A Docker permission denial in those processes is expected and does not establish host Runtime failure. Use an in-scope read-only environment Tool through industrial_action_call for host readiness. Engineering mutations also require industrial_action_call through the host Domain Runtime; unavailable legacy mutations fail visibly. Process success and environment readiness alone are not engineering acceptance.';
  if (anchor && Buffer.byteLength(complete, 'utf8') > MAX_INDUSTRIAL_CONTEXT_BYTES) {
    complete = withAnchor({
      checkpointId: anchor.checkpointId,
      stateHash: anchor.stateHash,
      domain: anchor.domain,
      artifactCount: anchor.artifactCount,
      staleArtifactCount: anchor.staleArtifactCount ?? anchor.staleArtifactIds?.length ?? 0,
      verificationStatus: 'not_run',
      hasMore: true,
    });
  }
  if (Buffer.byteLength(complete, 'utf8') > MAX_INDUSTRIAL_CONTEXT_BYTES)
    throw Error(
      'Broker scope exceeds the Industrial Context limit; narrow the selected capabilities before starting Kimi.',
    );
  return complete;
}

function prepareSessionFiles(scope, runtime, persistentDirectory, projectDir, plugins = []) {
  const directory =
    persistentDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-session-'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    const skillsDir = materializeSkills(scope, directory, runtime.environment);
    const skillDirs = [
      ...new Set([
        ...prepareProjectWorkspace(directory, projectDir),
        skillsDir,
        ...enabledPlugins(plugins).map(plugin => plugin.materializeSkill(directory)),
      ]),
    ];
    const modelConfig = fs.readFileSync(path.join(runtime.shareDir, 'config.toml'), 'utf8');
    const agents = materializeAgentProfiles(runtime.agentSnapshot, directory);
    fs.writeFileSync(
      path.join(directory, 'config.toml'),
      `extra_skill_dirs = [${skillDirs.map(dir => JSON.stringify(dir)).join(',')}]\n${agents.directory ? `extra_agent_dirs = [${JSON.stringify(agents.directory)}]\n` : ''}${modelConfig}`,
      { mode: 0o600 },
    );
    writeMcpConfig(
      directory,
      runtime.hostRuntimeOnly
        ? []
        : selectMcpServers(
            scope,
            runtime.disabledMcpServers,
            undefined,
            runtime.hostRuntimeExternal ? [] : runtime.externalServers,
          ),
      {
        projectDir,
        environment: runtime.environment,
        imageInput: Boolean(runtime.profile?.imageInput),
      },
    );
    return directory;
  } catch (error) {
    if (!persistentDirectory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function enabledPlugins(plugins) {
  return (plugins || []).filter(plugin => plugin?.enabled?.() === true);
}

// Image tool results carry multi-megabyte data URIs; the diagnostic log keeps
// the event shape but must not store the payloads themselves.
function redactImagePayloads(event) {
  if (event.type !== 'ToolResult') return event;
  const value = event.payload?.return_value;
  if (!value || typeof value.output === 'string' || !Array.isArray(value.output)) return event;
  let redacted = false;
  const output = value.output.map(part => {
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      redacted = true;
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: `[image redacted, ${part.image_url.url.length} chars]`,
        },
      };
    }
    return part;
  });
  return redacted
    ? { ...event, payload: { ...event.payload, return_value: { ...value, output } } }
    : event;
}

// The native CLI history (context/wire snapshots) embeds tool-result images as
// base64 data URIs. The same payloads redactImagePayloads keeps out of the
// event log must also stay out of the copied files.
const DATA_URI_PATTERN = /(data:image\/[a-zA-Z0-9.+-]+;base64,)([A-Za-z0-9+/=]+)/g;
function redactSnapshotText(text) {
  return text.replace(
    DATA_URI_PATTERN,
    (match, prefix, payload) => `${prefix}[image redacted, ${payload.length} chars]`,
  );
}

function externalTools(getScope, lookupArtifact, disclose, readContextPage) {
  const scope = getScope();
  if (!scope?.capabilityIds.length) return [];
  const tools = [
    createExternalTool({
      name: 'industrial_capability_detail',
      description:
        'Read a selected industrial capability. Use section to request only skills, tools, or verification when the full detail is large.',
      parameters: z.object({
        capabilityId: z.string(),
        section: z.enum(['all', 'skills', 'tools', 'verification']).optional(),
      }),
      handler: async ({ capabilityId, section = 'all' }) => {
        if (!getScope()?.capabilityIds.includes(capabilityId))
          throw Error('Capability is outside the current Broker scope.');
        const detail = disclose(capabilityId);
        const selected =
          section === 'all'
            ? detail
            : { capability: detail.capability, [section]: detail[section] };
        return {
          output: boundedJson(selected, `Capability ${capabilityId} ${section}`),
          message: 'Capability detail disclosed',
        };
      },
    }),
  ];
  if (readContextPage)
    tools.push(
      createExternalTool({
        name: 'industrial_context_read',
        description:
          'Read a page of registered project-file observations from a durable checkpoint. This does not assert engineering verification.',
        parameters: z.object({
          checkpointId: z.string().uuid(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(20).optional(),
        }),
        handler: async ({ checkpointId, offset = 0, limit = 12 }) => {
          if (!getScope()?.capabilityIds.length) throw Error('No current Broker capability scope.');
          return {
            output: boundedJson(
              await readContextPage(checkpointId, offset, limit),
              `Checkpoint ${checkpointId}`,
            ),
            message: 'Observed context read',
          };
        },
      }),
    );
  for (const canonicalId of scope.tools) {
    const name = canonicalNames[canonicalId];
    if (!name) continue;
    tools.push(
      createExternalTool({
        name,
        description: `Read metadata for an artifact through ${canonicalId}. This does not modify or verify the design.`,
        parameters: z.object({ artifactId: z.string() }),
        handler: async ({ artifactId }) => {
          if (!getScope()?.tools.includes(canonicalId))
            throw Error('Tool is outside the current Broker scope.');
          const artifact = await lookupArtifact(artifactId);
          if (
            !artifact ||
            (canonicalId.startsWith('eda.') && artifact.kind !== canonicalId.split('.')[1])
          )
            throw Error('Artifact is unavailable for this tool.');
          return {
            output: boundedJson(artifact, `Artifact ${artifactId}`),
            message: 'Artifact metadata read',
          };
        },
      }),
    );
  }
  return tools;
}

class KimiSession {
  constructor(
    workDir,
    getScope,
    lookupArtifact,
    disclose,
    emit,
    getRuntime,
    sessionFactory = createSession,
    diagnostics = {},
    plugins = [],
  ) {
    this.workDir = workDir;
    this.getScope = getScope;
    this.lookupArtifact = lookupArtifact;
    this.disclose = disclose;
    this.emit = emit;
    this.getRuntime = getRuntime;
    this.sessionFactory = sessionFactory;
    this.diagnostics = diagnostics;
    if (
      diagnostics.resources &&
      (typeof diagnostics.resolveSession !== 'function' ||
        typeof diagnostics.sessionInitialized !== 'function')
    )
      throw Error('Managed session resources require persistent native session callbacks.');
    this.resourceId = crypto.randomUUID();
    this.plugins = plugins;
    // ToolCall arrives with arguments:null; the real arguments stream in as
    // ToolCallPart frames (carrying no id) before the ToolResult lands. Track
    // them so the ToolResult event can carry the complete arguments. This is
    // per-turn state: run() clears it in its finally block so an interrupted
    // call cannot leak a phantom event into the next turn.
    this.pendingToolArgs = new Map();
    this.toolNames = new Map();
    this.lastToolCall = null;
    this.pendingApprovals = new Map();
    this.runtimeApprovals = new Map();
    this.pendingQuestions = new Map();
    this.backgroundTasks = false;
    this.nativeBackgroundRunning = false;
    this.backgroundWaiters = new Set();
  }
  async run(task, attachments = []) {
    if (this.running || this.turn || this.backgroundTasks)
      throw Error('A Kimi turn is already running.');
    const scope = this.getScope();
    if (!scope) throw Error('Resolve capabilities before starting the agent.');
    const { runtime, plugins, excluded } = require('./execution-policy.cjs').executionPolicy(
      this.getRuntime(),
      this.plugins,
      Boolean(this.diagnostics.industrialRuntime),
      this.diagnostics.industrialRuntime
        ?.descriptors?.()
        .filter(tool => tool.effect === 'external')
        .map(tool => tool.id),
    );
    if (!runtime.apiKey) throw Error('Set a model API key before running Kimi.');
    const approvalMode = runtime.approvalMode || 'ask';
    if (!['ask', 'auto'].includes(approvalMode)) throw Error('Invalid approval mode.');
    const images = validatePromptImages(attachments);
    if (images.length && !runtime.profile.imageInput)
      throw Error('Enable Image input in Model API settings for a model that supports images.');
    const currentScopeKey = scopeKey(scope);
    const mcpRuntime = this.diagnostics.industrialRuntime?.hostRuntimeOnly
      ? { hostRuntime: this.diagnostics.industrialRuntime.compatibilityKey() }
      : selectedRuntimeKey(
          scope,
          runtime.disabledMcpServers,
          runtime.environment,
          runtime.externalServers,
        );
    const currentMcpKey = JSON.stringify(mcpRuntime);
    const pluginKey = JSON.stringify(enabledPlugins(plugins).map(plugin => plugin.name));
    this.activePluginTools = new Set(
      enabledPlugins(plugins).flatMap(plugin => plugin.toolNames || []),
    );
    const log = createDiagnosticLog(this.workDir, {
      directory: this.diagnostics.directory,
      apiKey: runtime.apiKey,
      secrets: externalSecrets(runtime.externalServers || [], runtime.environment),
    });
    this.log = log;
    this.interruptRequested = false;
    this.backgroundResult = undefined;
    this.stopPromise = undefined;
    let finishTurn;
    this.turnFinished = new Promise(resolve => {
      finishTurn = resolve;
    });
    const forcedCancellation = new Promise(resolve => {
      this.cancelTurn = resolve;
    });
    this.running = true;
    this.turnMetrics = {
      peakContextUsage: null,
      lastContextUsage: null,
      compactions: 0,
      toolResults: 0,
      peakToolResultBytes: 0,
    };
    let metricsEmitted = false;
    const emitMetrics = () => {
      if (!metricsEmitted) {
        metricsEmitted = true;
        this.emitAgent({ type: 'context-metrics', ...this.turnMetrics });
      }
    };
    let outcome = 'error';
    let releaseResources;
    try {
      releaseResources = await this.diagnostics.resources?.acquire(this.resourceId, {
        dispose: async () => {
          await this.closeNative();
          this.diagnostics.onIdleRelease?.();
        },
        isBusy: () =>
          Boolean(
            this.running ||
              this.turn ||
              this.backgroundTasks ||
              this.pendingApprovals.size ||
              this.pendingQuestions.size,
          ),
      });
      if (this.interruptRequested) {
        outcome = 'cancelled';
        this.emitAgent({ type: 'done', result: { status: outcome } });
        return;
      }
      log.record('run.start', {
        projectDir: this.workDir,
        previousSessionId: this.session?.sessionId || null,
        scope,
        brokerTrace: this.diagnostics.getBrokerTrace?.() || [],
        model: {
          provider: runtime.profile.provider,
          model: runtime.profile.model,
          contextSize: runtime.profile.contextSize,
          thinking: runtime.profile.thinking,
          thinkingEffort: thinkingEffort(runtime.profile),
          imageInput: Boolean(runtime.profile.imageInput),
        },
        approvalMode,
        runtimeRevision: runtime.revision,
      });
      this.emitAgent({ type: 'diagnostic-log', traceId: log.traceId, path: log.file });
      if (excluded) {
        log.record('resource.filtered', { ...excluded, reason: 'protected-industrial-execution' });
        // A structured event instead of assistant text: the UI renders the
        // filtered services inline, and the transcript stays free of
        // model-voiced notices the model did not author.
        this.emitAgent({
          type: 'resources-filtered',
          externalMcp: excluded.externalMcp,
          plugins: excluded.plugins,
        });
      }
      const anchor = await this.diagnostics.getContextAnchor?.();
      const engineeringState = await this.diagnostics.industrialRuntime?.inspect();
      const { engineeringContext } = require('./engineering-context.cjs');
      const baseContext = industrialContext(scope, anchor, runtime.externalServers);
      const artifactBudget = Math.max(
        0,
        Math.min(
          2048,
          MAX_INDUSTRIAL_CONTEXT_BYTES -
            Buffer.byteLength(baseContext + engineeringContext(engineeringState, 0)),
        ),
      );
      const context = baseContext + engineeringContext(engineeringState, artifactBudget);
      if (Buffer.byteLength(context) > MAX_INDUSTRIAL_CONTEXT_BYTES)
        throw Error(
          'Broker scope and current State exceed the Industrial Context limit; narrow the selected capabilities before starting Kimi.',
        );
      if (anchor) log.record('context.anchor', anchor);
      const agentKey =
        runtime.agentSnapshot && runtime.agentSnapshot.id !== 'builtin:default'
          ? runtime.agentSnapshot.revision
          : null;
      const resetReason = !this.session
        ? 'new'
        : (this.lastAgentKey || null) !== agentKey
          ? 'agent_changed'
          : this.currentScopeKey !== currentScopeKey
            ? 'scope_changed'
            : this.runtimeRevision !== runtime.revision
              ? 'model_changed'
              : this.lastApprovalMode !== approvalMode
                ? 'approval_mode_changed'
                : this.lastPluginKey !== pluginKey
                  ? 'plugins_changed'
                  : this.currentMcpKey !== currentMcpKey
                    ? 'mcp_changed'
                    : null;
      if (resetReason) {
        log.record('session.create', {
          reason: resetReason,
          previousScopeKey: this.currentScopeKey || null,
          currentScopeKey,
        });
        if (this.session) await this.captureKimiSnapshot(log, 'before-reset', runtime.apiKey);
        await this.session?.close();
        for (const child of this.nativeChildren?.values() || [])
          if (['running', 'awaiting_approval'].includes(child.status))
            this.emitEvent({ type: 'SubagentState', payload: { ...child, status: 'cancelled' } });
        for (const id of this.pendingApprovals.keys()) this.resolveApproval(id, 'expired');
        for (const id of this.pendingQuestions.keys()) this.resolveQuestion(id, 'expired');
        this.controlTurn = undefined;
        this.session = undefined;
        this.processSandbox?.close();
        this.processSandbox = null;
        if (this.sessionConfigDir && !this.persistentSession)
          fs.rmSync(this.sessionConfigDir, { recursive: true, force: true });
        const compatibilityKey = crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              runtime: `kimi-code-server-v1:${KIMI_CODE_VERSION}`,
              scope: currentScopeKey,
              profile: runtime.profile,
              ...(agentKey ? { agent: agentKey } : {}),
              executable:
                !runtime.executable ||
                runtime.executable === 'kimi' ||
                runtime.executable === bundledExecutable()
                  ? `@moonshot-ai/kimi-code@${KIMI_CODE_VERSION}`
                  : runtime.executable,
              disabledMcpServers: runtime.disabledMcpServers || [],
              mcpRuntime,
              plugins: pluginKey,
              approvalMode,
              ...(this.sessionFactory === createSession
                ? {
                    executionBoundary: 'seatbelt-workspace-v1',
                    projectWorkspace: 'inputs-v1',
                  }
                : {}),
            }),
          )
          .digest('hex');
        this.persistentSession = this.diagnostics.resolveSession?.(compatibilityKey);
        const stored = this.persistentSession;
        if (stored?.initialized && this.sessionFactory !== createSession) {
          const context = path.join(
            createKimiPaths(stored.shareDir).sessionDir(this.workDir, stored.id),
            'context.jsonl',
          );
          if (!fs.existsSync(context) || !fs.statSync(context).size)
            throw Error(
              'Saved agent context is missing. Open a new chat; the existing history is preserved.',
            );
        }
        this.sessionConfigDir = prepareSessionFiles(
          scope,
          {
            ...runtime,
            hostRuntimeOnly: Boolean(this.diagnostics.industrialRuntime?.hostRuntimeOnly),
          },
          stored?.shareDir,
          this.workDir,
          plugins,
        );
        if (this.sessionFactory === createSession) {
          // Native child MCP gateways stay outside the industrial boundary.
          // Registered services instead use the audited host Runtime.
          const externalSelected = selectMcpServers(
            scope,
            runtime.disabledMcpServers,
            undefined,
            runtime.externalServers,
          ).some(provider => provider.transport === 'external');
          if ((externalSelected && !runtime.hostRuntimeExternal) || enabledPlugins(plugins).length)
            throw Error(
              '当前工业执行隔离不支持外部 MCP 服务或应用控制插件。请在本次项目资源设置中停用这些服务后重试；工业修改仅能通过已接入的 Domain Runtime。',
            );
          this.processSandbox = createProcessSandbox({
            executable:
              !runtime.executable || runtime.executable === 'kimi'
                ? bundledExecutable()
                : runtime.executable,
            shareDir: this.sessionConfigDir,
            projectDir: this.workDir,
            protectedPaths: this.diagnostics.protectedPaths || [],
            environment: { ...process.env, ...runtime.env },
            hostOnlyEnv: this.diagnostics.industrialRuntime?.hostOnlyEnv || [],
            kimiProjectAccess: true,
          });
          this.emitAgent({ type: 'execution-boundary', ...this.processSandbox.boundary });
        }
        this.nativeWorkDir = this.processSandbox?.workDir || this.workDir;
        const hostedTools = runtimeTools(
          this.diagnostics.industrialRuntime,
          this.getScope,
          (descriptor, request) => this.requestRuntimeApproval(descriptor, request),
          (result, context) => this.diagnostics.onIndustrialResult?.(result, context),
          {
            imageInput: Boolean(runtime.profile.imageInput),
            ownerId: this.resourceId,
            getApplicationContext: this.diagnostics.getApplicationContext,
          },
        );
        const appTools = applicationTools(this.diagnostics.getApplicationContext);
        this.hostRuntimeTools = new Set([...hostedTools, ...appTools].map(tool => tool.name));
        this.session = this.sessionFactory({
          workDir: this.processSandbox?.workDir || this.workDir,
          projectDir: this.workDir,
          ...(this.persistentSession ? { sessionId: this.persistentSession.id } : {}),
          executable: this.processSandbox?.executable || runtime.executable,
          shareDir: this.sessionConfigDir,
          resumeRequired: Boolean(stored?.initialized),
          model: 'industrial',
          agentProfile: nativeAgentProfile(runtime.agentSnapshot?.id),
          thinking: runtime.profile.thinking,
          thinkingEffort: thinkingEffort(runtime.profile),
          onBackgroundEvent: event => this.handleBackgroundEvent(event),
          env: this.processSandbox?.env || runtime.env,
          yoloMode: approvalMode === 'auto',
          externalTools: [
            ...appTools,
            ...hostedTools,
            ...externalTools(
              this.getScope,
              this.lookupArtifact,
              this.disclose,
              this.diagnostics.readContextPage,
            ),
            ...enabledPlugins(plugins).flatMap(plugin =>
              plugin.toolsFactory(this.diagnostics.pluginLog).map(tool => createExternalTool(tool)),
            ),
          ],
          clientInfo: { name: 'industrial-agent-harness', version: '0.0.0' },
        });
        this.currentScopeKey = currentScopeKey;
        this.currentMcpKey = currentMcpKey;
        this.runtimeRevision = runtime.revision;
        this.lastAgentKey = agentKey;
        this.lastPluginKey = pluginKey;
        this.lastApprovalMode = approvalMode;
        if (this.persistentSession?.replaced && !this.persistentSession.reused)
          this.emitAgent({
            type: 'context-reset',
            message:
              'Tools or model changed. A new context started; earlier messages remain available above.',
          });
        log.record('session.ready', { sessionId: this.session.sessionId || null, currentScopeKey });
      } else
        log.record('session.reuse', { sessionId: this.session.sessionId || null, currentScopeKey });
      const projectContext = this.processSandbox
        ? `\nBound engineering Project: ${this.workDir}. Native working directory is isolated session scratch; the project/ symlink exposes the real project for reading. Changes to scratch do not modify the engineering Project. Use absolute Project paths or project/ for inspection, and industrial_action_call for authorized engineering mutations.`
        : '';
      const prompt = `${context}${projectContext}\n\nUser task: ${task}${images.length ? '\nAttached images are user-provided visual references, not engineering verification.' : ''}`;
      const content = imageContent(prompt, images, runtime.profile.imageInput);
      log.record('prompt', {
        text: prompt,
        ...(images.length
          ? { images: images.map(({ dataUrl, ...metadata }) => metadata), content }
          : {}),
      });
      if (this.interruptRequested) {
        outcome = 'cancelled';
        this.emitAgent({ type: 'done', result: { status: outcome } });
        return;
      }
      const turn = this.session.prompt(content);
      this.turn = turn;
      this.controlTurn = turn;
      const consume = async () => {
        for await (const event of turn) {
          if (this.turn !== turn) return { status: 'cancelled' };
          log.record(
            event.type === 'NativeEvent' ? 'kimi-code.event' : 'sdk.event',
            redactImagePayloads(event),
          );
          this.emitEvent(event);
        }
        return await turn.result;
      };
      const result = await Promise.race([consume(), forcedCancellation]);
      emitMetrics();
      outcome = result.status;
      this.emitAgent({ type: 'done', result });
    } catch (error) {
      if (this.turn) {
        this.interruptRequested = true;
        try {
          await this.closeNative();
        } catch (closeError) {
          error = new AggregateError(
            [error, closeError],
            `${error.message}; ${closeError.message}`,
          );
        }
      }
      emitMetrics();
      this.emitAgent({ type: 'error', message: String(error) });
    } finally {
      try {
        this.turn = undefined;
        if (!this.backgroundTasks) {
          this.pendingToolArgs.clear();
          this.toolNames.clear();
          this.lastToolCall = null;
        }
        for (const id of this.pendingApprovals.keys())
          if (!this.backgroundApprovals?.has(id)) this.resolveApproval(id, 'expired');
        for (const [id, question] of this.pendingQuestions)
          if (question.state === 'pending' && !question.background)
            this.resolveQuestion(id, 'expired');
        await this.captureKimiSnapshot(log, 'after-turn', runtime.apiKey);
        if (
          this.persistentSession &&
          this.sessionConfigDir &&
          (this.session?.contextInitialized ||
            fs.existsSync(
              path.join(
                createKimiPaths(this.sessionConfigDir).sessionDir(
                  this.nativeWorkDir || this.workDir,
                  this.persistentSession.id,
                ),
                'context.jsonl',
              ),
            ))
        )
          this.diagnostics.sessionInitialized?.(this.persistentSession.id);
        log.record('run.end', {
          status: outcome,
          sessionId: this.session?.sessionId || null,
          metrics: this.turnMetrics,
          brokerTrace: this.diagnostics.getBrokerTrace?.() || [],
        });
      } finally {
        try {
          if (this.backgroundTasks) this.backgroundLog = log;
          else log.close();
        } finally {
          if (!this.backgroundTasks) this.log = undefined;
          this.running = false;
          this.cancelTurn = undefined;
          finishTurn();
          if (this.backgroundTasks) this.backgroundRelease = releaseResources;
          else releaseResources?.();
        }
      }
    }
  }
  async captureKimiSnapshot(log, phase, apiKey) {
    if (!this.sessionConfigDir || !this.session?.sessionId) return;
    if (this.session.diagnosticSnapshot) {
      try {
        const rows = await this.session.diagnosticSnapshot();
        if (!rows) return;
        let content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
        if (apiKey) content = content.replaceAll(apiKey, '[REDACTED_API_KEY]');
        const target = path.join(path.dirname(log.file), `${log.traceId}.${phase}.context.jsonl`);
        fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
        log.record('kimi.snapshot', {
          phase,
          kind: 'context',
          format: 'kimi-code-server-v1',
          path: target,
          bytes: Buffer.byteLength(content),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        });
      } catch (error) {
        log.record('kimi.snapshot_error', { phase, kind: 'context', message: String(error) });
      }
      return;
    }
    const sessionDir = path.join(
      createKimiPaths(this.sessionConfigDir).sessionsDir(this.nativeWorkDir || this.workDir),
      this.session.sessionId,
    );
    for (const kind of ['context', 'wire']) {
      const source = path.join(sessionDir, `${kind}.jsonl`);
      try {
        if (!fs.existsSync(source)) continue;
        const raw = fs.readFileSync(source, 'utf8');
        const content = redactSnapshotText(
          apiKey ? raw.replaceAll(apiKey, '[REDACTED_API_KEY]') : raw,
        );
        const target = path.join(path.dirname(log.file), `${log.traceId}.${phase}.${kind}.jsonl`);
        fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
        log.record('kimi.snapshot', {
          phase,
          kind,
          path: target,
          bytes: Buffer.byteLength(content, 'utf8'),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        });
      } catch (error) {
        log.record('kimi.snapshot_error', { phase, kind, message: String(error) });
      }
    }
  }
  emitAgent(event) {
    this.log?.record('harness.event', event);
    this.emit(event);
  }
  liveBackgroundChildren() {
    return [...(this.nativeChildren?.values() || [])].some(
      child => child.background && ['running', 'awaiting_approval'].includes(child.status),
    );
  }
  liveBackgroundWork() {
    return (
      this.nativeBackgroundRunning ||
      this.liveBackgroundChildren() ||
      [...(this.nativeTasks?.values() || [])].some(
        task => task.background && (task.status === 'running' || task.notificationPending),
      ) ||
      (this.nativeWork?.busy && !this.nativeWork.main_turn_active)
    );
  }
  async waitForBackgroundIdle() {
    if (this.backgroundTasks) await new Promise(resolve => this.backgroundWaiters.add(resolve));
    // Stop/needs_input can end the native follow-up before its transport and
    // pending controls finish closing. Headless's final result comes last.
    await this.closing;
    return this.backgroundResult;
  }
  handleBackgroundEvent(event) {
    this.log?.record(
      event.type === 'NativeEvent' ? 'kimi-code.event' : 'sdk.event',
      redactImagePayloads(event),
    );
    this.emitEvent(event);
  }
  updateBackgroundBusy() {
    this.setBackgroundBusy(Boolean(this.liveBackgroundWork()));
  }
  setBackgroundBusy(busy) {
    if (this.backgroundTasks === busy) return;
    this.backgroundTasks = busy;
    if (!busy) {
      this.backgroundRelease?.();
      this.backgroundRelease = undefined;
    }
    this.emitAgent({ type: 'background-state', running: busy });
    if (!busy) {
      if (!this.running) {
        this.pendingToolArgs.clear();
        this.toolNames.clear();
        this.lastToolCall = null;
      }
      if (this.backgroundLog) {
        this.backgroundLog.close();
        if (this.log === this.backgroundLog) this.log = undefined;
        this.backgroundLog = undefined;
      }
      for (const resolve of this.backgroundWaiters) resolve(this.backgroundResult);
      this.backgroundWaiters.clear();
    }
  }
  emitEvent(event) {
    if (event.type === 'BackgroundFailure') {
      this.emitAgent({ type: 'error', message: event.payload.message });
      void this.closeNative().catch(error =>
        this.emitAgent({ type: 'error', message: String(error) }),
      );
    } else if (event.type === 'BackgroundTurnBegin') {
      this.nativeBackgroundRunning = true;
      this.setBackgroundBusy(true);
    } else if (event.type === 'BackgroundTurnEnd') {
      this.nativeBackgroundRunning = false;
      this.backgroundResult = event.payload.result;
      if (event.payload.error) {
        this.emitAgent({ type: 'error', message: event.payload.error });
        void this.closeNative().catch(error =>
          this.emitAgent({ type: 'error', message: String(error) }),
        );
      } else this.updateBackgroundBusy();
    } else if (event.type === 'BackgroundTaskState') {
      this.nativeTasks ||= new Map();
      this.nativeTasks.set(event.payload.id, event.payload);
      this.updateBackgroundBusy();
    } else if (event.type === 'NativeWorkState') {
      this.nativeWork = event.payload;
      this.updateBackgroundBusy();
    } else if (event.type === 'SubagentState') {
      this.nativeChildren ||= new Map();
      this.nativeChildren.set(event.payload.agentId, event.payload);
      this.updateBackgroundBusy();
      this.emitAgent({ type: 'subagent-state', ...event.payload });
    } else if (event.type === 'ContentPart') {
      if (event.payload.type === 'text') this.emitAgent({ type: 'text', text: event.payload.text });
      else if (event.payload.type === 'think')
        this.emitAgent({ type: 'thinking', text: event.payload.think });
    } else if (event.type === 'ApprovalRequest') {
      this.pendingApprovals.set(event.payload.id, 'pending');
      if (event.payload.background) {
        this.backgroundApprovals ||= new Set();
        this.backgroundApprovals.add(event.payload.id);
      }
      const hostedApproval =
        event.payload.harness_callback === true && this.hostRuntimeTools?.has(event.payload.sender);
      if (
        hostedApproval ||
        this.lastApprovalMode === 'auto' ||
        this.activePluginTools?.has(event.payload.sender)
      ) {
        // Harness Runtime callbacks enforce Scope and approval inside their
        // handlers. Preserve that boundary instead of adding an MCP transport
        // approval before discovery or before recording a rejected Action.
        this.log?.record('approval.auto', {
          sender: event.payload.sender,
          id: event.payload.id,
          reason: hostedApproval
            ? 'host_runtime_boundary'
            : this.lastApprovalMode === 'auto'
              ? 'user_mode'
              : 'enabled_plugin',
        });
        this.approve(event.payload.id, hostedApproval ? 'approve' : 'approve_for_session').catch(
          error =>
            this.emitAgent({
              type: 'approval_error',
              id: event.payload.id,
              message: String(error),
            }),
        );
      } else
        this.emitAgent({
          type: 'approval',
          agentId: event.payload.agentId,
          background: event.payload.background,
          id: event.payload.id,
          description: event.payload.description,
          action: event.payload.action,
          agentId: event.payload.agentId,
        });
    } else if (event.type === 'QuestionRequest') {
      const { id, tool_call_id, questions } = event.payload;
      this.pendingQuestions.set(id, {
        state: 'pending',
        questions,
        background: event.payload.background,
      });
      this.emitAgent({
        type: 'question',
        id,
        toolCallId: tool_call_id,
        questions,
        agentId: event.payload.agentId,
        background: event.payload.background,
      });
    } else if (event.type === 'ApprovalResponse')
      this.resolveApproval(event.payload.request_id, event.payload.response);
    else if (event.type === 'ToolCall') {
      if (this.lastToolCall && this.pendingToolArgs.has(this.lastToolCall.id)) {
        this.emitAgent({
          type: 'tool',
          id: this.lastToolCall.id,
          name: this.toolNames.get(this.lastToolCall.id) || this.lastToolCall.name,
          arguments: this.pendingToolArgs.get(this.lastToolCall.id),
        });
      }
      this.pendingToolArgs.set(event.payload.id, '');
      this.toolNames.set(event.payload.id, event.payload.function.name);
      this.lastToolCall = { id: event.payload.id, name: event.payload.function.name };
      this.emitAgent({
        type: 'tool',
        id: event.payload.id,
        name: event.payload.function.name,
        arguments: event.payload.function.arguments || '',
      });
    } else if (event.type === 'ToolCallPart') {
      if (this.lastToolCall)
        this.pendingToolArgs.set(
          this.lastToolCall.id,
          (this.pendingToolArgs.get(this.lastToolCall.id) || '') +
            (event.payload.arguments_part || ''),
        );
    } else if (event.type === 'ToolResult') {
      const value = event.payload.return_value;
      const rawArgs = this.pendingToolArgs.get(event.payload.tool_call_id) || '';
      if (rawArgs) {
        let args = rawArgs;
        try {
          args = JSON.stringify(JSON.parse(rawArgs), null, 2);
        } catch {}
        this.emitAgent({
          type: 'tool',
          id: event.payload.tool_call_id,
          name: this.toolNames.get(event.payload.tool_call_id) || '',
          arguments: args,
        });
      }
      this.pendingToolArgs.delete(event.payload.tool_call_id);
      this.toolNames.delete(event.payload.tool_call_id);
      if (this.lastToolCall?.id === event.payload.tool_call_id) this.lastToolCall = null;
      this.turnMetrics.toolResults++;
      // output is a string or a ContentPart array (image results). Base64 image
      // payloads must not enter the event stream or logs; keep only the text
      // parts plus a count.
      let output;
      let imageCount = 0;
      if (typeof value.output === 'string') output = value.output;
      else {
        const parts = Array.isArray(value.output) ? value.output : [];
        imageCount = parts.filter(part => ['image_url', 'image'].includes(part?.type)).length;
        output = parts
          .filter(part => part?.type === 'text')
          .map(part => part.text)
          .join('\n');
      }
      const outputBytes = Buffer.byteLength(output, 'utf8');
      this.turnMetrics.peakToolResultBytes = Math.max(
        this.turnMetrics.peakToolResultBytes,
        outputBytes,
      );
      this.emitAgent({
        type: 'tool-result',
        id: event.payload.tool_call_id,
        error: value.is_error,
        message: value.message,
        output: output.slice(0, 12000),
        outputBytes,
        outputTruncated: output.length > 12000,
        imageCount,
      });
      for (const block of value.display || [])
        if (block.type === 'todo' && Array.isArray(block.items))
          this.emitAgent({ type: 'todo', items: block.items });
    } else if (event.type === 'StepBegin')
      this.emitAgent({ type: 'step', number: event.payload.n });
    else if (event.type === 'StatusUpdate') {
      const usage = event.payload.context_usage;
      if (typeof usage === 'number' && Number.isFinite(usage)) {
        this.turnMetrics.lastContextUsage = usage;
        this.turnMetrics.peakContextUsage = Math.max(this.turnMetrics.peakContextUsage ?? 0, usage);
      }
      this.emitAgent({
        type: 'status',
        contextUsage: usage ?? null,
        tokenUsage: event.payload.token_usage ?? null,
      });
    } else if (event.type === 'CompactionBegin') {
      this.turnMetrics.compactions++;
      this.emitAgent({ type: 'compaction', state: 'begin' });
    } else if (event.type === 'CompactionEnd') this.emitAgent({ type: 'compaction', state: 'end' });
  }
  resolveApproval(id, decision) {
    if (!this.pendingApprovals.has(id)) return;
    this.pendingApprovals.delete(id);
    this.backgroundApprovals?.delete(id);
    this.emitAgent({ type: 'approval-resolved', id, decision });
  }
  resolveQuestion(id, decision, answers) {
    if (!this.pendingQuestions.has(id)) return;
    this.pendingQuestions.delete(id);
    this.emitAgent({ type: 'question-resolved', id, decision, ...(answers ? { answers } : {}) });
  }
  async answerQuestion(id, answers) {
    const pending = this.pendingQuestions.get(id);
    if (!(this.turn || (pending?.background && this.controlTurn)) || pending?.state !== 'pending')
      throw Error('This question is no longer pending.');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers))
      throw Error('Provide answers for the pending questions.');
    const skipped = Object.keys(answers).length === 0;
    if (
      !skipped &&
      (Object.keys(answers).length !== pending.questions.length ||
        pending.questions.some(
          item =>
            typeof answers[item.question] !== 'string' ||
            !answers[item.question].trim() ||
            answers[item.question].length > 4096,
        ))
    )
      throw Error('Answer every question before continuing.');
    this.pendingQuestions.set(id, { ...pending, state: 'submitting' });
    try {
      // The transport adapts the existing question identifier to its native API.
      await (this.turn || this.controlTurn).respondQuestion(id, id, answers);
      this.log?.record('question.response', { id, answers });
      this.resolveQuestion(id, skipped ? 'skipped' : 'answered', answers);
    } catch (error) {
      if (this.pendingQuestions.has(id)) {
        if (this.turn) this.pendingQuestions.set(id, pending);
        else this.resolveQuestion(id, 'expired');
      }
      throw error;
    }
  }
  requestRuntimeApproval(descriptor, request) {
    if (this.lastApprovalMode === 'auto') return Promise.resolve(true);
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      this.pendingApprovals.set(id, 'pending');
      this.runtimeApprovals.set(id, resolve);
      if (this.backgroundTasks) {
        this.backgroundApprovals ||= new Set();
        this.backgroundApprovals.add(id);
      }
      this.emitAgent({
        type: 'approval',
        id,
        description: `Execute ${descriptor.id} through the persistent industrial runtime.`,
        action: descriptor.id,
        stateId: request.expectedStateId,
        preview: this.diagnostics.industrialRuntime?.approvalPreview?.(request),
      });
    });
  }
  async approve(id, response) {
    if (!['approve', 'approve_for_session', 'reject'].includes(response))
      throw Error('Invalid approval decision.');
    if (this.runtimeApprovals.has(id)) {
      this.runtimeApprovals.get(id)(response !== 'reject');
      this.runtimeApprovals.delete(id);
      this.resolveApproval(id, response);
      return;
    }
    if (
      !(this.turn || (this.backgroundApprovals?.has(id) && this.controlTurn)) ||
      this.pendingApprovals.get(id) !== 'pending'
    )
      throw Error('This approval is no longer pending.');
    this.pendingApprovals.set(id, 'submitting');
    try {
      await (this.turn || this.controlTurn).approve(id, response);
      this.log?.record('approval.response', { id, response });
      this.resolveApproval(id, response);
    } catch (error) {
      if (this.pendingApprovals.has(id)) this.pendingApprovals.set(id, 'pending');
      throw error;
    }
  }
  interrupt() {
    this.diagnostics.industrialRuntime?.cancel(this.resourceId);
    for (const [id, resolve] of this.runtimeApprovals) {
      resolve(false);
      this.resolveApproval(id, 'reject');
    }
    this.runtimeApprovals.clear();
    if (this.running) this.interruptRequested = true;
    this.log?.record('turn.interrupt', {});
    const turn = this.turn;
    if (this.backgroundTasks) return this.closeNative();
    if (!turn) return;
    if (this.stopPromise) return this.stopPromise;
    const turnFinished = this.turnFinished;
    // The pinned SDK can leave turn.result pending after a signal-killed CLI.
    // Give native cancellation a grace period, then close only this actor.
    let timer;
    const fallback = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (this.turn !== turn) return resolve();
        this.closeNative().then(resolve, reject);
      }, this.diagnostics.interruptGraceMs ?? 3000);
    });
    const requested = Promise.resolve()
      .then(() => turn.interrupt())
      .catch(() => {});
    const stopPromise = Promise.race([requested.then(() => turnFinished), fallback]).finally(() => {
      clearTimeout(timer);
      if (this.stopPromise === stopPromise) this.stopPromise = undefined;
    });
    this.stopPromise = stopPromise;
    return stopPromise;
  }
  async close() {
    if (this.running) this.interruptRequested = true;
    this.diagnostics.industrialRuntime?.cancel(this.resourceId);
    await this.diagnostics.industrialRuntime?.waitForIdle(this.resourceId);
    await this.diagnostics.industrialRuntime?.releaseOwner?.(this.resourceId);
    await this.diagnostics.resources?.remove(this.resourceId);
    await this.closeNative();
  }
  async closeNative() {
    if (this.closing) return this.closing;
    this.closing = this.disposeNative().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
  async disposeNative() {
    for (const [id, resolve] of this.runtimeApprovals) {
      resolve(false);
      this.resolveApproval(id, 'expired');
    }
    this.runtimeApprovals.clear();
    await this.session?.close();
    for (const child of this.nativeChildren?.values() || [])
      if (['running', 'awaiting_approval'].includes(child.status))
        this.emitEvent({ type: 'SubagentState', payload: { ...child, status: 'cancelled' } });
    for (const id of this.pendingApprovals.keys()) this.resolveApproval(id, 'expired');
    for (const id of this.pendingQuestions.keys()) this.resolveQuestion(id, 'expired');
    this.controlTurn = undefined;
    this.nativeBackgroundRunning = false;
    this.nativeTasks?.clear();
    this.nativeWork = undefined;
    this.backgroundResult = { status: 'cancelled' };
    this.setBackgroundBusy(false);
    if (this.interruptRequested && this.turn) this.cancelTurn?.({ status: 'cancelled' });
    this.session = undefined;
    if (this.sessionConfigDir && !this.persistentSession)
      fs.rmSync(this.sessionConfigDir, { recursive: true, force: true });
    this.sessionConfigDir = undefined;
    this.processSandbox?.close();
    this.processSandbox = null;
  }
}

module.exports = {
  ...require('./agent-profiles.cjs'),
  createProcessSandbox,
  runtimeTools,
  KimiSession,
  bundledExecutable,
  KIMI_CODE_VERSION,
  externalTools,
  prepareSessionFiles,
  boundedJson,
  industrialContext,
  scopeKey,
};
