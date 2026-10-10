#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseArgs } = require('./args.cjs');
const { scheduleTimeout } = require('./lib/timeout.cjs');
const { TaskService } = require('@industrial-agent-harness/harness-application');
const { distributionDomain } = require('@industrial-agent-harness/domain-skills');
const {
  KimiSession,
  bundledExecutable,
  KIMI_CODE_VERSION,
} = require('@industrial-agent-harness/agent-kimi');
const {
  createGuiPlugin,
  ensureInstalled,
} = require('@industrial-agent-harness/computer-use-bridge');
const { runBench } = require('./bench.cjs');
const { loadArtifacts } = require('./lib/artifact-manifest.cjs');
const { runMcp } = require('./mcp.cjs');
const { main: inspectDiagnosticLog } = require('./inspect-log.cjs');
const { runRemote } = require('./remote.cjs');
const { runDomains } = require('./domains.cjs');
const {
  defaults,
  validateProfile,
  sessionEnv,
  writeCliConfig,
} = require('@industrial-agent-harness/agent-kimi/src/model-config.cjs');

const usage = `industrial-harness run --project-dir DIR --domain DOMAIN (--task TEXT | --task-file FILE) [options]
industrial-harness chats --project-dir DIR --domain DOMAIN [--chat-dir DIR]
industrial-harness doctor --project-dir DIR --domain DOMAIN
industrial-harness inspect-log --file FILE
industrial-harness remote --help
industrial-harness mcp --help
industrial-harness domains list|available|install|update|remove [options]

Options:
  --chat-id ID                 Continue an existing project chat
  --chat-dir DIR               Shared chat database and agent session directory
  --scope-only                 Resolve Broker scope without starting Kimi
  --provider NAME              kimi or openai_legacy
  --endpoint URL               Model API base URL
  --model NAME                 Model name
  --context-size N             Model context size
  --no-thinking                Disable thinking mode
  --image-input                Enable model image input for screenshot services
  --api-key-env NAME           Environment variable containing the API key
  --kimi-executable PATH       Kimi CLI executable (or set KIMI_EXECUTABLE)
  --approval POLICY            reject (default), approve, approve_for_session, auto
  --enable-gui                 Enable the computer-use plugin (installs the engine on first use)
  --artifact-manifest FILE     JSON array of {id, kind, path} inside the project
  --state-dir DIR             Durable observed-context database directory
  --log-dir DIR               Full diagnostic JSONL directory
  --disable-skill ID          Disable a repository skill for this run (repeatable)
  --disable-mcp ID            Disable a repository MCP server for this run (repeatable)
  --timeout-ms N               Optional positive integer milliseconds; omit for no time limit

Global/project resource defaults use ~/.industrial-agent-harness/resource-settings.json.
Set INDUSTRIAL_HARNESS_CONFIG_DIR to use an isolated configuration directory.
Output is JSON Lines on stdout. API keys are read only from the environment.\n`;

function emit(output, event) {
  output.write(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
}

async function run(
  options,
  output = process.stdout,
  environment = process.env,
  Session = KimiSession,
) {
  const projectDir = fs.realpathSync(path.resolve(options.projectDir));
  if (!fs.statSync(projectDir).isDirectory()) throw Error('Project path must be a directory.');
  const project = { id: projectDir, path: projectDir, domain: options.domain };
  const tasks = new TaskService({
    environment,
    Session,
    chatDirectory: options.chatDir,
    runtimeOptions: { directory: options.stateDir || environment.INDUSTRIAL_HARNESS_STATE_DIR },
    contextOptions: { directory: options.stateDir || environment.INDUSTRIAL_HARNESS_STATE_DIR },
  });
  const runId = crypto.randomUUID();
  const send = event => emit(output, { runId, ...event });
  let configDir, guiBridge, timeout;
  let entry;
  const interrupt = (reason, event) => {
    send(event);
    Promise.resolve(tasks.cancel(entry, reason)).catch(error =>
      send({ type: 'interrupt_error', message: String(error) }),
    );
  };
  const onSigint = () => interrupt('interrupted', { type: 'interrupted', signal: 'SIGINT' });
  const onSigterm = () => interrupt('interrupted', { type: 'interrupted', signal: 'SIGTERM' });
  try {
    if (!tasks.registry().domains.some(item => item.id === options.domain))
      throw Error('Choose a valid project domain.');
    if (options.command === 'chats') {
      send({ type: 'chats', chats: tasks.chats.list(projectDir, options.domain) });
      return 0;
    }
    if (options.command === 'doctor') {
      const { report, actionId } = await tasks.diagnose(project);
      send({
        type: 'doctor',
        ...report,
        agent: {
          expectedVersion: KIMI_CODE_VERSION,
          bundledRuntimeAvailable: fs.existsSync(bundledExecutable()),
        },
        externalMcp: tasks.external
          .list()
          .map(server => ({ id: server.id, status: 'registered-not-connected' })),
        actionId,
      });
      return report.ready ? 0 : 2;
    }
    entry = options.scopeOnly
      ? tasks.sessions.get(project, options.chatId || runId)
      : tasks.resume(project, options.chatId || tasks.chats.create(projectDir, options.domain).id);
    const broker = await tasks.prepare(
      entry,
      { task: options.task },
      {
        preview: Boolean(options.scopeOnly),
        persist: !options.scopeOnly,
        overrides: { skills: options.disabledSkills, mcpServers: options.disabledMcpServers },
      },
    );
    send({
      type: 'scope',
      projectDir,
      scope: broker.scope,
      matches: broker.matches,
      trace: broker.trace,
      ...(options.scopeOnly ? { preview: true, executionAuthorized: false } : {}),
    });
    if (options.scopeOnly) {
      send({ type: 'result', status: 'scoped' });
      return 0;
    }
    const provider = options.provider || 'kimi';
    if (provider === 'openai_legacy' && !options.endpoint && !environment.OPENAI_BASE_URL)
      throw Error('Set --endpoint or OPENAI_BASE_URL for the OpenAI-compatible provider.');
    const profile = validateProfile({
      ...defaults,
      provider,
      endpoint:
        options.endpoint ||
        (provider === 'kimi' ? environment.KIMI_BASE_URL : environment.OPENAI_BASE_URL) ||
        defaults.endpoint,
      model: options.model || environment.KIMI_MODEL_NAME || defaults.model,
      contextSize: options.contextSize || defaults.contextSize,
      thinking: options.thinking,
      imageInput: Boolean(options.imageInput),
      imageInputMode: options.imageInput ? 'enabled' : defaults.imageInputMode,
    });
    const keyName = options.apiKeyEnv || (provider === 'kimi' ? 'KIMI_API_KEY' : 'OPENAI_API_KEY');
    const apiKey = environment[keyName];
    if (!apiKey) throw Error(`Set ${keyName} in the environment before running Kimi.`);
    const artifacts = await loadArtifacts(options.artifactManifest, projectDir);
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-cli-'));
    fs.chmodSync(configDir, 0o700);
    const bundle = entry.runtimeBundle;
    const runtime = {
      profile,
      apiKey,
      revision: 0,
      executable: options.kimiExecutable || environment.KIMI_EXECUTABLE || 'kimi',
      shareDir: writeCliConfig(configDir, profile),
      env: sessionEnv(profile, apiKey),
      disabledMcpServers: entry.disabled.mcpServers,
      environment,
      externalServers: entry.externalServers,
      approvalMode: options.approval === 'auto' ? 'auto' : 'ask',
    };
    if (options.enableGui && bundle)
      send({
        type: 'execution_policy',
        unavailable: ['application-control'],
        reason:
          'Application control is unavailable in protected industrial execution; Runtime tools remain available.',
      });
    if (options.enableGui && !bundle) {
      const guiDir =
        environment.GUI_BRIDGE_DIR ||
        path.join(os.homedir(), '.industrial-agent-harness', 'gui-bridge');
      send({ type: 'gui_install', phase: 'checking' });
      try {
        const installed = await ensureInstalled(guiDir, environment, (phase, detail) =>
          send({ type: 'gui_install', phase, tag: detail?.tag || null }),
        );
        send({
          type: 'gui_install',
          phase: 'ready',
          tag: installed.tag,
          cached: Boolean(installed.cached),
        });
      } catch (error) {
        send({ type: 'gui_install', phase: 'error', error: String(error) });
        throw Error(
          `Computer-use plugin is not available: ${String(error)}. Run again after the install succeeds, or set GUI_BRIDGE_BIN to an existing binary.`,
        );
      }
      guiBridge = createGuiPlugin({
        enabled: true,
        installedDir: guiDir,
        log: (canonicalId, risk, args, info) =>
          entry.trace.push({
            level: 'L2',
            event: 'plugin.tool-call',
            detail: { plugin: 'computer-use', tool: canonicalId, risk, args, ...info },
          }),
      });
    }
    send({ type: 'chat', chatId: entry.id });
    const started = await tasks.start(entry, options.task, {
      getConfig: () => runtime,
      artifacts,
      plugins: guiBridge ? [guiBridge] : [],
      waitForBackground: true,
      logDirectory: options.logDir || environment.INDUSTRIAL_HARNESS_LOG_DIR,
      onDisclosure: (id, detail) =>
        send({
          type: 'disclosure',
          level: 'L3',
          capabilityId: id,
          skills: detail.skills.map(item => item.id),
          tools: detail.tools.map(item => item.id),
        }),
      onEvent: (event, metadata) => {
        if (event.type === 'results-changed' || event.type === 'results-ready') {
          send({ ...event, ...metadata, type: event.type.replaceAll('-', '_') });
          return;
        }
        if (event.type === 'industrial-result') {
          send({ ...event, type: 'industrial_result' });
          return;
        }
        send({ type: 'agent_event', event });
        if (event.type === 'approval') {
          const decision = options.approval || 'reject';
          send({ type: 'approval_decision', id: event.id, decision });
          queueMicrotask(() =>
            Promise.resolve()
              .then(() => tasks.approve(entry, event.id, decision))
              .catch(error =>
                send({ type: 'approval_error', id: event.id, message: String(error) }),
              ),
          );
        }
        if (event.type === 'question') {
          send({ type: 'needs_input', id: event.id, questions: event.questions });
          queueMicrotask(() =>
            Promise.resolve()
              .then(() => tasks.cancel(entry, 'needs_input'))
              .catch(error => send({ type: 'interrupt_error', message: String(error) })),
          );
        }
      },
    });
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    timeout = scheduleTimeout(options.timeoutMs, timeoutMs =>
      interrupt('timeout', { type: 'timeout', timeoutMs }),
    );
    const result = await started.completion;
    send({ type: 'result', ...result });
    return result.status === 'timeout'
      ? 124
      : result.status === 'needs_input'
        ? 2
        : result.status === 'interrupted'
          ? 130
          : ['error', 'incomplete'].includes(result.status)
            ? 1
            : 0;
  } finally {
    timeout?.();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    try {
      await tasks.close();
    } finally {
      await guiBridge?.close?.().catch(() => {});
      if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    if (process.argv[2] === 'remote') {
      process.exitCode = await runRemote(process.argv.slice(3));
      return;
    }
    if (process.argv[2] === 'mcp') {
      process.exitCode = await runMcp(process.argv.slice(3));
      return;
    }
    if (process.argv[2] === 'domains') {
      process.exitCode = await runDomains(process.argv.slice(3));
      return;
    }
    if (process.argv[2] === 'inspect-log') {
      inspectDiagnosticLog(process.argv.slice(3));
      return;
    }
    if (process.argv[2] === 'bench') {
      process.exitCode = await runBench(process.argv.slice(3));
      return;
    }
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        (distributionDomain
          ? `This CLI package is fixed to ${distributionDomain}; --domain is optional.\n\n`
          : '') + usage,
      );
      return;
    }
    process.exitCode = await run(options);
  } catch (error) {
    emit(process.stdout, { type: 'error', message: String(error) });
    process.exitCode = 1;
  }
}

module.exports = { main, run, loadArtifacts, usage };
if (require.main === module) void main();
