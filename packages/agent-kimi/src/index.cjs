const {createSession, createExternalTool} = require('@moonshot-ai/kimi-agent-sdk');
const {z} = require('zod');

const canonicalNames = {
  'eda.netlist.inspect': 'eda_netlist_inspect',
  'eda.waveform.inspect': 'eda_waveform_inspect',
  'eda.layout.inspect': 'eda_layout_inspect',
  'pcb.board.inspect': 'pcb_board_inspect',
};

function externalTools(getScope, lookupArtifact, disclose) {
  const scope = getScope();
  if (!scope) return [];
  const tools = [createExternalTool({
    name: 'industrial_capability_detail',
    description: 'Read the detailed skill reference and tool schema for one selected industrial capability.',
    parameters: z.object({capabilityId: z.string()}),
    handler: async ({capabilityId}) => ({output: JSON.stringify(disclose(capabilityId)), message: 'Capability detail disclosed'}),
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
        return {output: JSON.stringify(artifact), message: 'Artifact metadata read'};
      },
    }));
  }
  return tools;
}

class KimiSession {
  constructor(workDir, getScope, lookupArtifact, disclose, emit) {
    this.workDir = workDir;
    this.getScope = getScope;
    this.lookupArtifact = lookupArtifact;
    this.disclose = disclose;
    this.emit = emit;
  }
  async run(task) {
    if (this.turn) throw Error('A Kimi turn is already running.');
    const scope = this.getScope();
    if (!scope) throw Error('Resolve capabilities before starting the agent.');
    if (!this.session || this.scopeVersion !== scope.version) {
      await this.session?.close();
      this.session = createSession({workDir: this.workDir, executable: process.env.KIMI_EXECUTABLE || 'kimi', yoloMode: false, externalTools: externalTools(this.getScope, this.lookupArtifact, this.disclose), clientInfo: {name: 'industrial-agent-harness', version: '0.0.0'}});
      this.scopeVersion = scope.version;
    }
    const context = `Industrial Context (current Broker scope): ${JSON.stringify({domain: scope.domain, stage: scope.stage, capabilities: scope.capabilityIds, skills: scope.skills, tools: scope.tools})}. Use industrial_capability_detail to load details when needed. Artifact metadata tools are read-only. Treat viewer output as inspection, not engineering verification.`;
    const turn = this.session.prompt(`${context}\n\nUser task: ${task}`);
    this.turn = turn;
    try {
      for await (const event of turn) {
        if (event.type === 'ContentPart' && event.payload.type === 'text') this.emit({type: 'text', text: event.payload.text});
        else if (event.type === 'ApprovalRequest') this.emit({type: 'approval', id: event.payload.id, description: event.payload.description, action: event.payload.action});
        else if (event.type === 'ToolCall') this.emit({type: 'tool', name: event.payload.function.name});
        else if (event.type === 'ToolResult') this.emit({type: 'tool-result', error: event.payload.return_value.is_error, message: event.payload.return_value.message});
        else if (event.type === 'StepBegin') this.emit({type: 'step', number: event.payload.n});
      }
      this.emit({type: 'done', result: await turn.result});
    } catch (error) {this.emit({type: 'error', message: String(error)});}
    finally {this.turn = undefined;}
  }
  approve(id, response) {if (!this.turn) throw Error('No active turn.'); return this.turn.approve(id, response);}
  interrupt() {return this.turn?.interrupt();}
  async close() {await this.session?.close();}
}

module.exports = {KimiSession, externalTools};
