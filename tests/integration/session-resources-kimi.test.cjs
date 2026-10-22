const test = require('node:test');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ChatStore, SessionResourceManager } = require('../../packages/harness-core/src/index.cjs');
const { KimiSession } = require('../../packages/agent-kimi/src/index.cjs');
const {
  validateProfile,
  writeCliConfig,
  sessionEnv,
} = require('../../packages/agent-kimi/src/model-config.cjs');
const { startModel } = require('./fixtures/session-resource-model.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const executable =
  process.env.KIMI_EXECUTABLE ||
  require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();

test(
  'native idle eviction resumes saved Kimi context; another application host shares admission and resident limits',
  { skip: !fs.existsSync(executable), timeout: 60000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-budget-'));
    const projectDir = path.join(directory, 'project');
    fs.mkdirSync(projectDir);
    const config = path.join(directory, 'config');
    const resources = new SessionResourceManager({
      directory: config,
      limits: { maxConcurrent: 1, maxResident: 1, idleMs: 100, minFreeMemoryBytes: 0 },
      sweepIntervalMs: 20,
    });
    const chats = new ChatStore(path.join(directory, 'chats'));
    const model = await startModel({ held: true });
    let session;
    t.after(async () => {
      model.release();
      await session?.close();
      await resources.close();
      chats.close();
      await model.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const chat = chats.create(projectDir, 'test');
    const profile = validateProfile({
      provider: 'openai_legacy',
      endpoint: model.endpoint,
      model: 'resource-test',
      contextSize: 262144,
      thinking: false,
    });
    const runtime = {
      profile,
      apiKey: 'local-fixture-key',
      executable,
      revision: 0,
      shareDir: writeCliConfig(directory, profile),
      env: sessionEnv(profile, 'local-fixture-key'),
    };
    const events = [];
    session = new KimiSession(
      projectDir,
      () => ({ domain: 'test', stage: 'test', capabilityIds: [], skills: [], tools: [] }),
      () => null,
      () => null,
      event => events.push(event),
      () => runtime,
      undefined,
      {
        resources,
        directory: path.join(directory, 'logs'),
        resolveSession: key => chats.runtimeSession(chat.id, key),
        sessionInitialized: id => chats.initialized(id),
      },
    );
    const running = session.run('Remember RESOURCE_MEMORY_MARKER.');
    await model.waitForRequests(1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(resources.snapshot().resident, 1, 'TTL does not evict an active request');
    assert.equal(session.running, true);
    const args = taskArguments({
      projectDir: projectDir,
      domain: 'godot',
      task: 'Reply ACK.',
      provider: 'openai_legacy',
      endpoint: model.endpoint,
      model: 'resource-test',
      thinking: false,
      kimiExecutable: executable,
      chatDir: path.join(directory, 'cli-chats'),
      stateDir: path.join(directory, 'state'),
      logDir: path.join(directory, 'cli-logs'),
    });
    const env = {
      ...process.env,
      OPENAI_API_KEY: 'local-fixture-key',
      INDUSTRIAL_HARNESS_CONFIG_DIR: config,
      INDUSTRIAL_HARNESS_MAX_CONCURRENT_SESSIONS: '1',
      INDUSTRIAL_HARNESS_MAX_RESIDENT_SESSIONS: '1',
      INDUSTRIAL_HARNESS_MIN_FREE_MEMORY_BYTES: '0',
    };
    await assert.rejects(execute(process.execPath, args, { cwd: root, env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /shared limit of 1 running sessions/);
      return true;
    });
    assert.equal(model.requests.length, 1, 'rejected application host never sends a model request');
    model.release();
    await running;
    assert.equal(events.at(-1).type, 'done');
    const nativeId = session.session.sessionId;
    const deadline = Date.now() + 5000;
    while (resources.snapshot().resident && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(resources.snapshot().resident, 0);
    assert.equal(session.session, undefined);
    await session.run('Continue after idle eviction.');
    assert.equal(session.session.sessionId, nativeId);
    assert.ok(JSON.stringify(model.requests.at(-1).messages).includes('RESOURCE_MEMORY_MARKER'));
    assert.ok(
      model.requests
        .at(-1)
        .messages.some(
          message => message.role === 'assistant' && message.content === 'RESOURCE_TEST_ACK',
        ),
    );
    const result = await execute(process.execPath, args, { cwd: root, env });
    assert.match(result.stdout, /"status":"finished"/);
    assert.equal(
      resources.snapshot().resident,
      0,
      'Application API required the other host to release its idle resident slot',
    );
  },
);
