const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskService } = require('../../packages/harness-application/src/index.cjs');
const { writeCliConfig, sessionEnv } = require('../../packages/agent-kimi/src/model-config.cjs');
const { nativeAgentProfile } = require('../../packages/agent-kimi/src/agent-profiles.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');

test(
  'real TaskService preserves a selected Agent snapshot, scoped skills and native context across configuration edits and restart',
  { timeout: 60000, skip: process.platform === 'win32' },
  async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-native-')));
    const project = {
      id: 'agent-integration-project',
      domain: 'chip',
      path: path.join(root, 'project'),
    };
    fs.mkdirSync(project.path);
    const model = await startModel({ calls: [], success: 'CONTROLLED_AGENT_REPLY' });
    const services = [];
    t.after(async () => {
      await Promise.all(services.map(tasks => tasks.close()));
      model.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const configDirectory = path.join(root, 'config');
    const modelProfile = {
      provider: 'openai_legacy',
      endpoint: model.endpoint,
      model: 'controlled',
      contextSize: 32768,
      thinking: false,
    };
    const apiKey = 'controlled-task-agent-key';
    const shareDir = writeCliConfig(configDirectory, modelProfile);
    const environment = {
      ...process.env,
      INDUSTRIAL_HARNESS_CONFIG_DIR: configDirectory,
      INDUSTRIAL_HARNESS_MIN_FREE_MEMORY_BYTES: '0',
    };
    delete environment.INDUSTRIAL_HARNESS_PACK_STORE;
    const options = {
      environment,
      resourceDirectory: configDirectory,
      chatDirectory: path.join(root, 'chats'),
      logDirectory: path.join(root, 'logs'),
      runtimeOptions: { directory: path.join(root, 'state') },
      contextOptions: { directory: path.join(root, 'state') },
      getConfig: entry => ({
        shareDir,
        profile: modelProfile,
        apiKey,
        revision: 1,
        environment,
        env: sessionEnv(modelProfile, apiKey),
        disabledMcpServers: entry.disabled?.mcpServers ?? [],
      }),
    };
    const createService = () => {
      const tasks = new TaskService(options);
      services.push(tasks);
      return tasks;
    };
    const tasks = createService();
    const taskPrefix = 'Inspect RTL source files in this chip project. ';
    const defaultChat = tasks.newChat(project);
    const defaultEntry = tasks.resume(project, defaultChat.id);
    const baseline = await tasks.prepare(defaultEntry, { task: taskPrefix + 'BASELINE' });
    assert.ok(
      baseline.scope.skills.length > 0,
      'the same project has skills before the Agent restriction',
    );

    const definition = {
      name: 'Controlled read agent',
      description: 'Inspect the existing project without shell commands',
      instructions: 'ORIGINAL_AGENT_INSTRUCTIONS_7821',
      domain: 'chip',
      tools: ['Read', 'Skill'],
      disallowedTools: ['Bash'],
      skills: [],
      subagents: [],
    };
    const selected = tasks.saveAgent(definition);
    const chat = tasks.newChat(project, { agentId: selected.id });
    const entry = tasks.resume(project, chat.id);
    const snapshot = tasks.chatAgent(project, chat.id);
    assert.equal(snapshot.id, selected.id);
    async function run(service, active, marker) {
      const task = taskPrefix + marker;
      const prepared = await service.prepare(active, { task });
      assert.deepEqual(prepared.scope.skills, []);
      const events = [];
      const started = await service.start(active, task, { onEvent: event => events.push(event) });
      const result = await started.completion;
      assert.equal(result.status, 'finished', JSON.stringify(events));
      assert.equal(events.filter(event => event.type === 'context-reset').length, 0);
      return events;
    }
    await run(tasks, entry, 'FIRST_AGENT_CHAT_MEMORY');
    assert.equal(model.requests.length, 1);
    const first = model.requests[0];
    assert.match(
      JSON.stringify(first.messages.filter(message => message.role === 'system')),
      /ORIGINAL_AGENT_INSTRUCTIONS_7821/,
    );
    assert.ok(!first.tools.some(tool => tool.function.name === 'Bash'));
    assert.ok(first.tools.some(tool => tool.function.name === 'Read'));
    const nativeId = entry.agent.session.nativeId;
    const sessionDirectory = entry.agent.sessionConfigDir;
    assert.ok(sessionDirectory.startsWith(path.join(root, 'chats') + path.sep));
    assert.match(
      fs.readFileSync(path.join(sessionDirectory, 'config.toml'), 'utf8'),
      /extra_agent_dirs = /,
    );
    const identity = JSON.parse(
      fs.readFileSync(path.join(sessionDirectory, 'harness-native-session.json')),
    );
    assert.equal(identity.agentProfile, nativeAgentProfile(selected.id));

    tasks.saveAgent({
      ...definition,
      id: selected.id,
      instructions: 'UPDATED_AGENT_INSTRUCTIONS_7821',
    });
    assert.equal(tasks.chatAgent(project, chat.id).revision, snapshot.revision);
    assert.throws(
      () => tasks.setChatAgent(project, chat.id, 'builtin:default'),
      /Agent|started|locked|new chat/i,
    );
    await run(tasks, entry, 'SECOND_AGENT_CHAT_MEMORY');
    assert.equal(entry.agent.session.nativeId, nativeId);
    assert.match(JSON.stringify(model.requests.at(-1).messages), /FIRST_AGENT_CHAT_MEMORY/);
    assert.match(
      JSON.stringify(model.requests.at(-1).messages),
      /ORIGINAL_AGENT_INSTRUCTIONS_7821/,
    );
    assert.ok(
      !JSON.stringify(model.requests.at(-1).messages).includes('UPDATED_AGENT_INSTRUCTIONS_7821'),
    );

    await tasks.close();
    const reopened = createService();
    const resumed = reopened.resume(project, chat.id);
    assert.equal(reopened.chatAgent(project, chat.id).revision, snapshot.revision);
    await run(reopened, resumed, 'THIRD_AGENT_CHAT_MEMORY');
    assert.equal(resumed.agent.session.nativeId, nativeId);
    assert.equal(resumed.agent.sessionConfigDir, sessionDirectory);
    const restoredMessages = JSON.stringify(model.requests.at(-1).messages);
    assert.match(restoredMessages, /FIRST_AGENT_CHAT_MEMORY/);
    assert.match(restoredMessages, /SECOND_AGENT_CHAT_MEMORY/);
    assert.match(restoredMessages, /CONTROLLED_AGENT_REPLY/);
    assert.match(restoredMessages, /ORIGINAL_AGENT_INSTRUCTIONS_7821/);
    assert.ok(!restoredMessages.includes('UPDATED_AGENT_INSTRUCTIONS_7821'));

    const updatedChat = reopened.newChat(project, { agentId: selected.id });
    const updatedEntry = reopened.resume(project, updatedChat.id);
    assert.notEqual(reopened.chatAgent(project, updatedChat.id).revision, snapshot.revision);
    await run(reopened, updatedEntry, 'NEW_CHAT_UPDATED_AGENT');
    assert.match(JSON.stringify(model.requests.at(-1).messages), /UPDATED_AGENT_INSTRUCTIONS_7821/);
    assert.ok(!JSON.stringify(model.requests.at(-1).messages).includes('FIRST_AGENT_CHAT_MEMORY'));
  },
);
