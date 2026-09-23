#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {parseArgs} = require('./args.cjs');
const {resolveProjectTask, effectiveCapabilities, resourceCatalog} = require('@industrial-agent-harness/harness-core');
const {capabilities} = require('@industrial-agent-harness/domain-skills');
const {discloseDetail} = require('@industrial-agent-harness/capability-broker');
const {KimiSession} = require('@industrial-agent-harness/agent-kimi');
const {defaults, validateProfile, sessionEnv, writeCliConfig} = require('@industrial-agent-harness/agent-kimi/src/model-config.cjs');

const usage = `industrial-harness run --project-dir DIR --domain DOMAIN (--task TEXT | --task-file FILE) [options]

Options:
  --scope-only                 Resolve Broker scope without starting Kimi
  --provider NAME              kimi or openai_legacy
  --endpoint URL               Model API base URL
  --model NAME                 Model name
  --context-size N             Model context size
  --no-thinking                Disable thinking mode
  --api-key-env NAME           Environment variable containing the API key
  --kimi-executable PATH       Kimi CLI executable (or set KIMI_EXECUTABLE)
  --approval POLICY            reject (default), approve, approve_for_session
  --artifact-manifest FILE     JSON array of {id, kind, path} inside the project
  --disable-skill ID          Disable a repository skill for this run (repeatable)
  --disable-mcp ID            Disable a repository MCP server for this run (repeatable)
  --timeout-ms N               Interrupt a turn after N milliseconds

Output is JSON Lines on stdout. API keys are read only from the environment.\n`;

function emit(output, event) {output.write(`${JSON.stringify({schemaVersion: 1, ...event})}\n`);}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function loadArtifacts(manifestFile, projectDir) {
  if (!manifestFile) return new Map();
  const entries = JSON.parse(fs.readFileSync(path.resolve(manifestFile), 'utf8'));
  if (!Array.isArray(entries)) throw Error('Artifact manifest must be a JSON array.');
  const artifacts = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.path !== 'string' || !['layout', 'netlist', 'waveform'].includes(entry.kind)) throw Error('Invalid artifact manifest entry.');
    if (artifacts.has(entry.id)) throw Error('Duplicate artifact ID.');
    const file = fs.realpathSync(path.resolve(projectDir, entry.path));
    const relativePath = path.relative(projectDir, file);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath) || !fs.statSync(file).isFile()) throw Error('Artifact must be a file inside the project.');
    const sha256 = await digest(file);
    artifacts.set(entry.id, {file, sha256, metadata: {id: entry.id, kind: entry.kind, name: path.basename(file), relativePath, sizeBytes: fs.statSync(file).size, sha256}});
  }
  return artifacts;
}

async function run(options, output = process.stdout, environment = process.env, Session = KimiSession) {
  const projectDir = fs.realpathSync(path.resolve(options.projectDir));
  if (!fs.statSync(projectDir).isDirectory()) throw Error('Project path must be a directory.');
  const runId = crypto.randomUUID();
  const send = event => emit(output, {runId, ...event});
  const disabled = {skills: options.disabledSkills || [], mcpServers: options.disabledMcpServers || []};
  const catalog = resourceCatalog(options.domain);
  for (const id of disabled.skills) if (!catalog.skills.some(item => item.id === id)) throw Error(`Unknown project skill: ${id}`);
  for (const id of disabled.mcpServers) if (!catalog.mcpServers.some(item => item.id === id)) throw Error(`Unknown project MCP: ${id}`);
  const broker = resolveProjectTask(options.domain, {task: options.task}, undefined, capabilities, disabled);
  const scope = broker.scope;
  send({type: 'scope', projectDir, scope, matches: broker.matches, trace: broker.trace});
  if (options.scopeOnly) {send({type: 'result', status: 'scoped'}); return 0;}

  const provider = options.provider || 'kimi';
  if (provider === 'openai_legacy' && !options.endpoint && !environment.OPENAI_BASE_URL) throw Error('Set --endpoint or OPENAI_BASE_URL for the OpenAI-compatible provider.');
  const profile = validateProfile({
    ...defaults,
    provider,
    endpoint: options.endpoint || (provider === 'kimi' ? environment.KIMI_BASE_URL : environment.OPENAI_BASE_URL) || defaults.endpoint,
    model: options.model || environment.KIMI_MODEL_NAME || defaults.model,
    contextSize: options.contextSize || defaults.contextSize,
    thinking: options.thinking,
  });
  const keyName = options.apiKeyEnv || (provider === 'kimi' ? 'KIMI_API_KEY' : 'OPENAI_API_KEY');
  const apiKey = environment[keyName];
  if (!apiKey) throw Error(`Set ${keyName} in the environment before running Kimi.`);
  const artifacts = await loadArtifacts(options.artifactManifest, projectDir);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-cli-'));
  fs.chmodSync(configDir, 0o700);
  let session;
  let timeout;
  let timedOut = false;
  let interrupted = false;
  let outcome;
  const onInterrupt = signal => {
    interrupted = true;
    send({type: 'interrupted', signal});
    Promise.resolve(session?.interrupt()).catch(error => send({type: 'interrupt_error', message: String(error)}));
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  try {
    const runtime = {profile, apiKey, revision: 0, executable: options.kimiExecutable || environment.KIMI_EXECUTABLE || 'kimi', shareDir: writeCliConfig(configDir, profile), env: sessionEnv(profile, apiKey), disabledMcpServers: disabled.mcpServers};
    session = new Session(projectDir, () => scope, async id => {
      const item = artifacts.get(id);
      if (!item || await digest(item.file) !== item.sha256) throw Error('Artifact is unavailable or changed.');
      return item.metadata;
    }, id => {
      const detail = discloseDetail(scope, effectiveCapabilities(capabilities, disabled), id);
      send({type: 'disclosure', level: 'L3', capabilityId: id, skills: detail.skills.map(item => item.id), tools: detail.tools.map(item => item.id)});
      return detail;
    }, event => {
      send({type: 'agent_event', event});
      if (event.type === 'done' || event.type === 'error') outcome = event;
      if (event.type === 'approval') {
        const decision = options.approval || 'reject';
        send({type: 'approval_decision', id: event.id, decision});
        queueMicrotask(() => {Promise.resolve().then(() => session.approve(event.id, decision)).catch(error => send({type: 'approval_error', id: event.id, message: String(error)}));});
      }
    }, () => runtime);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    if (options.timeoutMs) timeout = setTimeout(() => {timedOut = true; send({type: 'timeout', timeoutMs: Number(options.timeoutMs)}); Promise.resolve(session.interrupt()).catch(error => send({type: 'interrupt_error', message: String(error)}));}, Number(options.timeoutMs));
    await session.run(options.task);
    const status = timedOut ? 'timeout' : interrupted ? 'interrupted' : outcome?.type === 'error' ? 'error' : outcome?.type === 'done' ? outcome.result.status : 'incomplete';
    send({type: 'result', status});
    return status === 'timeout' ? 124 : status === 'interrupted' ? 130 : status === 'error' || status === 'incomplete' ? 1 : 0;
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    await session?.close();
    fs.rmSync(configDir, {recursive: true, force: true});
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {process.stdout.write(usage); return;}
    process.exitCode = await run(options);
  } catch (error) {
    emit(process.stdout, {type: 'error', message: String(error)});
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = {run, loadArtifacts, usage};
