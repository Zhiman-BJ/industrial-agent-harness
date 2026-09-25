const {createSession, createExternalTool} = require('@moonshot-ai/kimi-agent-sdk');
const {z} = require('zod');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {materializeSkills} = require('@industrial-agent-harness/domain-skills');
const {selectMcpServers, writeMcpConfig} = require('@industrial-agent-harness/domain-mcp');

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

function industrialContext(scope) {
  const context = scope.capabilityIds.length
    ? `Industrial Context (current Broker scope): ${scopeKey(scope)}. Use industrial_capability_detail to load details when needed. Artifact metadata tools are read-only. Treat viewer output as inspection, not engineering verification.`
    : 'No industrial capability was selected for this task. Work within the chosen project using standard Kimi tools.';
  if (Buffer.byteLength(context, 'utf8') > MAX_INDUSTRIAL_CONTEXT_BYTES) throw Error('Broker scope exceeds the Industrial Context limit; narrow the selected capabilities before starting Kimi.');
  return context;
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

function externalTools(getScope, lookupArtifact, disclose) {
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
  constructor(workDir, getScope, lookupArtifact, disclose, emit, getRuntime, sessionFactory = createSession) {
    this.workDir = workDir;
    this.getScope = getScope;
    this.lookupArtifact = lookupArtifact;
    this.disclose = disclose;
    this.emit = emit;
    this.getRuntime = getRuntime;
    this.sessionFactory = sessionFactory;
  }
  async run(task) {
    if (this.turn) throw Error('A Kimi turn is already running.');
    const scope = this.getScope();
    if (!scope) throw Error('Resolve capabilities before starting the agent.');
    const runtime = this.getRuntime();
    if (!runtime.apiKey) throw Error('Set a model API key before running Kimi.');
    const currentScopeKey = scopeKey(scope);
    const context = industrialContext(scope);
    if (!this.session || this.currentScopeKey !== currentScopeKey || this.runtimeRevision !== runtime.revision) {
      await this.session?.close();
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
        externalTools: externalTools(this.getScope, this.lookupArtifact, this.disclose),
        clientInfo: {name: 'industrial-agent-harness', version: '0.0.0'},
      });
      this.currentScopeKey = currentScopeKey;
      this.runtimeRevision = runtime.revision;
    }
    this.turnMetrics = {peakContextUsage: null, lastContextUsage: null, compactions: 0, toolResults: 0, peakToolResultBytes: 0};
    let metricsEmitted = false;
    const emitMetrics = () => {if (!metricsEmitted) {metricsEmitted = true; this.emit({type: 'context-metrics', ...this.turnMetrics});}};
    try {
      const turn = this.session.prompt(`${context}\n\nUser task: ${task}`);
      this.turn = turn;
      for await (const event of turn) this.emitEvent(event);
      const result = await turn.result;
      emitMetrics();
      this.emit({type: 'done', result});
    } catch (error) {emitMetrics(); this.emit({type: 'error', message: String(error)});}
    finally {this.turn = undefined;}
  }
  emitEvent(event) {
    if (event.type === 'ContentPart') {
      if (event.payload.type === 'text') this.emit({type: 'text', text: event.payload.text});
      else if (event.payload.type === 'think') this.emit({type: 'thinking', text: event.payload.think});
    } else if (event.type === 'ApprovalRequest') this.emit({type: 'approval', id: event.payload.id, description: event.payload.description, action: event.payload.action});
    else if (event.type === 'ToolCall') this.emit({type: 'tool', id: event.payload.id, name: event.payload.function.name, arguments: event.payload.function.arguments || ''});
    else if (event.type === 'ToolResult') {
      const value = event.payload.return_value;
      this.turnMetrics.toolResults++;
      const output = typeof value.output === 'string' ? value.output : '';
      const outputBytes = Buffer.byteLength(output, 'utf8');
      this.turnMetrics.peakToolResultBytes = Math.max(this.turnMetrics.peakToolResultBytes, outputBytes);
      this.emit({type: 'tool-result', id: event.payload.tool_call_id, error: value.is_error, message: value.message, output: output.slice(0, 12000), outputBytes, outputTruncated: output.length > 12000});
      for (const block of value.display || []) if (block.type === 'todo' && Array.isArray(block.items)) this.emit({type: 'todo', items: block.items});
    } else if (event.type === 'StepBegin') this.emit({type: 'step', number: event.payload.n});
    else if (event.type === 'StatusUpdate') {
      const usage = event.payload.context_usage;
      if (typeof usage === 'number' && Number.isFinite(usage)) {
        this.turnMetrics.lastContextUsage = usage;
        this.turnMetrics.peakContextUsage = Math.max(this.turnMetrics.peakContextUsage ?? 0, usage);
      }
      this.emit({type: 'status', contextUsage: usage ?? null, tokenUsage: event.payload.token_usage ?? null});
    }
    else if (event.type === 'CompactionBegin') {this.turnMetrics.compactions++; this.emit({type: 'compaction', state: 'begin'});}
    else if (event.type === 'CompactionEnd') this.emit({type: 'compaction', state: 'end'});
  }
  approve(id, response) {if (!this.turn) throw Error('No active turn.'); return this.turn.approve(id, response);}
  interrupt() {return this.turn?.interrupt();}
  async close() {await this.session?.close(); this.session = undefined; if (this.sessionConfigDir) fs.rmSync(this.sessionConfigDir, {recursive: true, force: true}); this.sessionConfigDir = undefined;}
}

module.exports = {KimiSession, externalTools, prepareSessionFiles, boundedJson, industrialContext, scopeKey};
