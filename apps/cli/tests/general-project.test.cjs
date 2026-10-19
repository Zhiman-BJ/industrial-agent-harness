const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskService } = require('@industrial-agent-harness/harness-application');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const { run } = require('../src/main.cjs');

// Controlled kernel; project/registry/Runtime/approval/persistence are real.
class Kernel {
  constructor(_project, getScope, _read, _detail, emit, _config, _factory, options) {
    Object.assign(this, { getScope, emit, options });
  }
  async run() {
    const runtime = this.options.industrialRuntime;
    const state = await runtime.inspect();
    const request = {
      toolId: 'project.files.apply',
      expectedStateId: state.id,
      inputs: {
        changes: [{ path: 'hello.txt', content: 'No pack required\n', expectedSha256: null }],
      },
    };
    const result = await runtime.execute(request, { scope: this.getScope(), approval: true });
    assert.equal(result.action.status, 'completed', JSON.stringify(result));
    assert.equal(result.verification.status, 'not_run');
    await this.options.onIndustrialResult(result);
    this.emit({ type: 'done', result: { status: 'completed' } });
  }
  async close() {}
}

test('empty managed store supports General through Desktop task API and CLI without a Pack lease', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'general-project-'));
  const previous = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = path.join(root, 'packs');
  t.after(() => {
    if (previous === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const registry = loadRegistry();
  assert.deepEqual(registry.domains, [
    { id: 'general', label: 'General', emoji: '⚙️', builtin: true },
  ]);
  assert.deepEqual(registry.runtimePacks, []);
  assert.deepEqual(registry.capabilities, []);
  const project = { id: 'general-project', domain: 'general', path: path.join(root, 'project') };
  fs.mkdirSync(project.path);
  const environment = { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') };
  const tasks = new TaskService({
    Session: Kernel,
    environment,
    chatDirectory: path.join(root, 'chats'),
    runtimeOptions: { directory: path.join(root, 'state') },
    getConfig: () => ({}),
  });
  try {
    assert.deepEqual(tasks.packManager.list(), []);
    const chat = tasks.chats.create(project.path, project.domain);
    const entry = tasks.resume(project, chat.id);
    const task = 'create and edit project files';
    const prepared = await tasks.prepare(entry, { task });
    assert.equal(prepared.scope.domain, 'general');
    assert.ok(prepared.scope.tools.includes('project.files.apply'));
    assert.ok(prepared.scope.tools.every(id => id.startsWith('project.')));
    await assert.rejects(tasks.prepare(entry, { task, domain: 'uninstalled' }), /fixed|differs/);
    const started = await tasks.start(entry, task);
    assert.equal((await started.completion).status, 'completed');
    assert.equal(
      fs.readFileSync(path.join(project.path, 'hello.txt'), 'utf8'),
      'No pack required\n',
    );
    assert.equal(tasks.history(project, chat.id).turns[0].status, 'completed');
    const invalidProject = { ...project, id: 'invalid-project', domain: 'uninstalled' };
    const invalid = tasks.resume(
      invalidProject,
      tasks.chats.create(project.path, invalidProject.domain).id,
    );
    await assert.rejects(tasks.prepare(invalid, { task }), /valid project domain/);
    const cliProject = path.join(root, 'cli-project');
    fs.mkdirSync(cliProject);
    const events = [];
    const code = await run(
      {
        projectDir: cliProject,
        domain: 'general',
        task,
        chatDir: path.join(root, 'cli-chats'),
        stateDir: path.join(root, 'cli-state'),
      },
      { write: line => events.push(JSON.parse(line)) },
      { ...environment, KIMI_API_KEY: 'controlled-key' },
      Kernel,
    );
    assert.equal(code, 0, JSON.stringify(events));
    assert.equal(fs.readFileSync(path.join(cliProject, 'hello.txt'), 'utf8'), 'No pack required\n');
    assert.ok(events.some(event => event.type === 'industrial_result'));
  } finally {
    await tasks.close();
  }
});
