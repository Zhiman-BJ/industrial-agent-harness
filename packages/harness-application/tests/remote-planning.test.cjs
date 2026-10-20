const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TaskService } = require('../src/index.cjs');
const { runtimeTools } = require('../../agent-kimi/src/runtime-tools.cjs');
const { planningGateway } = require('../../harness-core/tests/helpers/planning-gateway.cjs');

async function setup(t, script, { configured = false } = {}) {
  const cleanup = [];
  const gateway = planningGateway({ after: callback => cleanup.push(callback) }, { configured });
  // The helper supplies the actual protocol transport. TaskService must own the
  // only live project store, just as it does for both Desktop and CLI adapters.
  await gateway.bundle.runtime.close();
  const root = path.dirname(gateway.projectDir);
  const project = { id: 'project', path: gateway.projectDir, domain: 'test' };
  const kernels = [];
  const approvals = [];
  const events = [];
  class Kernel {
    constructor(_directory, getScope, _read, _detail, emit, _config, _factory, options) {
      Object.assign(this, { getScope, emit, options });
      kernels.push(this);
    }
    async run(task) {
      this.running = true;
      const runtime = this.options.industrialRuntime;
      const tools = runtimeTools(
        runtime,
        this.getScope,
        async (_descriptor, request, context) => {
          const authorization = { taskId: context.turnId };
          const explicit = runtime.requiresExplicitApproval?.(request, authorization);
          if (!explicit && runtime.hasStandingApproval?.(request, authorization)) return true;
          if (explicit) approvals.push(runtime.approvalPreview(request, authorization));
          return true;
        },
        this.options.onIndustrialResult,
        { getApplicationContext: this.options.getApplicationContext },
      );
      const call = async (toolId, inputs) =>
        JSON.parse(
          (
            await tools
              .find(tool => tool.name === 'industrial_action_call')
              .handler({ toolId, inputs, expectedStateId: this.getScope().stateId })
          ).output,
        );
      const artifact = result => JSON.parse(runtime.readArtifact(result.artifactSet[0].id).content);
      try {
        await script({ task, kernel: this, call, artifact, gateway, approvals });
        this.emit({ type: 'done', result: { status: 'completed' } });
      } finally {
        this.running = false;
      }
    }
    async close() {
      this.closed = true;
    }
  }
  const registry = {
    domains: [{ id: 'test', title: 'Test domain', builtin: true }],
    skills: [],
    runtimePacks: [],
    providerPacks: [],
    capabilities: [
      {
        id: 'test.local-only',
        domain: 'test',
        title: 'Local Pack executable',
        stages: [],
        alwaysAvailable: true,
        priority: 100,
        keywords: [],
        skills: [],
        verification: [],
        tools: [{ id: 'test.local-only', summary: 'Must not enter a remote host scope' }],
      },
    ],
  };
  const tasks = new TaskService({
    Session: Kernel,
    environment: gateway.settings.environment,
    getRegistry: () => registry,
    getConfig: () => ({}),
    chatDirectory: path.join(root, 'chats'),
    resourceDirectory: path.join(root, 'resources'),
    runtimeOptions: { directory: path.join(root, 'runtime'), remoteSettings: gateway.settings },
    contextOptions: { directory: path.join(root, 'context') },
    externalRegistry: {
      records: () => {
        throw Error('Remote planning must not load host MCP servers.');
      },
    },
    onEvent: event => events.push(event),
  });
  t.after(async () => {
    await tasks.close();
    for (const callback of cleanup) await callback();
  });
  const chat = tasks.chats.create(project.path, project.domain);
  const entry = tasks.resume(project, chat.id);
  return {
    gateway,
    tasks,
    project,
    entry,
    kernels,
    approvals,
    events,
    async run(task) {
      const prepared = await tasks.prepare(entry, { task });
      const started = await tasks.start(entry, task);
      return { prepared, result: await started.completion };
    },
  };
}

const createFile = (call, file, content = 'planned locally') =>
  call('project.files.apply', {
    changes: [{ path: file, content, expectedSha256: null }],
  });

test('shared task resolve/start works offline before any snapshot and invokes local agent tools', async t => {
  const f = await setup(t, async ({ call }) => {
    const applied = await createFile(call, 'planned.txt');
    assert.equal(applied.actionStatus, 'completed', JSON.stringify(applied));
  });
  const { prepared, result } = await f.run('Create inputs and plan a remote task');
  assert.equal(result.status, 'completed', JSON.stringify(f.events));
  assert.equal(f.kernels.length, 1);
  assert.equal(f.entry.runtimeBundle.runtime.hostRuntimeOnly, true);
  assert.equal(f.entry.runtimeBundle.runtime.domain, 'test');
  assert.ok(prepared.scope.tools.includes('project.files.apply'));
  assert.ok(prepared.scope.tools.includes('project.remote.plan'));
  assert.ok(prepared.scope.tools.includes('project.remote.prepare'));
  assert.ok(!prepared.scope.tools.includes('test.local-only'));
  assert.ok(!prepared.scope.tools.includes('project.task.run'));
  assert.deepEqual(f.entry.externalServers, []);
  assert.equal(
    fs.readFileSync(path.join(f.project.path, 'planned.txt'), 'utf8'),
    'planned locally',
  );
  assert.equal(f.gateway.settings.project(f.project.path, 'test').snapshotId, undefined);
  assert.equal(f.gateway.requests.length, 0);
  const history = f.tasks.history(f.project, f.entry.id);
  assert.equal(history.turns.length, 1);
  assert.ok(history.turns[0].events.some(event => event.type === 'industrial-result'));
});

test('shared task agent plans one batch, prepares the live service, refreshes scope and calls remote tools', async t => {
  const f = await setup(
    t,
    async ({ call, artifact, kernel, approvals }) => {
      const planned = await call('project.remote.plan', {
        files: ['input.txt'],
        tools: ['test.run', 'test.inspect'],
        remember: true,
      });
      assert.equal(planned.actionStatus, 'completed', JSON.stringify(planned));
      const plan = artifact(planned);
      const prepared = await call('project.remote.prepare', { reviewId: plan.reviewId });
      assert.equal(prepared.actionStatus, 'completed', JSON.stringify(prepared));
      assert.equal(prepared.verification.status, 'not_run');
      assert.ok(kernel.getScope().tools.includes('test.run'));
      assert.ok(!kernel.getScope().tools.includes('test.extra'));
      for (const toolId of ['test.run', 'test.inspect']) {
        const executed = await call(toolId, {});
        assert.equal(executed.actionStatus, 'completed', JSON.stringify(executed));
        assert.equal(executed.verification.status, 'passed');
      }
      assert.equal(approvals.length, 1);
      assert.match(approvals[0].text, /input.txt/);
      assert.match(approvals[0].text, /test.run/);
    },
    { configured: true },
  );
  const { result } = await f.run('Prepare inputs and test.run then test.inspect remotely');
  assert.equal(result.status, 'completed', JSON.stringify(f.events));
  assert.equal(f.gateway.uploads.length, 1);
  assert.equal(f.gateway.invocations.length, 2);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.events.filter(event => event.type === 'industrial-result').length, 4);
  assert.ok(f.gateway.settings.project(f.project.path, 'test').syncPolicy);
});

test('unavailable protected execution records failure while the same shared chat can keep planning locally', async t => {
  const f = await setup(
    t,
    async ({ call, artifact, gateway }) => {
      const planned = await call('project.remote.plan', {
        files: ['input.txt'],
        tools: ['test.run'],
      });
      gateway.controls.failInventory = true;
      const prepared = await call('project.remote.prepare', {
        reviewId: artifact(planned).reviewId,
      });
      assert.equal(prepared.actionStatus, 'failed');
      const local = await createFile(call, 'next-step.txt', 'continue after remote failure');
      assert.equal(local.actionStatus, 'completed', JSON.stringify(local));
    },
    { configured: true },
  );
  const { result } = await f.run('Prepare and test.run remotely');
  assert.equal(result.status, 'completed', JSON.stringify(f.events));
  assert.equal(f.gateway.invocations.length, 0);
  assert.equal(
    fs.readFileSync(path.join(f.project.path, 'next-step.txt'), 'utf8'),
    'continue after remote failure',
  );
  assert.ok(
    f.events.some(event => event.type === 'industrial-result' && event.action.status === 'failed'),
  );
});

test('an idle configuration replacement closes the old agent and store while retaining the same chat history', async t => {
  const f = await setup(
    t,
    async ({ task, call }) => {
      const applied = await createFile(call, task.includes('second') ? 'second.txt' : 'first.txt');
      assert.equal(applied.actionStatus, 'completed', JSON.stringify(applied));
    },
    { configured: true },
  );
  assert.equal((await f.run('Create first input')).result.status, 'completed');
  const first = f.kernels[0];
  const previousRuntime = first.options.industrialRuntime;
  const projectId = previousRuntime.project.projectId;
  f.gateway.settings.environment.TEST_TOKEN = 'replacement-fixture-token';
  const second = await f.run('Create second input');
  assert.equal(second.result.status, 'completed', JSON.stringify(f.events));
  assert.equal(first.closed, true);
  assert.equal(previousRuntime.closed, true);
  assert.equal(f.kernels.length, 2);
  assert.notEqual(f.kernels[1].options.industrialRuntime, previousRuntime);
  assert.equal(f.kernels[1].options.industrialRuntime.project.projectId, projectId);
  assert.equal(f.tasks.history(f.project, f.entry.id).turns.length, 2);
  assert.equal(f.gateway.requests.length, 0);
  assert.equal(f.tasks.projects.retirementErrors.length, 0);
});

test('changed execution configuration cannot replace an agent during its active turn', async t => {
  let entered, release;
  const running = new Promise(resolve => (entered = resolve));
  const wait = new Promise(resolve => (release = resolve));
  const f = await setup(
    t,
    async () => {
      entered();
      await wait;
    },
    { configured: true },
  );
  await f.tasks.prepare(f.entry, { task: 'Plan remotely' });
  const started = await f.tasks.start(f.entry, 'Plan remotely');
  await running;
  const runtime = f.entry.runtimeBundle.runtime;
  f.gateway.settings.environment.TEST_TOKEN = 'changed-during-turn';
  try {
    await assert.rejects(
      f.tasks.resolve(f.entry, { task: 'Plan remotely' }),
      /Stop the running chat/,
    );
    assert.equal(runtime.closed, false);
    assert.equal(f.kernels[0].closed, undefined);
  } finally {
    release();
  }
  assert.equal((await started.completion).status, 'completed');
});
