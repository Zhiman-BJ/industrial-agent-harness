const {
  ChatStore,
  defaultChatDirectory,
  SessionResourceManager,
  resolveProjectTask,
  runtimeCapabilities,
  effectiveCapabilities,
  ResourceSettings,
  resourceCatalog,
  defaultResourceDirectory,
  ExternalMcpRegistry,
  AgentProfiles,
  DEFAULT_AGENT_ID,
} = require('@industrial-agent-harness/harness-core');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const {
  KimiSession,
  agentToolCatalog,
  validateAgentTools,
} = require('@industrial-agent-harness/agent-kimi');
const { ObservedContextStore } = require('@industrial-agent-harness/domain-runtime');
const { discloseDetail } = require('@industrial-agent-harness/capability-broker');
const { PackManager } = require('@industrial-agent-harness/pack-manager');
const { SessionManager, finishTurn } = require('./session-manager.cjs');
const { resolveResultArtifact } = require('./result-artifacts.cjs');
const { TaskResults } = require('./results.cjs');
const { ProjectRuntimes } = require('./project-runtimes.cjs');

// Application orchestration is above canonical Core and below both adapters.
// Kimi still owns its native turn, context, compaction and background work.
class TaskService {
  constructor(options = {}) {
    this.options = options;
    this.environment = options.environment || process.env;
    this.sessions = new SessionManager();
    this.operations = new Set();

    this.resources = new SessionResourceManager({
      environment: this.environment,
      directory: options.resourceDirectory,
    });
    this.projects = new ProjectRuntimes({
      environment: this.environment,
      ...options.runtimeOptions,
    });
    this.settings =
      options.resourceSettings ||
      new ResourceSettings(options.resourceDirectory || defaultResourceDirectory(this.environment));
    this.external =
      options.externalRegistry ||
      new ExternalMcpRegistry(
        options.resourceDirectory || defaultResourceDirectory(this.environment),
      );
    this.packManager =
      options.packManager ||
      (this.environment.INDUSTRIAL_HARNESS_PACK_STORE ? new PackManager() : null);
    this.Session = options.Session || KimiSession;
    this.agents = new AgentProfiles(
      options.resourceDirectory || defaultResourceDirectory(this.environment),
    );
  }
  get chats() {
    return (this.chatStore ||= new ChatStore(
      this.options.chatDirectory || defaultChatDirectory(this.environment),
    ));
  }
  registry() {
    return this.options.getRegistry?.() || loadRegistry();
  }
  agentCatalog(project) {
    return { ...this.agents.catalog(this.registry(), project), tools: agentToolCatalog };
  }
  saveAgent(input) {
    validateAgentTools(input);
    return this.agents.save(this.registry(), input);
  }
  setProjectAgent(project, id) {
    this.agents.setDefault(this.registry(), project, id);
    return this.agentCatalog(project);
  }
  chatAgent(project, chatId) {
    const chat = this.chats.get(chatId, project.path, project.domain);
    let snapshot = this.chats.agentSnapshot(chatId);
    if (!snapshot) {
      snapshot = this.agents.snapshot(
        this.registry(),
        project,
        chat.agentLocked ? DEFAULT_AGENT_ID : undefined,
      );
      this.chats.setAgentSnapshot(chatId, project.path, project.domain, snapshot, true);
    }
    return snapshot;
  }
  setChatAgent(project, chatId, id) {
    if (this.sessions.busy(this.sessions.find(chatId)))
      throw Error('Stop this chat before changing its Agent.');
    const snapshot = this.agents.snapshot(this.registry(), project, id);
    const chat = this.chats.setAgentSnapshot(chatId, project.path, project.domain, snapshot);
    const entry = this.sessions.find(chatId);
    if (entry) entry.agentSnapshot = snapshot;
    this.options.onChanged?.();
    return chat;
  }
  newChat(project, { agentId, preferredId, draft = true } = {}) {
    this.agents.snapshot(this.registry(), project, agentId);
    const chat = draft
      ? this.chats.createDraft(project.path, project.domain, preferredId)
      : this.chats.create(project.path, project.domain);
    return this.setChatAgent(project, chat.id, agentId);
  }
  resume(project, chatId) {
    if (this.closing) throw Error('Task session is unavailable.');
    const entry = this.sessions.get(project, chatId);
    this.chats.get(chatId, project.path, project.domain);
    entry.agentSnapshot = this.chatAgent(project, chatId);
    if (!entry.scope && !this.sessions.busy(entry)) {
      const last = this.chats.history(chatId, project.path, project.domain).turns.at(-1);
      entry.scope = last?.broker?.scope;
      entry.resolvedRequest = last?.broker?.request || (last ? { task: last.task } : undefined);
    }
    return entry;
  }
  policy(entry, registry) {
    const catalog = resourceCatalog(entry.project.domain, entry.externalServers);
    const saved =
      this.options.resourcePolicy?.(entry.project) ||
      this.settings.snapshot(catalog, entry.project.path).effective;
    const disabled = {
      skills: [...new Set([...saved.skills, ...(entry.overrides?.skills || [])])],
      mcpServers: [...new Set([...saved.mcpServers, ...(entry.overrides?.mcpServers || [])])],
    };
    const allowedSkills = entry.agentSnapshot?.profiles[0].skills;
    if (allowedSkills)
      disabled.skills = [
        ...new Set([
          ...disabled.skills,
          ...catalog.skills
            .filter(skill => !allowedSkills.includes(skill.id))
            .map(skill => skill.id),
        ]),
      ];
    for (const [key, values] of Object.entries(disabled))
      for (const id of values)
        if (!catalog[key].some(item => item.id === id))
          throw Error(`Unknown project ${key === 'skills' ? 'skill' : 'MCP'}: ${id}`);
    return disabled;
  }
  async resolve(entry, request, registry = this.registry(), preview = false) {
    if (!registry.domains.some(item => item.id === entry.project.domain))
      throw Error('Choose a valid project domain.');
    entry.runtimeBundle = preview ? undefined : this.projects.get(entry.project, registry);
    entry.externalServers = entry.runtimeBundle?.runtime.hostRuntimeOnly
      ? []
      : this.external.records();
    const state = entry.runtimeBundle ? await entry.runtimeBundle.runtime.inspect() : null;
    entry.disabled = this.policy(entry, registry);
    return resolveProjectTask(
      entry.project.domain,
      { ...request, ...(state ? { state } : {}) },
      entry.scope,
      runtimeCapabilities(registry, entry.runtimeBundle),
      entry.disabled,
      entry.externalServers,
      registry.domains,
    );
  }
  async diagnose(project) {
    const bundle = this.projects.get(project, this.registry());
    const state = await bundle.runtime.inspect(),
      toolId = 'project.environment.inspect';
    const result = await bundle.runtime.execute(
      { toolId, inputs: {}, expectedStateId: state.id },
      {
        scope: {
          domain: project.domain,
          projectId: state.projectId,
          stateId: state.id,
          tools: [toolId],
        },
      },
    );
    if (result.action.status !== 'completed') throw Error(result.action.diagnostics.join('\n'));
    return {
      report: JSON.parse(bundle.runtime.readArtifact(result.artifacts[0].id).content),
      actionId: result.action.id,
    };
  }
  assertEntry(entry) {
    if (this.closing || this.sessions.find(entry?.id) !== entry)
      throw Error('Task session is unavailable.');
  }
  beginOperation() {
    let done;
    const settled = new Promise(resolve => (done = resolve));
    this.operations.add(settled);
    return () => {
      this.operations.delete(settled);
      done();
    };
  }
  async prepare(entry, request, { preview = false, persist = true, overrides } = {}) {
    this.assertEntry(entry);
    if (this.sessions.busy(entry)) throw Error('This chat is already running.');
    entry.agentSnapshot = persist
      ? this.chatAgent(entry.project, entry.id)
      : entry.agentSnapshot || this.agents.snapshot(this.registry(), entry.project);
    if (
      typeof request?.task !== 'string' ||
      !request.task.trim() ||
      Buffer.byteLength(request.task, 'utf8') > 128 * 1024
    )
      throw Error('Describe the task first.');
    entry.resolving = true;
    const settled = this.beginOperation();
    let release;
    try {
      if (persist) {
        release = this.chats.acquire(entry.id);
        entry.agentSnapshot = this.chats.agentSnapshot(entry.id);
      }
      entry.overrides = overrides;
      const result = await this.resolve(entry, request, this.registry(), preview);
      this.assertEntry(entry);
      entry.resolvedRequest = { ...request };
      result.request = entry.resolvedRequest;
      entry.scope = result.scope;
      entry.trace = result.trace;
      if (persist)
        entry.preparedTurn = {
          id: this.chats.beginTurn(entry.id, request.task, result, false),
          task: request.task,
          broker: result,
        };
      this.options.onChanged?.();
      return {
        ...result,
        chatId: entry.id,
        ...(entry.preparedTurn ? { turnId: entry.preparedTurn.id } : {}),
      };
    } finally {
      try {
        release?.();
      } finally {
        entry.resolving = false;
        settled();
      }
    }
  }
  context(entry) {
    return (entry.context ||= new ObservedContextStore(
      entry.project.path,
      entry.project.domain,
      this.options.contextOptions || this.options.runtimeOptions || {},
    ));
  }
  detail(entry, id) {
    const detail = discloseDetail(
      entry.scope,
      effectiveCapabilities(
        runtimeCapabilities(this.registry(), entry.runtimeBundle),
        entry.disabled || this.policy(entry),
      ),
      id,
    );
    entry.trace.push({
      level: 'L3',
      event: 'detail.load',
      detail: {
        capabilityId: id,
        skills: detail.skills.map(item => item.id),
        tools: detail.tools.map(item => item.id),
      },
    });
    entry.onDisclosure?.(id, detail);
    return detail;
  }
  async start(entry, task, options = {}) {
    this.assertEntry(entry);
    if (this.sessions.busy(entry)) throw Error('This chat is already running.');
    if (!entry.scope || entry.resolvedRequest?.task !== task)
      throw Error('Resolve this task in the current chat first.');
    let turnId;
    entry.cancelReason = undefined;
    const settled = this.beginOperation();
    try {
      entry.releasePack = this.packManager?.acquireUse(entry.project.domain);
      entry.release = this.chats.acquire(entry.id);
      this.chats.recoverInterrupted();
      const current = await this.resolve(entry, { ...entry.resolvedRequest, task });
      this.assertEntry(entry);
      current.request = entry.resolvedRequest;
      entry.scope = current.scope;
      entry.trace = current.trace;
      turnId =
        entry.preparedTurn?.task === task
          ? entry.preparedTurn.id
          : this.chats.beginTurn(entry.id, task, current, false);
      this.chats.updateBroker(turnId, current);
      entry.preparedTurn = undefined;
      this.chats.start(turnId);
      let outcome;
      const emit = event => {
        if (
          ['subagent-state', 'background-state'].includes(event.type) &&
          !entry.agent?.backgroundTasks
        )
          entry.backgroundRelease?.();
        const recorded = this.chats.append(turnId, event);
        entry.eventRevision = (entry.eventRevision || 0) + 1;
        if (event.type === 'done' || event.type === 'error') outcome = event;
        if (
          event.type === 'background-state' &&
          !entry.agent?.backgroundTasks &&
          entry.resultContext?.turnId === turnId &&
          entry.resultContext.wasBackground
        )
          entry.resultContext.settle(entry.cancelReason || outcome?.result?.status || 'incomplete');
        const metadata = {
          chatId: entry.id,
          projectId: entry.project.id,
          turnId,
          eventRevision: entry.eventRevision,
        };
        const displayed = ['results-changed', 'results-ready'].includes(recorded.type)
          ? {
              ...recorded,
              results:
                entry.resultContext?.turnId === turnId
                  ? entry.resultContext.view(recorded.results)
                  : new TaskResults(
                      this.chats,
                      entry,
                      turnId,
                      entry.runtimeBundle?.runtime,
                      () => {},
                    ).view(recorded.results),
            }
          : recorded;
        this.options.onEvent?.(displayed, metadata);
        options.onEvent?.(displayed, metadata);
        if (
          [
            'background-state',
            'subagent-state',
            'approval',
            'approval-resolved',
            'question',
            'question-resolved',
            'done',
            'error',
          ].includes(event.type)
        )
          this.options.onChanged?.();
      };
      const resultContext = new TaskResults(
        this.chats,
        entry,
        turnId,
        entry.runtimeBundle?.runtime,
        emit,
      );
      entry.resultContext = resultContext;
      resultContext.onIndustrialResult = async result => {
        resultContext.register(result);
        if (entry.resultContext === resultContext) {
          const refreshed = resolveProjectTask(
            entry.project.domain,
            { ...entry.resolvedRequest, state: result.state },
            entry.scope,
            runtimeCapabilities(this.registry(), entry.runtimeBundle),
            entry.disabled,
            entry.externalServers,
            this.registry().domains,
          );
          Object.assign(entry.scope, refreshed.scope);
          entry.trace.push(...refreshed.trace);
        }
        emit({ type: 'industrial-result', ...result });
        return resultContext.view();
      };
      for (const [id, artifact] of options.artifacts || [])
        await this.context(entry).observeArtifact({
          id,
          kind: artifact.metadata.kind,
          file: artifact.file,
        });
      this.assertEntry(entry);
      entry.onDisclosure = options.onDisclosure;
      entry.agent ||= new this.Session(
        entry.project.path,
        () => entry.scope,
        id => this.context(entry).readArtifact(id),
        id => this.detail(entry, id),
        emit,
        () => ({
          ...(options.getConfig || this.options.getConfig)(entry),
          agentSnapshot: entry.agentSnapshot,
        }),
        options.createSession || this.options.createSession,
        {
          industrialRuntime: entry.runtimeBundle?.runtime,
          protectedPaths: entry.runtimeBundle?.protectedPaths,
          getApplicationContext: () => entry.resultContext,
          onIndustrialResult: (result, context) =>
            (context || entry.resultContext).onIndustrialResult(result),
          resources: this.resources,
          onIdleRelease: () => {
            if (this.closing) return;
            entry.context?.close();
            entry.context = undefined;
          },
          directory: options.logDirectory || this.options.logDirectory,
          getBrokerTrace: () => entry.trace,
          getContextAnchor: () => this.context(entry).anchor(),
          readContextPage: (checkpointId, offset, limit) =>
            this.context(entry).readPage(checkpointId, offset, limit),
          resolveSession: key => this.chats.runtimeSession(entry.id, key),
          sessionInitialized: id => this.chats.initialized(id),
          pluginLog: (canonicalId, risk, args, info) => {
            entry.trace.push({
              level: 'L2',
              event: 'plugin.tool-call',
              detail: { plugin: 'computer-use', tool: canonicalId, risk, args, ...info },
            });
            if (entry.trace.length > 500) entry.trace.splice(0, entry.trace.length - 500);
          },
        },
        options.plugins || this.options.plugins?.(entry) || [],
      );
      entry.agent.emit = emit;
      if (options.images?.length) emit({ type: 'user-images', images: options.images });
      const completion = (async () => {
        try {
          await entry.agent.run(task, options.images || []);
          if (options.waitForBackground) {
            const result = await entry.agent.waitForBackgroundIdle?.();
            if (result && outcome?.type !== 'error') outcome = { type: 'done', result };
          }
        } catch (error) {
          emit({ type: 'error', message: String(error) });
        } finally {
          const status =
            entry.cancelReason ||
            (outcome?.type === 'error'
              ? 'error'
              : outcome?.type === 'done'
                ? outcome.result.status
                : 'incomplete');
          resultContext.settle(status, Boolean(entry.agent?.backgroundTasks));
          finishTurn(
            entry,
            () => this.chats.finish(turnId, status),
            () => this.options.onChanged?.(),
          );
        }
        const state = entry.runtimeBundle ? await entry.runtimeBundle.runtime.inspect() : null;
        return {
          status:
            entry.cancelReason ||
            (outcome?.type === 'error'
              ? 'error'
              : outcome?.type === 'done'
                ? outcome.result.status
                : 'incomplete'),
          chatId: entry.id,
          turnId,
          results: resultContext.view(),
          ...(state
            ? {
                engineering: {
                  stateId: state.id,
                  status: state.status,
                  checkpointId: entry.runtimeBundle.runtime.latestCheckpoint()?.id,
                },
              }
            : {}),
        };
      })();
      entry.completion = completion;
      this.options.onChanged?.();
      return { started: true, chatId: entry.id, turnId, completion };
    } catch (error) {
      if (turnId) this.chats.finish(turnId, this.closing ? 'interrupted' : 'error');
      finishTurn(
        entry,
        () => {},
        () => this.options.onChanged?.(),
      );
      throw error;
    } finally {
      settled();
    }
  }
  approve(entry, id, response) {
    if (!entry.agent) throw Error('No active approval.');
    return entry.agent.approve(id, response);
  }
  answer(entry, id, answers) {
    if (!entry.agent) throw Error('No active question.');
    return entry.agent.answerQuestion(id, answers);
  }
  cancel(entry, reason = 'interrupted') {
    entry.cancelReason = reason;
    return entry.agent?.interrupt();
  }
  history(project, id, before = null) {
    const entry = this.sessions.find(id);
    const history = this.chats.history(id, project.path, project.domain, before);
    const resultEvent = event => ['results-changed', 'results-ready'].includes(event.type);
    if (history.turns.some(turn => turn.events.some(resultEvent))) {
      const records = this.projects.read(project);
      const contentStatuses = new Map();
      try {
        history.turns = history.turns.map(turn => {
          const results = new TaskResults(this.chats, { id, project }, turn.id, records, () => {});
          return {
            ...turn,
            events: turn.events.map(event =>
              resultEvent(event)
                ? { ...event, results: results.view(event.results, contentStatuses) }
                : event,
            ),
          };
        });
      } finally {
        records?.close();
      }
    }
    return {
      ...history,
      executing: this.sessions.busy(entry),
      eventRevision: entry?.eventRevision || 0,
    };
  }
  results(entry, turnId) {
    this.chats.get(entry.id, entry.project.path, entry.project.domain);
    if (!this.chats.turnBelongsTo(entry.id, turnId))
      throw Error('Result request belongs to another chat.');
    const runtime =
      entry.runtimeBundle?.runtime || this.projects.get(entry.project, this.registry())?.runtime;
    return new TaskResults(this.chats, entry, turnId, runtime, () => {}).view();
  }
  async openResult(entry, request) {
    if (request.chatId && request.chatId !== entry.id)
      throw Error('Result request belongs to another chat.');
    this.chats.get(entry.id, entry.project.path, entry.project.domain);
    const events = this.chats.turnEvents(entry.id, request.turnId);
    const runtime =
      entry.runtimeBundle?.runtime || this.projects.get(entry.project, this.registry())?.runtime;
    let group;
    if (request.groupId) {
      const view = this.results(entry, request.turnId);
      group = view.groups.find(group => group.id === request.groupId);
      if (!group || !group.artifacts.some(artifact => artifact.id === request.artifactId))
        throw Error('Output is outside this recorded result group.');
    } else if (
      !events.some(
        event => event.type === 'industrial-result' && event.action?.id === request.actionId,
      )
    )
      throw Error('Output Action is outside this request.');
    const artifact = runtime.get('artifact', request.artifactId);
    const resolved = await resolveResultArtifact(runtime, {
      actionId: group ? artifact?.actionId : request.actionId,
      artifactId: request.artifactId,
    });
    const companions = [];
    if (
      group &&
      !request.revealOnly &&
      [group.primaryArtifactId, group.previewArtifactId].includes(request.artifactId)
    )
      for (const id of group.companionArtifactIds)
        companions.push(
          await resolveResultArtifact(runtime, { actionId: group.actionId, artifactId: id }),
        );
    return { ...resolved, companions };
  }
  evidence(entry, id) {
    return entry.runtimeBundle?.runtime.readArtifact(id) || this.context(entry).readArtifact(id);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      const errors = [];
      const active = this.sessions.matching();
      for (const entry of active)
        if (this.sessions.busy(entry)) entry.cancelReason ||= 'interrupted';
      for (const close of [
        async () => {
          try {
            await this.sessions.close(() => Promise.all([...this.operations]));
          } finally {
            const completed = await Promise.allSettled(active.map(entry => entry.completion));
            errors.push(
              ...completed
                .filter(result => result.status === 'rejected')
                .map(result => result.reason),
            );
          }
        },
        () => this.projects.close(),
        () => this.resources.close(),
        () => this.chatStore?.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Task service cleanup failed.');
    });
    return this.closing;
  }
}
module.exports = { TaskService, SessionManager, ProjectRuntimes, finishTurn };
