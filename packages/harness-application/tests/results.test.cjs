const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TaskService } = require('../src/index.cjs');
const { runtimeTools } = require('../../agent-kimi/src/runtime-tools.cjs');
const { applicationTools } = require('../../agent-kimi/src/application-tools.cjs');
const { startToolServer } = require('../../agent-kimi/src/tool-server.cjs');
const { RemoteSettings } = require('@industrial-agent-harness/harness-core');
const { IndustrialRuntime } = require('@industrial-agent-harness/domain-runtime');
const { TaskResults } = require('../src/results.cjs');

function setup(t, script, cleanupError) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-results-')));
  const project = { id: 'project', domain: 'chip', path: path.join(directory, 'project') };
  fs.mkdirSync(project.path);
  const events = [];
  class Kernel {
    constructor(_dir, getScope, _read, _detail, emit, _config, _factory, options) {
      Object.assign(this, { getScope, emit, options });
    }
    async run(task) {
      const tools = runtimeTools(
        this.options.industrialRuntime,
        this.getScope,
        async () => true,
        this.options.onIndustrialResult,
        { getApplicationContext: this.options.getApplicationContext },
      );
      const apply = changes =>
        tools
          .find(tool => tool.name === 'industrial_action_call')
          .handler({
            toolId: 'project.files.apply',
            inputs: { changes },
            expectedStateId: this.getScope().stateId,
          });
      const status = await script({
        task,
        apply,
        kernel: this,
        context: this.options.getApplicationContext(),
        application: applicationTools(this.options.getApplicationContext),
      });
      this.emit({ type: 'done', result: { status: status || 'completed' } });
    }
    async close() {}
  }
  const options = {
    Session: Kernel,
    chatDirectory: path.join(directory, 'chats'),
    resourceDirectory: path.join(directory, 'config'),
    runtimeOptions: { directory: path.join(directory, 'state') },
    getConfig: () => ({}),
    onEvent: (event, metadata) => events.push({ ...event, ...metadata }),
  };
  let tasks = new TaskService(options);
  const chat = tasks.chats.create(project.path, project.domain);
  let entry = tasks.resume(project, chat.id);
  t.after(async () => {
    if (cleanupError)
      await assert.rejects(tasks.close(), error =>
        error.errors?.some(cause => cleanupError.test(cause.message)),
      );
    else await tasks.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    project,
    events,
    get tasks() {
      return tasks;
    },
    get entry() {
      return entry;
    },
    async run(task) {
      await tasks.prepare(entry, { task });
      return (await tasks.start(entry, task)).completion;
    },
    async reopen(runtimeOptions = {}) {
      await tasks.close();
      tasks = new TaskService({
        ...options,
        runtimeOptions: { ...options.runtimeOptions, ...runtimeOptions },
      });
      entry = tasks.resume(project, chat.id);
    },
  };
}
const change = (file, content, expectedSha256 = null) => ({ path: file, content, expectedSha256 });

test('empty and text-only remote histories do not require execution setup or load Packs', async t => {
  const f = setup(t, async () => {});
  const settings = new RemoteSettings({
    directory: path.join(path.dirname(f.project.path), 'remote'),
    environment: {},
  });
  settings.setLocation(f.project.path, f.project.domain, 'remote');
  await f.reopen({ remoteSettings: settings });
  assert.equal(
    f.tasks.projects.bundles.size,
    0,
    'History must not instantiate an execution runtime.',
  );
  f.tasks.registry = () => {
    throw Error('History must not load execution Packs.');
  };
  assert.deepEqual(f.tasks.history(f.project, f.entry.id).turns, []);
  const turnId = f.tasks.chats.beginTurn(f.entry.id, 'Saved conversation', null, false);
  f.tasks.chats.append(turnId, {
    type: 'answer',
    text: 'Readable while remote setup is incomplete.',
  });
  f.tasks.chats.finish(turnId, 'completed');
  assert.equal(
    f.tasks.history(f.project, f.entry.id).turns[0].events[0].text,
    'Readable while remote setup is incomplete.',
  );
  const chat = f.tasks.chats.create(f.project.path, f.project.domain);
  assert.deepEqual(f.tasks.history(f.project, chat.id).turns, []);
  assert.equal(f.tasks.projects.bundles.size, 0);
});

test('persisted remote result records remain readable before remote execution is ready', async t => {
  const f = setup(t, async ({ apply }) => {
    await apply([change('saved.txt', 'Saved output')]);
  });
  const result = await f.run('produce saved output');
  const projectId = result.results.projectId;
  const state = f.entry.runtimeBundle.runtime.directory;
  await f.tasks.close();
  fs.mkdirSync(path.join(state, 'remote-workspaces'));
  fs.renameSync(
    path.join(state, projectId + '.sqlite'),
    path.join(state, 'remote-workspaces', projectId + '.sqlite'),
  );
  const settings = new RemoteSettings({
    directory: path.join(path.dirname(f.project.path), 'remote'),
    environment: {},
  });
  settings.update(f.project.path, f.project.domain, {
    location: 'remote',
    canonicalProjectId: projectId,
  });
  await f.reopen({ remoteSettings: settings });
  assert.equal(
    f.tasks.projects.bundles.size,
    0,
    'History must not instantiate an execution runtime.',
  );
  f.tasks.registry = () => {
    throw Error('History must not load execution Packs.');
  };
  const history = f.tasks.history(f.project, f.entry.id);
  const groups = history.turns[0].events.findLast(event => event.type === 'results-ready').results
    .groups;
  assert.equal(groups[0].id, result.results.groups[0].id);
  assert.equal(groups[0].contentStatus, 'recorded');
  assert.equal(groups[0].artifacts[0].relativePath, 'saved.txt');
  const view = f.tasks.results(f.entry, result.results.turnId);
  assert.equal(view.groups[0].id, groups[0].id);
  const request = {
    chatId: f.entry.id,
    turnId: result.results.turnId,
    groupId: groups[0].id,
    actionId: groups[0].actionId,
    artifactId: groups[0].primaryArtifactId,
  };
  assert.equal(
    fs.readFileSync((await f.tasks.openResult(f.entry, request)).file, 'utf8'),
    'Saved output',
  );
  assert.equal(
    (await f.tasks.openResult(f.entry, { ...request, groupId: undefined, revealOnly: true }))
      .artifact.id,
    request.artifactId,
  );
  await assert.rejects(
    f.tasks.openResult(f.entry, { ...request, groupId: 'unrelated-group' }),
    /outside this recorded result group/,
  );
  await assert.rejects(
    f.tasks.openResult(f.entry, { ...request, groupId: undefined, actionId: 'unrelated-action' }),
    /outside this request/,
  );
  const other = f.tasks.chats.create(f.project.path, f.project.domain);
  await assert.rejects(
    f.tasks.openResult(f.tasks.resume(f.project, other.id), request),
    /another chat/,
  );
  fs.writeFileSync(path.join(f.project.path, 'saved.txt'), 'Changed data');
  await assert.rejects(f.tasks.openResult(f.entry, request), /changed/);
  await assert.rejects(f.tasks.openResult(f.entry, { ...request, revealOnly: true }), /changed/);
  assert.equal(f.tasks.results(f.entry, request.turnId).groups[0].contentStatus, 'changed');
  assert.equal(f.tasks.projects.bundles.size, 0);
});

test('one history read hashes each recorded file once and the next read detects changed content', async t => {
  const size = 1024 * 1024;
  const files = new Set();
  const f = setup(t, async () => {});
  const runtime = new IndustrialRuntime(f.project.path, f.project.domain, {
    directory: path.join(path.dirname(f.project.path), 'state'),
    stateProvider: async () => ({ stage: null, inputHashes: {} }),
    verifiers: {
      fixture: async () => ({ status: 'not_run', reason: 'File fixture only.', metrics: {} }),
    },
    tools: [
      {
        descriptor: {
          schemaVersion: '1',
          id: 'test.output',
          version: '1',
          risk: 'mutating',
          verification: ['fixture'],
        },
        execute: ({ inputs }) => {
          const file = `output-${inputs.index}.txt`;
          fs.writeFileSync(path.join(f.project.path, file), 'x'.repeat(size));
          files.add(path.join(f.project.path, file));
          return {
            executionSucceeded: true,
            artifacts: [{ localId: 'file', file, kind: 'text' }],
            presentation: {
              schemaVersion: '1',
              groups: [{ key: 'file', title: file, primary: 'file' }],
            },
          };
        },
      },
    ],
  });
  t.after(() => runtime.close());
  const turnId = f.tasks.chats.beginTurn(f.entry.id, 'produce cumulative results', null, false);
  const context = new TaskResults(f.tasks.chats, f.entry, turnId, runtime, event =>
    f.tasks.chats.append(turnId, event),
  );
  for (let index = 0; index < 32; index++) {
    const state = await runtime.inspect();
    const result = await runtime.execute(
      { toolId: 'test.output', inputs: { index }, expectedStateId: state.id },
      {
        scope: {
          domain: f.project.domain,
          projectId: state.projectId,
          stateId: state.id,
          tools: ['test.output'],
        },
        approval: true,
      },
    );
    assert.equal(result.action.status, 'completed');
    context.register(result);
  }
  f.tasks.chats.finish(turnId, 'completed');
  await runtime.close();
  await f.reopen();
  const open = fs.openSync,
    read = fs.readSync,
    close = fs.closeSync;
  const descriptors = new Set();
  let bytes = 0;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    const fd = open.call(this, file, ...args);
    if (files.has(String(file))) descriptors.add(fd);
    return fd;
  });
  t.mock.method(fs, 'readSync', function (fd, ...args) {
    const count = read.call(this, fd, ...args);
    if (descriptors.has(fd)) bytes += count;
    return count;
  });
  t.mock.method(fs, 'closeSync', function (fd) {
    descriptors.delete(fd);
    return close.call(this, fd);
  });
  f.tasks.history(f.project, f.entry.id);
  assert.equal(bytes, 32 * size, 'cumulative events must share one per-read validation cache');
  fs.writeFileSync([...files][0], 'y'.repeat(size));
  bytes = 0;
  const history = f.tasks.history(f.project, f.entry.id);
  assert.equal(bytes, 32 * size, 'a new history read must validate files again');
  const resultEvents = history.turns[0].events.filter(event =>
    ['results-ready', 'results-changed'].includes(event.type),
  );
  assert.ok(resultEvents.every(event => event.results.groups[0].contentStatus === 'changed'));
});

test('ordinary files automatically register real refs, persist once and open only the recorded contents', async t => {
  let fact;
  const f = setup(t, async ({ apply, context }) => {
    const output = JSON.parse((await apply([change('notes.txt', 'first version')])).output);
    fact = f.entry.runtimeBundle.runtime.get('action', output.actionId);
    const before = context.snapshot().revision;
    context.register({ action: fact });
    assert.equal(context.snapshot().revision, before, 'duplicate Action is idempotent');
  });
  const completed = await f.run('write notes');
  const view = completed.results;
  assert.equal(view.groups.length, 1);
  assert.equal(view.groups[0].verifications[0].status, 'not_run');
  assert.equal(view.groups[0].artifacts[0].relativePath, 'notes.txt');
  assert.ok(
    f.events.some(event => event.type === 'results-changed' && event.results.phase === 'running'),
  );
  const group = view.groups[0];
  const request = { turnId: view.turnId, groupId: group.id, artifactId: group.primaryArtifactId };
  assert.equal((await f.tasks.openResult(f.entry, request)).artifact.id, group.primaryArtifactId);
  await f.reopen();
  assert.equal(f.tasks.results(f.entry, view.turnId).groups[0].id, group.id);
  assert.equal(
    f.tasks
      .history(f.project, f.entry.id)
      .turns[0].events.filter(event => event.eventId === `results:${view.turnId}:${fact.id}`)
      .length,
    1,
  );
  fs.writeFileSync(path.join(f.project.path, 'notes.txt'), 'changed');
  await assert.rejects(f.tasks.openResult(f.entry, request), /changed/);
  assert.equal(f.tasks.results(f.entry, view.turnId).groups[0].contentStatus, 'changed');
  const another = f.tasks.chats.create(f.project.path, f.project.domain);
  await assert.rejects(
    f.tasks.openResult(f.tasks.resume(f.project, another.id), request),
    /another chat/,
  );
});
test('explicit replacements preserve history; parallel outputs and optional selection retain all groups', async t => {
  let first, oldContext;
  const f = setup(t, async ({ task, apply, context, application }) => {
    if (task === 'first') {
      await apply([change('a.txt', 'one'), change('b.txt', 'parallel')]);
      first = context.view();
      oldContext = context;
    } else {
      const artifact = first.groups[0].artifacts[0];
      await apply([change('a.txt', 'two', artifact.sha256)]);
      const current = context.view();
      assert.deepEqual(current.groups[0].supersedes, [first.groups[0].id]);
      assert.throws(
        () => context.select({ groupIds: [current.groups[0].id], revision: 0 }),
        /stale/,
      );
      assert.throws(
        () => context.select({ groupIds: ['unknown'], revision: current.revision }),
        /Unknown/,
      );
      assert.throws(
        () =>
          oldContext.select({
            groupIds: [first.groups[0].id],
            revision: oldContext.snapshot().revision,
          }),
        /stale/,
      );
      const selection = application.find(tool => tool.name === 'select_result');
      await selection.handler({
        groupIds: [first.groups[0].id, current.groups[0].id],
        historical: true,
        revision: current.revision,
      });
      const selected = context.view();
      assert.equal(selected.groups.length, 2);
      assert.equal(selected.groups.filter(group => group.historical).length, 1);
      assert.equal(selected.selection.historical, true);
    }
  });
  await f.run('first');
  const second = await f.run('second');
  assert.equal(second.results.groups.length, 2);
  const history = f.tasks.history(f.project, f.entry.id);
  const previous = history.turns[0].events
    .filter(event => event.type === 'results-changed')
    .at(-1).results;
  assert.equal(previous.groups[0].superseded, true);
  assert.equal(previous.groups[1].superseded, false);
  assert.equal(
    f.entry.runtimeBundle.runtime.listActions().length,
    2,
    'selection creates no industrial Action',
  );
});
test('failed request retains visible partial files and does not relabel the preceding success', async t => {
  const f = setup(t, async ({ task, apply }) => {
    await apply([change(task + '.txt', 'actual output')]);
    if (task === 'failure') throw Error('controlled interruption after output');
  });
  const previous = await f.run('success');
  const failed = await f.run('failure');
  assert.equal(failed.status, 'error');
  assert.equal(failed.results.executionStatus, 'error');
  assert.equal(failed.results.groups.length, 1);
  assert.equal(f.tasks.results(f.entry, previous.turnId).requestStatus, 'completed');
  assert.equal(
    f.events.filter(event => event.type === 'results-ready').at(-1).autoPreviewEligible,
    false,
  );
});
test('late results keep the original request, cannot change a newer selection, and background readiness never arms preview', async t => {
  let old, pending;
  const f = setup(t, async ({ task, context, apply, kernel }) => {
    if (task === 'background') {
      old = context;
      kernel.backgroundTasks = true;
      await apply([change('early.txt', 'early')]);
    } else {
      await apply([change('new.txt', 'new')]);
      const view = context.view();
      context.select({ groupIds: [view.groups[0].id], revision: view.revision });
    }
  });
  const first = await f.run('background');
  assert.equal(first.results.phase, 'background');
  f.entry.agent.backgroundTasks = false;
  f.entry.agent.emit({ type: 'background-state', running: false });
  assert.equal(
    f.events.filter(event => event.type === 'results-ready').at(-1).autoPreviewEligible,
    false,
  );
  const runtime = f.entry.runtimeBundle.runtime;
  const state = await runtime.inspect();
  pending = await runtime.execute(
    {
      toolId: 'project.files.apply',
      expectedStateId: state.id,
      inputs: { changes: [change('late.txt', 'late')] },
    },
    { scope: f.entry.scope, approval: true },
  );
  const newer = await f.run('newer');
  const selection = newer.results.selection;
  await old.onIndustrialResult(pending);
  assert.equal(f.tasks.results(f.entry, first.turnId).groups.length, 2);
  assert.deepEqual(f.tasks.results(f.entry, newer.turnId).selection, selection);
  assert.equal(f.events.at(-1).turnId, first.turnId);
});
test('application tools work through the authenticated MCP bridge without an industrial runtime', async t => {
  let selected;
  const context = {
    view: () => ({ revision: 3, groups: [{ id: 'document' }] }),
    select: args => {
      selected = args;
      return context.view();
    },
  };
  const server = await startToolServer(applicationTools(() => context));
  t.after(server.close);
  async function call(name, args) {
    const response = await fetch(server.config.url, {
      method: 'POST',
      headers: {
        ...server.config.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return response.json();
  }
  const listed = await call('list_results', {});
  assert.equal(JSON.parse(listed.result.content[0].text).revision, 3);
  const result = await call('select_result', { groupIds: ['document'], revision: 3 });
  assert.equal(result.result.isError, false);
  assert.deepEqual(selected.groupIds, ['document']);
  assert.equal(
    (await call('select_result', { groupIds: ['document'], revision: 3, sha256: 'forged' })).result
      .isError,
    true,
  );
});

test('current selection rejects changed bytes while preserving the recorded check', async t => {
  const f = setup(t, async ({ apply, context }) => {
    await apply([change('note.txt', 'recorded')]);
    const view = context.view();
    fs.writeFileSync(path.join(f.project.path, 'note.txt'), 'modified');
    assert.throws(
      () => context.select({ groupIds: [view.groups[0].id], revision: view.revision }),
      /stale or unavailable/,
    );
    assert.equal(context.view().groups[0].verifications[0].status, 'not_run');
  });
  await f.run('create note');
});

test('cancelled requests preserve actual partial outputs and never authorize automatic preview', async t => {
  const f = setup(t, async ({ apply }) => {
    await apply([change('partial.txt', 'saved before cancellation')]);
    return 'cancelled';
  });
  const result = await f.run('cancel after saving');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.results.requestStatus, 'cancelled');
  assert.equal(result.results.groups.length, 1);
  assert.equal(
    f.events.filter(event => event.type === 'results-ready').at(-1).autoPreviewEligible,
    false,
  );
});

test('result display failures never block scope state synchronization', async t => {
  const f = setup(t, async ({ apply, context }) => {
    const first = JSON.parse((await apply([change('one.txt', 'one')])).output);
    const realRegister = context.register.bind(context);
    context.register = () => {
      throw Error('controlled display failure');
    };
    const second = JSON.parse((await apply([change('two.txt', 'two')])).output);
    context.register = realRegister;
    assert.equal(second.actionStatus, 'completed');
    assert.notEqual(
      second.stateId,
      first.stateId,
      'scope must expose the fresh state identity despite the display failure',
    );
    assert.equal(second.results, undefined, 'failed display is omitted from the tool output');
    const realView = context.view.bind(context);
    context.view = value => {
      if (value === undefined) throw Error('controlled view failure');
      return realView(value);
    };
    const third = JSON.parse((await apply([change('three.txt', 'three')])).output);
    context.view = realView;
    assert.equal(third.actionStatus, 'completed');
    assert.notEqual(third.stateId, second.stateId);
    assert.equal(third.results, undefined, 'a view failure is isolated the same way');
    const fourth = JSON.parse((await apply([change('four.txt', 'four')])).output);
    assert.equal(fourth.actionStatus, 'completed');
    assert.ok(fourth.results, 'recovered display returns the result view again');
  });
  // Assertions inside the Kernel script surface as a turn error, not a test
  // failure — assert the final status so nothing is swallowed.
  const done = await f.run('display failure isolation');
  assert.equal(done.status, 'completed');
});

test('persistent result view failure still finishes the turn and releases leases', async t => {
  const f = setup(t, async ({ apply, context }) => {
    context.view = () => {
      throw Error('persistent presentation failure');
    };
    const result = JSON.parse((await apply([change('persistent.txt', 'committed')])).output);
    assert.equal(result.actionStatus, 'completed');
    assert.equal(f.entry.scope.stateId, result.stateId);
  });
  const done = await f.run('persistent display failure');
  assert.equal(done.status, 'completed');
  assert.equal(done.results, undefined);
  assert.equal(fs.readFileSync(path.join(f.project.path, 'persistent.txt'), 'utf8'), 'committed');
  assert.equal(f.tasks.sessions.busy(f.entry), false);
  assert.equal(f.entry.release, undefined);
  assert.equal(f.entry.releasePack, undefined);
  assert.equal(
    f.tasks.chats.history(f.entry.id, f.project.path, f.project.domain).turns.at(-1).status,
    'completed',
  );
  await f.tasks.prepare(f.entry, { task: 'next turn' });
});

test('industrial-result consumer failure preserves action output and fresh scope', async t => {
  const f = setup(t, async ({ apply }) => {
    const result = JSON.parse((await apply([change('consumer.txt', 'committed')])).output);
    assert.equal(result.actionStatus, 'completed');
    assert.equal(f.entry.scope.stateId, result.stateId);
  });
  f.tasks.options.onEvent = event => {
    if (event.type === 'industrial-result') throw Error('consumer failed');
  };
  assert.equal((await f.run('consumer failure')).status, 'completed');
  assert.equal(f.tasks.sessions.busy(f.entry), false);
});

test('settlement persistence failure stays observable while turn and leases finish', async t => {
  const f = setup(
    t,
    async ({ context }) => {
      const append = f.tasks.chats.append.bind(f.tasks.chats);
      f.tasks.chats.append = (id, event) => {
        if (event.eventId?.startsWith('results-phase:')) throw Error('result persistence failed');
        return append(id, event);
      };
      assert.equal(context.snapshot().phase, 'running');
    },
    /result persistence failed/,
  );
  await assert.rejects(f.run('storage failure'), /result persistence failed/);
  assert.equal(f.tasks.sessions.busy(f.entry), false);
  assert.equal(f.entry.release, undefined);
  assert.equal(f.entry.releasePack, undefined);
  assert.equal(
    f.tasks.chats.history(f.entry.id, f.project.path, f.project.domain).turns.at(-1).status,
    'completed',
  );
});
