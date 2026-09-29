#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {parseArgs} = require('./args.cjs');
const {resolveProjectTask, effectiveCapabilities, resourceCatalog, ResourceSettings, defaultResourceDirectory, ChatStore, defaultChatDirectory} = require('@industrial-agent-harness/harness-core');
const {capabilities, listDomains} = require('@industrial-agent-harness/domain-skills');
const {discloseDetail} = require('@industrial-agent-harness/capability-broker');
const {KimiSession} = require('@industrial-agent-harness/agent-kimi');
const {createGuiPlugin, ensureInstalled} = require('@industrial-agent-harness/computer-use-bridge');
const {ObservedContextStore} = require('@industrial-agent-harness/domain-runtime');
const {runBench} = require('./bench.cjs');
const {main: inspectDiagnosticLog} = require('./inspect-log.cjs');
const {defaults, validateProfile, sessionEnv, writeCliConfig} = require('@industrial-agent-harness/agent-kimi/src/model-config.cjs');

const usage = `industrial-harness run --project-dir DIR --domain DOMAIN (--task TEXT | --task-file FILE) [options]
industrial-harness chats --project-dir DIR --domain DOMAIN [--chat-dir DIR]
industrial-harness inspect-log --file FILE

Options:
  --chat-id ID                 Continue an existing project chat
  --chat-dir DIR               Shared chat database and agent session directory
  --scope-only                 Resolve Broker scope without starting Kimi
  --provider NAME              kimi or openai_legacy
  --endpoint URL               Model API base URL
  --model NAME                 Model name
  --context-size N             Model context size
  --no-thinking                Disable thinking mode
  --api-key-env NAME           Environment variable containing the API key
  --kimi-executable PATH       Kimi CLI executable (or set KIMI_EXECUTABLE)
  --approval POLICY            reject (default), approve, approve_for_session
  --enable-gui                 Enable the computer-use plugin (installs the engine on first use)
  --artifact-manifest FILE     JSON array of {id, kind, path} inside the project
  --state-dir DIR             Durable observed-context database directory
  --log-dir DIR               Full diagnostic JSONL directory
  --disable-skill ID          Disable a repository skill for this run (repeatable)
  --disable-mcp ID            Disable a repository MCP server for this run (repeatable)
  --timeout-ms N               Interrupt a turn after N milliseconds

Global/project resource defaults use ~/.industrial-agent-harness/resource-settings.json.
Set INDUSTRIAL_HARNESS_CONFIG_DIR to use an isolated configuration directory.
Output is JSON Lines on stdout. API keys are read only from the environment.\n`;

function emit(output, event) {output.write(`${JSON.stringify({schemaVersion: 1, ...event})}\n`);}

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
    artifacts.set(entry.id, {file, metadata: {id: entry.id, kind: entry.kind, name: path.basename(file), relativePath, sizeBytes: fs.statSync(file).size}});
  }
  return artifacts;
}

async function run(options, output = process.stdout, environment = process.env, Session = KimiSession) {
  const store = options.scopeOnly && options.command !== 'chats' ? null : new ChatStore(options.chatDir || defaultChatDirectory(environment));
  try {return await runWithStore(options, output, environment, Session, store);} finally {store?.close();}
}

async function runWithStore(options, output, environment, Session, chats) {
  const projectDir = fs.realpathSync(path.resolve(options.projectDir));
  if (!fs.statSync(projectDir).isDirectory()) throw Error('Project path must be a directory.');
  const runId = crypto.randomUUID();
  const send = event => emit(output, {runId, ...event});
  if (!listDomains(capabilities).some(item => item.id === options.domain)) throw Error('Choose a valid project domain.');
  if (options.command === 'chats') {send({type: 'chats', chats: chats.list(projectDir, options.domain)}); return 0;}
  const previous = options.chatId && chats ? chats.history(options.chatId, projectDir, options.domain).turns.at(-1)?.broker?.scope : undefined;
  const catalog = resourceCatalog(options.domain);
  const saved = new ResourceSettings(defaultResourceDirectory(environment)).snapshot(catalog, projectDir).effective;
  const disabled = {skills: [...new Set([...saved.skills, ...(options.disabledSkills || [])])], mcpServers: [...new Set([...saved.mcpServers, ...(options.disabledMcpServers || [])])]};
  for (const id of disabled.skills) if (!catalog.skills.some(item => item.id === id)) throw Error(`Unknown project skill: ${id}`);
  for (const id of disabled.mcpServers) if (!catalog.mcpServers.some(item => item.id === id)) throw Error(`Unknown project MCP: ${id}`);
  const broker = resolveProjectTask(options.domain, {task: options.task}, previous, capabilities, disabled);
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
  let contextStore;
  let timeout;
  let timedOut = false;
  let interrupted = false;
  let outcome;
  let turnId;
  let release;
  let guiBridge;
  const chat = options.chatId ? chats.get(options.chatId, projectDir, options.domain) : chats.create(projectDir, options.domain);
  const onInterrupt = signal => {
    interrupted = true;
    send({type: 'interrupted', signal});
    Promise.resolve(session?.interrupt()).catch(error => send({type: 'interrupt_error', message: String(error)}));
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  try {
    release = chats.acquire(chat.id);
    chats.recoverInterrupted();
    turnId = chats.beginTurn(chat.id, options.task, broker);
    send({type: 'chat', chatId: chat.id});
    contextStore = new ObservedContextStore(projectDir, options.domain, {directory: options.stateDir || environment.INDUSTRIAL_HARNESS_STATE_DIR});
    for (const [id, item] of artifacts) await contextStore.observeArtifact({id, kind: item.metadata.kind, file: item.file});
    const runtime = {profile, apiKey, revision: 0, executable: options.kimiExecutable || environment.KIMI_EXECUTABLE || 'kimi', shareDir: writeCliConfig(configDir, profile), env: sessionEnv(profile, apiKey), disabledMcpServers: disabled.mcpServers};
    if (options.enableGui) {
      const guiDir = environment.GUI_BRIDGE_DIR || path.join(os.homedir(), '.industrial-agent-harness', 'gui-bridge');
      send({type: 'gui_install', phase: 'checking'});
      try {
        const installed = await ensureInstalled(guiDir, environment, (phase, detail) => send({type: 'gui_install', phase, tag: detail?.tag || null}));
        send({type: 'gui_install', phase: 'ready', tag: installed.tag, cached: Boolean(installed.cached)});
      } catch (error) {
        send({type: 'gui_install', phase: 'error', error: String(error)});
        throw Error(`Computer-use plugin is not available: ${String(error)}. Run again after the install succeeds, or set GUI_BRIDGE_BIN to an existing binary.`);
      }
      guiBridge = createGuiPlugin({
        enabled: true,
        installedDir: guiDir,
        log: (canonicalId, risk, args, info) => broker.trace.push({level: 'L2', event: 'plugin.tool-call', detail: {plugin: 'computer-use', tool: canonicalId, risk, args, ...info}}),
      });
    }
    const plugins = guiBridge ? [guiBridge] : [];
    session = new Session(projectDir, () => scope, async id => {
      return contextStore.readArtifact(id);
    }, id => {
      const detail = discloseDetail(scope, effectiveCapabilities(capabilities, disabled), id);
      send({type: 'disclosure', level: 'L3', capabilityId: id, skills: detail.skills.map(item => item.id), tools: detail.tools.map(item => item.id)});
      return detail;
    }, event => {
      chats.append(turnId, event);
      send({type: 'agent_event', event});
      if (event.type === 'done' || event.type === 'error') outcome = event;
      if (event.type === 'approval') {
        const decision = options.approval || 'reject';
        send({type: 'approval_decision', id: event.id, decision});
        queueMicrotask(() => {Promise.resolve().then(() => session.approve(event.id, decision)).catch(error => send({type: 'approval_error', id: event.id, message: String(error)}));});
      }
    }, () => runtime, undefined, {directory: options.logDir || environment.INDUSTRIAL_HARNESS_LOG_DIR, getBrokerTrace: () => broker.trace, getContextAnchor: () => contextStore.anchor(), readContextPage: (checkpointId, offset, limit) => contextStore.readPage(checkpointId, offset, limit), resolveSession: key => chats.runtimeSession(chat.id, key), sessionInitialized: id => chats.initialized(id)}, plugins);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    if (options.timeoutMs) timeout = setTimeout(() => {timedOut = true; send({type: 'timeout', timeoutMs: Number(options.timeoutMs)}); Promise.resolve(session.interrupt()).catch(error => send({type: 'interrupt_error', message: String(error)}));}, Number(options.timeoutMs));
    await session.run(options.task);
    const status = timedOut ? 'timeout' : interrupted ? 'interrupted' : outcome?.type === 'error' ? 'error' : outcome?.type === 'done' ? outcome.result.status : 'incomplete';
    chats.finish(turnId, status);
    send({type: 'result', status, chatId: chat.id});
    return status === 'timeout' ? 124 : status === 'interrupted' ? 130 : status === 'error' || status === 'incomplete' ? 1 : 0;
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    try {await session?.close();} finally {
      if (turnId && (!outcome || timedOut || interrupted)) chats.finish(turnId, timedOut ? 'timeout' : interrupted ? 'interrupted' : 'error');
      release?.(); contextStore?.close(); await guiBridge?.close?.().catch(() => {}); fs.rmSync(configDir, {recursive: true, force: true});
    }
  }
}

async function main() {
  try {
    if (process.argv[2] === 'inspect-log') {inspectDiagnosticLog(process.argv.slice(3)); return;}
    if (process.argv[2] === 'bench') {
      process.exitCode = await runBench(process.argv.slice(3));
      return;
    }
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {process.stdout.write(usage); return;}
    process.exitCode = await run(options);
  } catch (error) {
    emit(process.stdout, {type: 'error', message: String(error)});
    process.exitCode = 1;
  }
}

module.exports = {main, run, loadArtifacts, usage};
if (require.main === module) void main();
