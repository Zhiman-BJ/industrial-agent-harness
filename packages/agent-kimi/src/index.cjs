const {createSession, createExternalTool, createKimiPaths} = require('@moonshot-ai/kimi-agent-sdk');
const {z} = require('zod');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {materializeSkills} = require('@industrial-agent-harness/domain-skills');
const {selectMcpServers, writeMcpConfig} = require('@industrial-agent-harness/domain-mcp');
const {validatePromptImages, imageContent} = require('./image-input.cjs');
const {createDiagnosticLog} = require('./diagnostic-log.cjs');

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
  if (bytes > MAX_TOOL_OUTPUT_BYTES) throw Error(`${resource} result is ${bytes} bytes, above the ${MAX_TOOL_OUTPUT_BYTES}-byte limit. Request a narrower capability section or artifact.`);
  return output;
}

function scopeKey(scope) {
  return JSON.stringify({domain: scope.domain, stage: scope.stage, capabilityIds: scope.capabilityIds, skills: scope.skills, tools: scope.tools});
}

function industrialContext(scope, anchor = null) {
  const context = scope.capabilityIds.length
    ? `Industrial Context (current Broker scope): ${scopeKey(scope)}. Use industrial_capability_detail to load details when needed. Artifact metadata tools are read-only. Treat viewer output as inspection, not engineering verification.`
    : 'No industrial capability was selected for this task. Work within the chosen project using standard Kimi tools.';
  const readHint = scope.capabilityIds.length ? 'Use industrial_context_read for more registered artifacts or after compaction.' : 'Select an industrial capability to enable checkpoint detail tools.';
  const withAnchor = value => `${context}\nObserved project checkpoint: ${JSON.stringify(value)}. These are file observations with content hashes, not engineering verification. ${readHint}`;
  let complete = anchor ? withAnchor(anchor) : context;
  if (anchor && Buffer.byteLength(complete, 'utf8') > MAX_INDUSTRIAL_CONTEXT_BYTES) {
    complete = withAnchor({checkpointId: anchor.checkpointId, stateHash: anchor.stateHash, domain: anchor.domain, artifactCount: anchor.artifactCount, staleArtifactCount: anchor.staleArtifactCount ?? anchor.staleArtifactIds?.length ?? 0, verificationStatus: 'not_run', hasMore: true});
  }
  if (Buffer.byteLength(complete, 'utf8') > MAX_INDUSTRIAL_CONTEXT_BYTES) throw Error('Broker scope exceeds the Industrial Context limit; narrow the selected capabilities before starting Kimi.');
  return complete;
}

function prepareSessionFiles(scope, runtime, persistentDirectory, plugins = []) {
  const directory = persistentDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-session-'));
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.chmodSync(directory, 0o700);
  try {
    const skillsDir = materializeSkills(scope, directory);
    const skillDirs = [...new Set([skillsDir, ...enabledPlugins(plugins).map(plugin => plugin.materializeSkill(directory))])];
    const modelConfig = fs.readFileSync(path.join(runtime.shareDir, 'config.toml'), 'utf8');
    fs.writeFileSync(path.join(directory, 'config.toml'), `extra_skill_dirs = [${skillDirs.map(dir => JSON.stringify(dir)).join(',')}]\n${modelConfig}`, {mode: 0o600});
    writeMcpConfig(directory, selectMcpServers(scope, runtime.disabledMcpServers));
    return directory;
  } catch (error) {if (!persistentDirectory) fs.rmSync(directory, {recursive: true, force: true}); throw error;}
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
      return {...part, image_url: {...part.image_url, url: `[image redacted, ${part.image_url.url.length} chars]`}};
    }
    return part;
  });
  return redacted ? {...event, payload: {...event.payload, return_value: {...value, output}}} : event;
}

// The native CLI history (context/wire snapshots) embeds tool-result images as
// base64 data URIs. The same payloads redactImagePayloads keeps out of the
// event log must also stay out of the copied files.
const DATA_URI_PATTERN = /(data:image\/[a-zA-Z0-9.+-]+;base64,)([A-Za-z0-9+/=]+)/g;
function redactSnapshotText(text) {
  return text.replace(DATA_URI_PATTERN, (match, prefix, payload) => `${prefix}[image redacted, ${payload.length} chars]`);
}

function externalTools(getScope, lookupArtifact, disclose, readContextPage) {
  const scope = getScope();
  if (!scope?.capabilityIds.length) return [];
  const tools = [createExternalTool({
    name: 'industrial_capability_detail',
    description: 'Read a selected industrial capability. Use section to request only skills, tools, or verification when the full detail is large.',
    parameters: z.object({capabilityId: z.string(), section: z.enum(['all', 'skills', 'tools', 'verification']).optional()}),
    handler: async ({capabilityId, section = 'all'}) => {
      if (!getScope()?.capabilityIds.includes(capabilityId)) throw Error('Capability is outside the current Broker scope.');
      const detail = disclose(capabilityId);
      const selected = section === 'all' ? detail : {capability: detail.capability, [section]: detail[section]};
      return {output: boundedJson(selected, `Capability ${capabilityId} ${section}`), message: 'Capability detail disclosed'};
    },
  })];
  if (readContextPage) tools.push(createExternalTool({
    name: 'industrial_context_read',
    description: 'Read a page of registered project-file observations from a durable checkpoint. This does not assert engineering verification.',
    parameters: z.object({checkpointId: z.string().uuid(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(20).optional()}),
    handler: async ({checkpointId, offset = 0, limit = 12}) => {
      if (!getScope()?.capabilityIds.length) throw Error('No current Broker capability scope.');
      return {output: boundedJson(await readContextPage(checkpointId, offset, limit), `Checkpoint ${checkpointId}`), message: 'Observed context read'};
    },
  }));
  for (const canonicalId of scope.tools) {
    const name = canonicalNames[canonicalId];
    if (!name) continue;
    tools.push(createExternalTool({
      name,
      description: `Read metadata for an artifact through ${canonicalId}. This does not modify or verify the design.`,
      parameters: z.object({artifactId: z.string()}),
      handler: async ({artifactId}) => {
        if (!getScope()?.tools.includes(canonicalId)) throw Error('Tool is outside the current Broker scope.');
        const artifact = await lookupArtifact(artifactId);
        if (!artifact || (canonicalId.startsWith('eda.') && artifact.kind !== canonicalId.split('.')[1])) throw Error('Artifact is unavailable for this tool.');
        return {output: boundedJson(artifact, `Artifact ${artifactId}`), message: 'Artifact metadata read'};
      },
    }));
  }
  return tools;
}

class KimiSession {
  constructor(workDir, getScope, lookupArtifact, disclose, emit, getRuntime, sessionFactory = createSession, diagnostics = {}, plugins = []) {
    this.workDir = workDir;
    this.getScope = getScope;
    this.lookupArtifact = lookupArtifact;
    this.disclose = disclose;
    this.emit = emit;
    this.getRuntime = getRuntime;
    this.sessionFactory = sessionFactory;
    this.diagnostics = diagnostics;
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
  }
  async run(task, attachments = []) {
    if (this.running || this.turn) throw Error('A Kimi turn is already running.');
    const scope = this.getScope();
    if (!scope) throw Error('Resolve capabilities before starting the agent.');
    const runtime = this.getRuntime();
    if (!runtime.apiKey) throw Error('Set a model API key before running Kimi.');
    const images = validatePromptImages(attachments);
    if (images.length && !runtime.profile.imageInput) throw Error('Enable Image input in Model API settings for a model that supports images.');
    const currentScopeKey = scopeKey(scope);
    const pluginKey = JSON.stringify(enabledPlugins(this.plugins).map(plugin => plugin.name));
    this.activePluginTools = new Set(enabledPlugins(this.plugins).flatMap(plugin => plugin.toolNames || []));
    const log = createDiagnosticLog(this.workDir, {directory: this.diagnostics.directory, apiKey: runtime.apiKey});
    this.log = log;
    this.running = true;
    this.turnMetrics = {peakContextUsage: null, lastContextUsage: null, compactions: 0, toolResults: 0, peakToolResultBytes: 0};
    let metricsEmitted = false;
    const emitMetrics = () => {if (!metricsEmitted) {metricsEmitted = true; this.emitAgent({type: 'context-metrics', ...this.turnMetrics});}};
    let outcome = 'error';
    try {
      log.record('run.start', {projectDir: this.workDir, previousSessionId: this.session?.sessionId || null, scope, brokerTrace: this.diagnostics.getBrokerTrace?.() || [], model: {provider: runtime.profile.provider, model: runtime.profile.model, contextSize: runtime.profile.contextSize, thinking: runtime.profile.thinking, imageInput: Boolean(runtime.profile.imageInput)}, runtimeRevision: runtime.revision});
      this.emitAgent({type: 'diagnostic-log', traceId: log.traceId, path: log.file});
      const anchor = await this.diagnostics.getContextAnchor?.();
      const context = industrialContext(scope, anchor);
      if (anchor) log.record('context.anchor', anchor);
      const resetReason = !this.session ? 'new' : this.currentScopeKey !== currentScopeKey ? 'scope_changed' : this.runtimeRevision !== runtime.revision ? 'model_changed' : this.lastPluginKey !== pluginKey ? 'plugins_changed' : null;
      if (resetReason) {
        log.record('session.create', {reason: resetReason, previousScopeKey: this.currentScopeKey || null, currentScopeKey});
        if (this.session) this.captureKimiSnapshot(log, 'before-reset', runtime.apiKey);
        await this.session?.close();
        this.session = undefined;
        if (this.sessionConfigDir && !this.persistentSession) fs.rmSync(this.sessionConfigDir, {recursive: true, force: true});
        const compatibilityKey = crypto.createHash('sha256').update(JSON.stringify({scope: currentScopeKey, profile: runtime.profile, executable: runtime.executable || 'kimi', disabledMcpServers: runtime.disabledMcpServers || [], plugins: pluginKey})).digest('hex');
        this.persistentSession = this.diagnostics.resolveSession?.(compatibilityKey);
        const stored = this.persistentSession;
        if (stored?.initialized) {
          const context = path.join(createKimiPaths(stored.shareDir).sessionDir(this.workDir, stored.id), 'context.jsonl');
          if (!fs.existsSync(context) || !fs.statSync(context).size) throw Error('Saved agent context is missing. Open a new chat; the existing history is preserved.');
        }
        this.sessionConfigDir = prepareSessionFiles(scope, runtime, stored?.shareDir, this.plugins);
        this.session = this.sessionFactory({
          workDir: this.workDir,
          ...(this.persistentSession ? {sessionId: this.persistentSession.id} : {}),
          executable: runtime.executable,
          shareDir: this.sessionConfigDir,
          model: 'industrial',
          thinking: runtime.profile.thinking,
          env: runtime.env,
          yoloMode: false,
          externalTools: [...externalTools(this.getScope, this.lookupArtifact, this.disclose, this.diagnostics.readContextPage), ...enabledPlugins(this.plugins).flatMap(plugin => plugin.toolsFactory(this.diagnostics.pluginLog).map(tool => createExternalTool(tool)))],
          clientInfo: {name: 'industrial-agent-harness', version: '0.0.0'},
        });
        this.currentScopeKey = currentScopeKey;
        this.runtimeRevision = runtime.revision;
        this.lastPluginKey = pluginKey;
        if (this.persistentSession?.replaced && !this.persistentSession.reused) this.emitAgent({type: 'context-reset', message: 'Tools or model changed. A new context started; earlier messages remain available above.'});
        log.record('session.ready', {sessionId: this.session.sessionId || null, currentScopeKey});
      } else log.record('session.reuse', {sessionId: this.session.sessionId || null, currentScopeKey});
      const prompt = `${context}\n\nUser task: ${task}${images.length ? '\nAttached images are user-provided visual references, not engineering verification.' : ''}`;
      const content = imageContent(prompt, images, runtime.profile.imageInput);
      log.record('prompt', {text: prompt, ...(images.length ? {images: images.map(({dataUrl, ...metadata}) => metadata), content} : {})});
      const turn = this.session.prompt(content);
      this.turn = turn;
      for await (const event of turn) {log.record('sdk.event', redactImagePayloads(event)); this.emitEvent(event);}
      const result = await turn.result;
      emitMetrics();
      outcome = result.status;
      this.emitAgent({type: 'done', result});
    } catch (error) {emitMetrics(); this.emitAgent({type: 'error', message: String(error)});}
    finally {
      this.turn = undefined;
      this.pendingToolArgs.clear();
      this.toolNames.clear();
      this.lastToolCall = null;
      for (const id of this.pendingApprovals.keys()) this.resolveApproval(id, 'expired');
      try {
        this.captureKimiSnapshot(log, 'after-turn', runtime.apiKey);
        if (this.persistentSession && this.sessionConfigDir && fs.existsSync(path.join(createKimiPaths(this.sessionConfigDir).sessionDir(this.workDir, this.persistentSession.id), 'context.jsonl'))) this.diagnostics.sessionInitialized?.(this.persistentSession.id);
        log.record('run.end', {status: outcome, sessionId: this.session?.sessionId || null, metrics: this.turnMetrics, brokerTrace: this.diagnostics.getBrokerTrace?.() || []});
      }
      finally {log.close(); this.log = undefined; this.running = false;}
    }
  }
  captureKimiSnapshot(log, phase, apiKey) {
    if (!this.sessionConfigDir || !this.session?.sessionId) return;
    const sessionDir = path.join(createKimiPaths(this.sessionConfigDir).sessionsDir(this.workDir), this.session.sessionId);
    for (const kind of ['context', 'wire']) {
      const source = path.join(sessionDir, `${kind}.jsonl`);
      try {
        if (!fs.existsSync(source)) continue;
        const raw = fs.readFileSync(source, 'utf8');
        const content = redactSnapshotText(apiKey ? raw.replaceAll(apiKey, '[REDACTED_API_KEY]') : raw);
        const target = path.join(path.dirname(log.file), `${log.traceId}.${phase}.${kind}.jsonl`);
        fs.writeFileSync(target, content, {flag: 'wx', mode: 0o600});
        log.record('kimi.snapshot', {phase, kind, path: target, bytes: Buffer.byteLength(content, 'utf8'), sha256: crypto.createHash('sha256').update(content).digest('hex')});
      } catch (error) {log.record('kimi.snapshot_error', {phase, kind, message: String(error)});}
    }
  }
  emitAgent(event) {this.log?.record('harness.event', event); this.emit(event);}
  emitEvent(event) {
    if (event.type === 'ContentPart') {
      if (event.payload.type === 'text') this.emitAgent({type: 'text', text: event.payload.text});
      else if (event.payload.type === 'think') this.emitAgent({type: 'thinking', text: event.payload.think});
    } else if (event.type === 'ApprovalRequest') {
      this.pendingApprovals.set(event.payload.id, 'pending');
      if (this.activePluginTools?.has(event.payload.sender)) {
        // Enabling the plugin is the authorization: auto-approve its tool
        // approvals for this session instead of surfacing them to the user.
        this.log?.record('plugin.auto-approve', {sender: event.payload.sender, id: event.payload.id});
        this.approve(event.payload.id, 'approve_for_session').catch(error => this.emitAgent({type: 'approval_error', id: event.payload.id, message: String(error)}));
      } else this.emitAgent({type: 'approval', id: event.payload.id, description: event.payload.description, action: event.payload.action});
    }
    else if (event.type === 'ApprovalResponse') this.resolveApproval(event.payload.request_id, event.payload.response);
    else if (event.type === 'ToolCall') {
      if (this.lastToolCall && this.pendingToolArgs.has(this.lastToolCall.id)) {
        this.emitAgent({type: 'tool', id: this.lastToolCall.id, name: this.toolNames.get(this.lastToolCall.id) || this.lastToolCall.name, arguments: this.pendingToolArgs.get(this.lastToolCall.id)});
      }
      this.pendingToolArgs.set(event.payload.id, '');
      this.toolNames.set(event.payload.id, event.payload.function.name);
      this.lastToolCall = {id: event.payload.id, name: event.payload.function.name};
      this.emitAgent({type: 'tool', id: event.payload.id, name: event.payload.function.name, arguments: event.payload.function.arguments || ''});
    } else if (event.type === 'ToolCallPart') {
      if (this.lastToolCall) this.pendingToolArgs.set(this.lastToolCall.id, (this.pendingToolArgs.get(this.lastToolCall.id) || '') + (event.payload.arguments_part || ''));
    } else if (event.type === 'ToolResult') {
      const value = event.payload.return_value;
      const rawArgs = this.pendingToolArgs.get(event.payload.tool_call_id) || '';
      if (rawArgs) {
        let args = rawArgs;
        try {args = JSON.stringify(JSON.parse(rawArgs), null, 2);} catch {}
        this.emitAgent({type: 'tool', id: event.payload.tool_call_id, name: this.toolNames.get(event.payload.tool_call_id) || '', arguments: args});
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
        imageCount = parts.filter(part => part?.type === 'image_url').length;
        output = parts.filter(part => part?.type === 'text').map(part => part.text).join('\n');
      }
      const outputBytes = Buffer.byteLength(output, 'utf8');
      this.turnMetrics.peakToolResultBytes = Math.max(this.turnMetrics.peakToolResultBytes, outputBytes);
      this.emitAgent({type: 'tool-result', id: event.payload.tool_call_id, error: value.is_error, message: value.message, output: output.slice(0, 12000), outputBytes, outputTruncated: output.length > 12000, imageCount});
      for (const block of value.display || []) if (block.type === 'todo' && Array.isArray(block.items)) this.emitAgent({type: 'todo', items: block.items});
    } else if (event.type === 'StepBegin') this.emitAgent({type: 'step', number: event.payload.n});
    else if (event.type === 'StatusUpdate') {
      const usage = event.payload.context_usage;
      if (typeof usage === 'number' && Number.isFinite(usage)) {
        this.turnMetrics.lastContextUsage = usage;
        this.turnMetrics.peakContextUsage = Math.max(this.turnMetrics.peakContextUsage ?? 0, usage);
      }
      this.emitAgent({type: 'status', contextUsage: usage ?? null, tokenUsage: event.payload.token_usage ?? null});
    }
    else if (event.type === 'CompactionBegin') {this.turnMetrics.compactions++; this.emitAgent({type: 'compaction', state: 'begin'});}
    else if (event.type === 'CompactionEnd') this.emitAgent({type: 'compaction', state: 'end'});
  }
  resolveApproval(id, decision) {
    if (!this.pendingApprovals.has(id)) return;
    this.pendingApprovals.delete(id);
    this.emitAgent({type: 'approval-resolved', id, decision});
  }
  async approve(id, response) {
    if (!['approve', 'approve_for_session', 'reject'].includes(response)) throw Error('Invalid approval decision.');
    if (!this.turn || this.pendingApprovals.get(id) !== 'pending') throw Error('This approval is no longer pending.');
    this.pendingApprovals.set(id, 'submitting');
    try {
      await this.turn.approve(id, response);
      this.log?.record('approval.response', {id, response});
      this.resolveApproval(id, response);
    } catch (error) {
      if (this.pendingApprovals.has(id)) this.pendingApprovals.set(id, 'pending');
      throw error;
    }
  }
  interrupt() {this.log?.record('turn.interrupt', {}); return this.turn?.interrupt();}
  async close() {await this.session?.close(); this.session = undefined; if (this.sessionConfigDir && !this.persistentSession) fs.rmSync(this.sessionConfigDir, {recursive: true, force: true}); this.sessionConfigDir = undefined;}
}

module.exports = {KimiSession, externalTools, prepareSessionFiles, boundedJson, industrialContext, scopeKey};
