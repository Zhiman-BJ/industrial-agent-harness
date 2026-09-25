const {createSession, createExternalTool, createKimiPaths} = require('@moonshot-ai/kimi-agent-sdk');
const {z} = require('zod');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {materializeSkills} = require('@industrial-agent-harness/domain-skills');
const {selectMcpServers, writeMcpConfig} = require('@industrial-agent-harness/domain-mcp');
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

function prepareSessionFiles(scope, runtime) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-session-'));
  fs.chmodSync(directory, 0o700);
  try {
    const skillsDir = materializeSkills(scope, directory);
    const modelConfig = fs.readFileSync(path.join(runtime.shareDir, 'config.toml'), 'utf8');
    fs.writeFileSync(path.join(directory, 'config.toml'), `extra_skill_dirs = [${JSON.stringify(skillsDir)}]\n${modelConfig}`, {mode: 0o600});
    writeMcpConfig(directory, selectMcpServers(scope, runtime.disabledMcpServers));
    return directory;
  } catch (error) {fs.rmSync(directory, {recursive: true, force: true}); throw error;}
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
  constructor(workDir, getScope, lookupArtifact, disclose, emit, getRuntime, sessionFactory = createSession, diagnostics = {}) {
    this.workDir = workDir;
    this.getScope = getScope;
    this.lookupArtifact = lookupArtifact;
    this.disclose = disclose;
    this.emit = emit;
    this.getRuntime = getRuntime;
    this.sessionFactory = sessionFactory;
    this.diagnostics = diagnostics;
  }
  async run(task) {
    if (this.turn) throw Error('A Kimi turn is already running.');
    const scope = this.getScope();
    if (!scope) throw Error('Resolve capabilities before starting the agent.');
    const runtime = this.getRuntime();
    if (!runtime.apiKey) throw Error('Set a model API key before running Kimi.');
    const currentScopeKey = scopeKey(scope);
    const log = createDiagnosticLog(this.workDir, {directory: this.diagnostics.directory, apiKey: runtime.apiKey});
    this.log = log;
    this.turnMetrics = {peakContextUsage: null, lastContextUsage: null, compactions: 0, toolResults: 0, peakToolResultBytes: 0};
    let metricsEmitted = false;
    const emitMetrics = () => {if (!metricsEmitted) {metricsEmitted = true; this.emitAgent({type: 'context-metrics', ...this.turnMetrics});}};
    let outcome = 'error';
    try {
      log.record('run.start', {projectDir: this.workDir, previousSessionId: this.session?.sessionId || null, scope, brokerTrace: this.diagnostics.getBrokerTrace?.() || [], model: {provider: runtime.profile.provider, model: runtime.profile.model, contextSize: runtime.profile.contextSize, thinking: runtime.profile.thinking}, runtimeRevision: runtime.revision});
      this.emitAgent({type: 'diagnostic-log', traceId: log.traceId, path: log.file});
      const anchor = await this.diagnostics.getContextAnchor?.();
      const context = industrialContext(scope, anchor);
      if (anchor) log.record('context.anchor', anchor);
      const resetReason = !this.session ? 'new' : this.currentScopeKey !== currentScopeKey ? 'scope_changed' : this.runtimeRevision !== runtime.revision ? 'model_changed' : null;
      if (resetReason) {
        log.record('session.create', {reason: resetReason, previousScopeKey: this.currentScopeKey || null, currentScopeKey});
        if (this.session) this.captureKimiSnapshot(log, 'before-reset', runtime.apiKey);
        await this.session?.close();
        this.session = undefined;
        if (this.sessionConfigDir) fs.rmSync(this.sessionConfigDir, {recursive: true, force: true});
        this.sessionConfigDir = prepareSessionFiles(scope, runtime);
        this.session = this.sessionFactory({
          workDir: this.workDir,
          executable: runtime.executable,
          shareDir: this.sessionConfigDir,
          model: 'industrial',
          thinking: runtime.profile.thinking,
          env: runtime.env,
          yoloMode: false,
          externalTools: externalTools(this.getScope, this.lookupArtifact, this.disclose, this.diagnostics.readContextPage),
          clientInfo: {name: 'industrial-agent-harness', version: '0.0.0'},
        });
        this.currentScopeKey = currentScopeKey;
        this.runtimeRevision = runtime.revision;
        log.record('session.ready', {sessionId: this.session.sessionId || null, currentScopeKey});
      } else log.record('session.reuse', {sessionId: this.session.sessionId || null, currentScopeKey});
      const prompt = `${context}\n\nUser task: ${task}`;
      log.record('prompt', {text: prompt});
      const turn = this.session.prompt(prompt);
      this.turn = turn;
      for await (const event of turn) {log.record('sdk.event', event); this.emitEvent(event);}
      const result = await turn.result;
      emitMetrics();
      outcome = result.status;
      this.emitAgent({type: 'done', result});
    } catch (error) {emitMetrics(); this.emitAgent({type: 'error', message: String(error)});}
    finally {
      this.turn = undefined;
      try {
        this.captureKimiSnapshot(log, 'after-turn', runtime.apiKey);
        log.record('run.end', {status: outcome, sessionId: this.session?.sessionId || null, metrics: this.turnMetrics, brokerTrace: this.diagnostics.getBrokerTrace?.() || []});
      }
      finally {log.close(); this.log = undefined;}
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
        const content = apiKey ? raw.replaceAll(apiKey, '[REDACTED_API_KEY]') : raw;
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
    } else if (event.type === 'ApprovalRequest') this.emitAgent({type: 'approval', id: event.payload.id, description: event.payload.description, action: event.payload.action});
    else if (event.type === 'ToolCall') this.emitAgent({type: 'tool', id: event.payload.id, name: event.payload.function.name, arguments: event.payload.function.arguments || ''});
    else if (event.type === 'ToolResult') {
      const value = event.payload.return_value;
      this.turnMetrics.toolResults++;
      const output = typeof value.output === 'string' ? value.output : '';
      const outputBytes = Buffer.byteLength(output, 'utf8');
      this.turnMetrics.peakToolResultBytes = Math.max(this.turnMetrics.peakToolResultBytes, outputBytes);
      this.emitAgent({type: 'tool-result', id: event.payload.tool_call_id, error: value.is_error, message: value.message, output: output.slice(0, 12000), outputBytes, outputTruncated: output.length > 12000});
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
  approve(id, response) {if (!this.turn) throw Error('No active turn.'); this.log?.record('approval.response', {id, response}); return this.turn.approve(id, response);}
  interrupt() {this.log?.record('turn.interrupt', {}); return this.turn?.interrupt();}
  async close() {await this.session?.close(); this.session = undefined; if (this.sessionConfigDir) fs.rmSync(this.sessionConfigDir, {recursive: true, force: true}); this.sessionConfigDir = undefined;}
}

module.exports = {KimiSession, externalTools, prepareSessionFiles, boundedJson, industrialContext, scopeKey};
