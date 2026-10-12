const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskService } = require('../src/index.cjs');
const { run } = require('../../../apps/cli/src/main.cjs');

class Kernel {
  constructor(_project, getScope, _read, _detail, emit, _config, _factory, options) {
    Object.assign(this, { getScope, emit, options });
  }
  async run() {
    const runtime = this.options.industrialRuntime;
    const state = await runtime.inspect();
    const result = await runtime.execute(
      {
        toolId: 'project.files.apply',
        expectedStateId: state.id,
        inputs: {
          changes: [
            { path: 'answer.txt', content: 'shared application path\n', expectedSha256: null },
          ],
        },
      },
      { scope: this.getScope(), approval: true },
    );
    assert.equal(result.action.status, 'completed', JSON.stringify(result));
    assert.equal(result.verification.status, 'not_run');
    await this.options.onIndustrialResult(result);
    this.emit({ type: 'done', result: { status: 'completed' } });
  }
  async close() {
    this.closed = true;
  }
}
function fixture(t, Session = Kernel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-task-service-'));
  const project = { id: 'project', domain: 'chip', path: path.join(root, 'project') };
  fs.mkdirSync(project.path);
  const environment = { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') };
  delete environment.INDUSTRIAL_HARNESS_PACK_STORE;
  const options = {
    Session,
    environment,
    chatDirectory: path.join(root, 'chats'),
    runtimeOptions: { directory: path.join(root, 'state') },
    contextOptions: { directory: path.join(root, 'state') },
    getConfig: () => ({}),
  };
  const tasks = new TaskService(options);
  t.after(async () => {
    await tasks.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const chat = tasks.chats.create(project.path, project.domain);
  return { tasks, project, entry: tasks.resume(project, chat.id), root, options };
}
test('Desktop task API and CLI persist the same real file Action, verification and refreshed scope', async t => {
  const desktop = fixture(t);
  const prepared = await desktop.tasks.prepare(desktop.entry, {
    task: 'create and edit project files',
  });
  assert.ok(prepared.scope.tools.includes('project.files.apply'));
  const liveEvents = [];
  const started = await desktop.tasks.start(desktop.entry, 'create and edit project files', {
    onEvent: event => liveEvents.push(event),
  });
  const result = await started.completion;
  assert.equal(
    result.status,
    'completed',
    JSON.stringify(desktop.tasks.history(desktop.project, desktop.entry.id)),
  );
  const history = desktop.tasks.history(desktop.project, desktop.entry.id);
  const fact = history.turns[0].events.find(event => event.type === 'industrial-result');
  const liveFact = liveEvents.find(event => event.type === 'industrial-result');
  assert.ok(Number.isFinite(Date.parse(liveFact.recordedAt)));
  assert.equal(liveFact.recordedAt, fact.recordedAt);
  assert.ok(fact.action.id && fact.verification.id && fact.state.id);
  assert.equal(
    fs.readFileSync(path.join(desktop.project.path, 'answer.txt'), 'utf8'),
    'shared application path\n',
  );
  const cli = fixture(t);
  const rows = [];
  await cli.tasks.close();
  const code = await run(
    {
      projectDir: cli.project.path,
      domain: cli.project.domain,
      task: 'create and edit project files',
      chatDir: path.join(cli.root, 'cli-chats'),
      stateDir: path.join(cli.root, 'cli-state'),
    },
    { write: line => rows.push(JSON.parse(line)) },
    { ...cli.options.environment, KIMI_API_KEY: 'controlled-key' },
    Kernel,
  );
  assert.equal(code, 0);
  const cliFact = rows.find(row => row.type === 'industrial_result');
  assert.equal(cliFact.action.toolId, fact.action.toolId);
  assert.deepEqual(cliFact.verification.checks, fact.verification.checks);
  assert.equal(cliFact.state.status, fact.state.status);
});
test('kernel failure releases chat and Pack leases; chat can be resumed and ownership is enforced', async t => {
  let releases = 0;
  class Failing extends Kernel {
    async run() {
      throw Error('controlled kernel failure');
    }
  }
  const { tasks, entry, project } = fixture(t, Failing);
  tasks.packManager = { acquireUse: () => () => releases++ };
  await tasks.prepare(entry, { task: 'create a file' });
  const started = await tasks.start(entry, 'create a file');
  assert.equal((await started.completion).status, 'error');
  assert.equal(releases, 1);
  assert.equal(tasks.sessions.busy(entry), false);
  const release = tasks.chats.acquire(entry.id);
  release();
  assert.throws(() => tasks.resume({ ...project, id: 'another' }, entry.id), /another project/);
  await tasks.prepare(entry, { task: 'retry file creation' });
  assert.equal(tasks.history(project, entry.id).turns.at(-1).status, 'scoped');
});
for (const phase of ['prepare', 'start']) {
  test(`shutdown during ${phase} drains state inspection and prevents a late native session`, async t => {
    let nativeSessions = 0;
    class Counting extends Kernel {
      constructor(...args) {
        super(...args);
        nativeSessions++;
      }
    }
    const { tasks, entry } = fixture(t, Counting);
    if (phase === 'start') await tasks.prepare(entry, { task: 'create a file' });
    let inspected, resume;
    const entered = new Promise(resolve => (inspected = resolve));
    const gate = new Promise(resolve => (resume = resolve));
    const resolve = tasks.resolve.bind(tasks);
    tasks.resolve = async (...args) => {
      const result = await resolve(...args);
      inspected();
      await gate;
      return result;
    };
    let releases = 0;
    tasks.packManager = { acquireUse: () => () => releases++ };
    const pending =
      phase === 'start'
        ? tasks.start(entry, 'create a file')
        : tasks.prepare(entry, { task: 'create a file' });
    const rejected = assert.rejects(pending, /Task session is unavailable/);
    await entered;
    let closed = false;
    const closing = tasks.close().then(() => (closed = true));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'fact stores stay open until pending inspection drains');
    resume();
    await rejected;
    await closing;
    assert.equal(nativeSessions, 0);
    assert.equal(releases, phase === 'start' ? 1 : 0);
    assert.equal(tasks.sessions.matching().length, 0);
    assert.equal(tasks.operations.size, 0);
  });
}
test('shutdown during input observation keeps its context database open until the pending write settles', async t => {
  class IdleRelease extends Kernel {
    async close() {
      this.options.onIdleRelease();
      await super.close();
    }
  }
  const { tasks, entry, project } = fixture(t, IdleRelease);
  await tasks.prepare(entry, { task: 'create a file' });
  await (
    await tasks.start(entry, 'create a file')
  ).completion;
  await tasks.prepare(entry, { task: 'create a file' });
  const file = path.join(project.path, 'input.txt');
  fs.writeFileSync(file, 'observed input');
  const context = tasks.context(entry);
  const observe = context.observeArtifact.bind(context);
  let entered, resume;
  const observing = new Promise(resolve => (entered = resolve));
  const gate = new Promise(resolve => (resume = resolve));
  context.observeArtifact = async input => {
    entered();
    await gate;
    return observe(input);
  };
  const pending = tasks.start(entry, 'create a file', {
    artifacts: new Map([['input', { file, metadata: { kind: 'text' } }]]),
  });
  const rejected = assert.rejects(pending, /Task session is unavailable/);
  await observing;
  const closing = tasks.close();
  assert.throws(() => tasks.resume(project, entry.id), /Task session is unavailable/);
  resume();
  await rejected;
  await closing;
  assert.equal(entry.agent.closed, true);
});
test('background tasks retain leases until their native completion; cancel and approval use the same session', async t => {
  class Background extends Kernel {
    async run() {
      this.backgroundTasks = true;
      this.emit({ type: 'done', result: { status: 'completed' } });
    }
    approve(id, response) {
      return { id, response };
    }
    answerQuestion(id, answers) {
      return { id, answers };
    }
    async interrupt() {
      this.backgroundTasks = false;
      this.emit({ type: 'background-state' });
    }
  }
  const { tasks, entry, project } = fixture(t, Background);
  let releases = 0;
  tasks.packManager = { acquireUse: () => () => releases++ };
  await tasks.prepare(entry, { task: 'create a file' });
  await (
    await tasks.start(entry, 'create a file')
  ).completion;
  assert.equal(tasks.sessions.busy(entry), true);
  assert.equal(releases, 0);
  await assert.rejects(tasks.prepare(entry, { task: 'another task' }), /already running/);
  assert.deepEqual(tasks.approve(entry, 'a', 'reject'), { id: 'a', response: 'reject' });
  assert.deepEqual(tasks.answer(entry, 'q', { choice: 'yes' }), {
    id: 'q',
    answers: { choice: 'yes' },
  });
  await tasks.cancel(entry);
  assert.equal(releases, 1);
  assert.equal(tasks.sessions.busy(entry), false);
  assert.equal(tasks.history(project, entry.id).turns[0].status, 'completed');
});
test('task preparation requests the registry for the bound project rather than a global environment selection', async t => {
  const f = fixture(t),
    registry = f.tasks.registry(),
    seen = [];
  f.tasks.options.getRegistry = project => {
    seen.push(project);
    return registry;
  };
  await f.tasks.prepare(f.entry, { task: 'create a project file' });
  assert.ok(seen.length > 0);
  assert.ok(seen.every(project => project?.path === f.project.path));
});
