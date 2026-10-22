// Test-only host for exercising the same application API used by Desktop in a
// separate process. The single JSON argument is a fixture request, not a CLI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TaskService } = require('../../../packages/harness-application/src/index.cjs');
const { KimiSession } = require('../../../packages/agent-kimi/src/index.cjs');
const {
  defaults,
  validateProfile,
  sessionEnv,
  writeCliConfig,
} = require('../../../packages/agent-kimi/src/model-config.cjs');

function taskArguments(options) {
  return [__filename, JSON.stringify(options)];
}

function selectedArtifacts(manifestFile, projectDir) {
  const artifacts = new Map();
  if (!manifestFile) return artifacts;
  const entries = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!Array.isArray(entries)) throw Error('Artifact fixture must be a JSON array.');
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.path !== 'string' ||
      !['layout', 'netlist', 'waveform'].includes(entry.kind) ||
      artifacts.has(entry.id)
    )
      throw Error('Invalid artifact fixture entry.');
    const file = fs.realpathSync(path.resolve(projectDir, entry.path));
    const relativePath = path.relative(projectDir, file);
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith('..' + path.sep) ||
      path.isAbsolute(relativePath) ||
      !fs.statSync(file).isFile()
    )
      throw Error('Artifact fixture must be a file inside the project.');
    artifacts.set(entry.id, {
      file,
      metadata: {
        id: entry.id,
        kind: entry.kind,
        name: path.basename(file),
        relativePath,
        sizeBytes: fs.statSync(file).size,
      },
    });
  }
  return artifacts;
}

async function runTask(
  options,
  output = process.stdout,
  environment = process.env,
  Session = KimiSession,
) {
  const projectDir = fs.realpathSync(options.projectDir);
  const project = { id: projectDir, path: projectDir, domain: options.domain };
  const tasks = new TaskService({
    environment,
    Session,
    chatDirectory: options.chatDir,
    runtimeOptions: { directory: options.stateDir },
    contextOptions: { directory: options.stateDir },
  });
  const runId = crypto.randomUUID();
  const send = event => output.write(JSON.stringify({ schemaVersion: 1, runId, ...event }) + '\n');
  const enqueue = action =>
    queueMicrotask(() =>
      Promise.resolve()
        .then(action)
        .catch(error => send({ type: 'fixture_error', message: String(error) })),
    );
  let entry, directory, timeout;
  const cancel = (reason, event) => {
    send(event);
    Promise.resolve(tasks.cancel(entry, reason)).catch(error =>
      send({ type: 'interrupt_error', message: String(error) }),
    );
  };
  const onSignal = () => cancel('interrupted', { type: 'interrupted' });
  try {
    entry = options.scopeOnly
      ? tasks.sessions.get(project, options.chatId || runId)
      : tasks.resume(project, options.chatId || tasks.chats.create(projectDir, options.domain).id);
    const prepared = await tasks.prepare(
      entry,
      { task: options.task },
      {
        preview: Boolean(options.scopeOnly),
        persist: !options.scopeOnly,
        overrides: { skills: options.disabledSkills, mcpServers: options.disabledMcpServers },
      },
    );
    send({ type: 'scope', scope: prepared.scope, matches: prepared.matches, trace: prepared.trace });
    if (options.scopeOnly) {
      send({ type: 'result', status: 'scoped' });
      return 0;
    }
    const provider = options.provider || 'kimi';
    const profile = validateProfile({
      ...defaults,
      provider,
      endpoint: options.endpoint || defaults.endpoint,
      model: options.model || defaults.model,
      contextSize: options.contextSize || defaults.contextSize,
      thinking: options.thinking,
      imageInput: Boolean(options.imageInput),
      imageInputMode: options.imageInput ? 'enabled' : defaults.imageInputMode,
    });
    const apiKey =
      environment[options.apiKeyEnv || (provider === 'kimi' ? 'KIMI_API_KEY' : 'OPENAI_API_KEY')];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-fixture-'));
    const runtime = {
      profile,
      apiKey,
      revision: 0,
      executable: options.kimiExecutable || environment.KIMI_EXECUTABLE || 'kimi',
      shareDir: writeCliConfig(directory, profile),
      env: sessionEnv(profile, apiKey),
      disabledMcpServers: entry.disabled.mcpServers,
      environment,
      externalServers: entry.externalServers,
      approvalMode: options.approval === 'auto' ? 'auto' : 'ask',
    };
    send({ type: 'chat', chatId: entry.id });
    const started = await tasks.start(entry, options.task, {
      getConfig: () => runtime,
      artifacts: selectedArtifacts(options.artifactManifest, projectDir),
      waitForBackground: true,
      logDirectory: options.logDir,
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
          if (options.approval === 'auto') {
            send({ type: 'needs_input', id: event.id, reason: 'explicit_approval_required' });
            enqueue(() => tasks.cancel(entry, 'needs_input'));
          } else {
            const decision = options.approval || 'reject';
            send({ type: 'approval_decision', id: event.id, decision });
            enqueue(() => tasks.approve(entry, event.id, decision));
          }
        }
        if (event.type === 'question') {
          send({ type: 'needs_input', id: event.id, questions: event.questions });
          enqueue(() => tasks.cancel(entry, 'needs_input'));
        }
      },
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    if (options.timeoutMs)
      timeout = setTimeout(() => cancel('timeout', { type: 'timeout' }), options.timeoutMs);
    const result = await started.completion;
    send({ type: 'result', ...result });
    return (
      { timeout: 124, needs_input: 2, interrupted: 130, error: 1, incomplete: 1 }[result.status] ||
      0
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await tasks.close();
    } finally {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

module.exports = { taskArguments, runTask };
if (require.main === module)
  runTask(JSON.parse(process.argv[2])).then(
    code => (process.exitCode = code),
    error => {
      process.stdout.write(JSON.stringify({ type: 'error', message: String(error) }) + '\n');
      process.exitCode = 1;
    },
  );
