const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hash } = require('@industrial-agent-harness/domain-runtime');
const { planningGateway } = require('./helpers/planning-gateway.cjs');
const { createProjectRuntime } = require('../src/project-runtime.cjs');
const PLAN = 'project.remote.plan',
  PREPARE = 'project.remote.prepare';

async function invoke(
  f,
  toolId,
  inputs = {},
  { taskId = f.taskId, approval = true, runtime = f.runtime } = {},
) {
  const state = await runtime.inspect();
  return runtime.execute(
    { toolId, inputs, expectedStateId: state.id },
    {
      taskId,
      approval,
      scope: { projectId: state.projectId, domain: 'test', stateId: state.id, tools: [toolId] },
    },
  );
}
function contents(f, result) {
  return JSON.parse(f.runtime.readArtifact(result.artifacts[0].id).content.toString());
}
async function plan(f, inputs = {}) {
  const result = await invoke(f, PLAN, {
    files: ['input.txt'],
    tools: ['test.run', 'test.inspect'],
    ...inputs,
  });
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  return contents(f, result);
}
async function prepare(f, inputs = {}) {
  const proposed = await plan(f, inputs);
  const result = await invoke(f, PREPARE, { reviewId: proposed.reviewId });
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  return { proposed, result, ready: contents(f, result) };
}

test('remote selection opens local planning without configuration, upload or sandbox acquisition', async t => {
  const f = planningGateway(t, { configured: false });
  const state = await f.runtime.inspect();
  assert.equal(state.inputHashes['input.txt'], hash('task input'));
  assert.equal(f.requests.length, 0);
  assert.ok(f.runtime.descriptors().some(tool => tool.id === PLAN));
  assert.equal(
    f.runtime.descriptors().some(tool => tool.id === 'project.task.run'),
    false,
  );
  const read = await invoke(f, 'project.files.read', { path: 'input.txt' });
  assert.equal(read.action.status, 'completed', read.action.diagnostics.join('\n'));
  assert.equal(f.requests.length, 0);
});

test('the task plan reviews all inputs and named tools without any upload', async t => {
  const f = planningGateway(t);
  const proposed = await plan(f);
  assert.equal(proposed.status, 'awaiting_batch_approval');
  assert.equal(proposed.destination, 'https://planning.example');
  assert.deepEqual(
    proposed.files.map(file => file.path),
    ['input.txt'],
  );
  assert.equal(proposed.files[0].sha256, hash('task input'));
  assert.deepEqual(proposed.tools, ['test.inspect', 'test.run']);
  assert.equal(proposed.remember, true);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.sessions.size, 0);
  assert.equal(
    f.requests.some(request => request.method === 'POST'),
    false,
  );
  const state = await f.runtime.inspect();
  const preview = f.runtime.approvalPreview(
    { toolId: PREPARE, inputs: { reviewId: proposed.reviewId }, expectedStateId: state.id },
    { taskId: f.taskId },
  );
  assert.match(preview.text, /input\.txt/);
  assert.match(preview.text, /test\.inspect, test\.run/);
  assert.equal(f.runtime.requiresExplicitApproval({ toolId: PREPARE }), true);
  assert.equal(f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }), false);
});

test('one batch preparation activates protected tools in the same canonical workspace', async t => {
  const f = planningGateway(t);
  const workspace = f.runtime.diagnosticsRuntime;
  const project = f.runtime.project;
  const { result, ready } = await prepare(f);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.verification, 'not_run');
  assert.equal(result.verification.status, 'not_run');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.runtime.diagnosticsRuntime, workspace);
  assert.deepEqual(f.runtime.project, project);
  assert.deepEqual(workspace.get('action', result.action.id), result.action);
  assert.equal(f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }), true);
  const remoteCapability = f.bundle.capabilities.find(
    capability => capability.id === 'remote.software',
  );
  assert.deepEqual(
    remoteCapability.tools.map(tool => tool.id),
    ['test.run', 'test.inspect'],
  );
  for (const toolId of ['test.run', 'test.inspect', 'test.run']) {
    const call = await invoke(f, toolId);
    assert.equal(call.action.status, 'completed', call.action.diagnostics.join('\n'));
    assert.equal(call.verification.status, 'passed');
  }
  assert.equal(f.invocations.length, 3);
  assert.equal(f.uploads.length, 1);
});

test('preparation denied by the user does not create a project, upload or acquire a sandbox', async t => {
  const f = planningGateway(t);
  const proposed = await plan(f);
  const requests = f.requests.length;
  const result = await invoke(f, PREPARE, { reviewId: proposed.reviewId }, { approval: false });
  assert.equal(result.action.status, 'failed');
  assert.equal(f.requests.length, requests);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }), false);
});

test('a changed file invalidates the combined approval before any upload', async t => {
  const f = planningGateway(t);
  const proposed = await plan(f);
  fs.writeFileSync(path.join(f.projectDir, 'input.txt'), 'changed since the reviewed plan');
  const result = await invoke(f, PREPARE, { reviewId: proposed.reviewId });
  assert.equal(result.action.status, 'failed');
  assert.match(result.action.diagnostics.join('\n'), /changed/i);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.sessions.size, 0);
});

test('plans cannot be approved by a different task or another chat', async t => {
  const f = planningGateway(t);
  const proposed = await plan(f);
  const anotherTask = await invoke(
    f,
    PREPARE,
    { reviewId: proposed.reviewId },
    { taskId: randomUUID() },
  );
  assert.equal(anotherTask.action.status, 'failed');
  const runtime = f.bundle.runtime.forSession(randomUUID());
  const anotherChat = await invoke(f, PREPARE, { reviewId: proposed.reviewId }, { runtime });
  assert.equal(anotherChat.action.status, 'failed');
  assert.equal(f.uploads.length, 0);
  assert.equal(f.sessions.size, 0);
});

test('adding a path and tool needs a new combined plan and replaces the old grant', async t => {
  const f = planningGateway(t);
  await prepare(f, { tools: ['test.run'] });
  fs.writeFileSync(path.join(f.projectDir, 'dependency.txt'), 'task dependency');
  assert.equal(
    f.runtime.hasStandingApproval({ toolId: 'test.extra' }, { taskId: f.taskId }),
    false,
  );
  const proposed = await plan(f, {
    files: ['input.txt', 'dependency.txt'],
    tools: ['test.run', 'test.extra'],
  });
  assert.equal(f.uploads.length, 1);
  const prepared = await invoke(f, PREPARE, { reviewId: proposed.reviewId });
  assert.equal(prepared.action.status, 'completed', prepared.action.diagnostics.join('\n'));
  assert.equal(f.uploads.length, 2);
  assert.deepEqual(
    f.uploads[1].manifest.files.map(file => file.path),
    ['dependency.txt', 'input.txt'],
  );
  assert.equal(f.runtime.hasStandingApproval({ toolId: 'test.extra' }, { taskId: f.taskId }), true);
  const result = await invoke(f, 'test.extra');
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
});

for (const boundary of ['task', 'chat', 'tool'])
  test(`a batch grant cannot cross the approved ${boundary} boundary`, async t => {
    const f = planningGateway(t);
    await prepare(f);
    const runtime = boundary === 'chat' ? f.bundle.runtime.forSession(randomUUID()) : f.runtime;
    const taskId = boundary === 'task' ? randomUUID() : f.taskId;
    const toolId = boundary === 'tool' ? 'test.extra' : 'test.run';
    assert.equal(runtime.hasStandingApproval({ toolId }, { taskId }), false);
    fs.writeFileSync(
      path.join(f.projectDir, 'input.txt'),
      'must not auto-upload for invalid grant',
    );
    const result = await invoke(f, toolId, {}, { runtime, taskId });
    assert.equal(result.action.status, 'failed');
    assert.equal(f.uploads.length, 1);
    assert.equal(f.invocations.length, 0);
  });

test('remembered inputs refresh before execution and keep later local files out of uploads', async t => {
  const f = planningGateway(t);
  await prepare(f);
  const firstSnapshot = f.settings.project(f.projectDir, 'test').snapshotId;
  fs.writeFileSync(path.join(f.projectDir, 'input.txt'), 'updated input for remote task');
  fs.writeFileSync(path.join(f.projectDir, 'private-notes.txt'), 'not selected');
  const result = await invoke(f, 'test.run');
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[1].baseSnapshotId, firstSnapshot);
  assert.deepEqual(
    f.uploads[1].manifest.files.map(file => file.path),
    ['input.txt'],
  );
  assert.equal(f.uploads[1].manifest.files[0].sha256, hash('updated input for remote task'));
  assert.notEqual(f.invocations[0].snapshotId, firstSnapshot);
  assert.equal(f.invocations[0].snapshotId, f.settings.project(f.projectDir, 'test').snapshotId);
});

test('one-time input approval does not upload modified contents automatically', async t => {
  const f = planningGateway(t);
  await prepare(f, { remember: false });
  fs.writeFileSync(path.join(f.projectDir, 'input.txt'), 'changed bytes need another review');
  const result = await invoke(f, 'test.run');
  assert.equal(result.action.status, 'failed');
  assert.match(result.action.diagnostics.join('\n'), /approve/i);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.invocations.length, 0);
  assert.equal(
    (await f.runtime.inspect()).inputHashes['input.txt'],
    hash('changed bytes need another review'),
  );
});

for (const failure of ['failInventory', 'unprotected', 'changedCapabilities'])
  test(`remote readiness requires the real protected MCP: ${failure}`, async t => {
    const f = planningGateway(t);
    const proposed = await plan(f);
    if (failure === 'failInventory') f.controls.failInventory = true;
    if (failure === 'unprotected') f.controls.protected = false;
    if (failure === 'changedCapabilities') f.controls.capabilityHash = 'c'.repeat(64);
    const result = await invoke(f, PREPARE, { reviewId: proposed.reviewId });
    assert.equal(result.action.status, 'failed');
    assert.notEqual(result.verification.status, 'passed');
    assert.equal(result.artifacts.length, 0);
    assert.equal(
      f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }),
      false,
    );
    assert.equal(f.invocations.length, 0);
    const read = await invoke(f, 'project.files.read', { path: 'input.txt' });
    assert.equal(read.action.status, 'completed', read.action.diagnostics.join('\n'));
    assert.equal((await f.runtime.inspect()).inputHashes['input.txt'], hash('task input'));
  });

test('changed live capability identity blocks a previously approved remote tool', async t => {
  const f = planningGateway(t);
  await prepare(f);
  f.controls.capabilityHash = 'c'.repeat(64);
  const result = await invoke(f, 'test.run');
  assert.equal(result.action.status, 'failed');
  assert.match(result.action.diagnostics.join('\n'), /capability inventory changed/i);
  assert.equal(f.invocations.length, 0);
});

test('unknown remote execution preserves recovery evidence and local conversation remains usable', async t => {
  const f = planningGateway(t);
  await prepare(f);
  f.controls.failTool = true;
  const result = await invoke(f, 'test.run');
  assert.equal(result.action.status, 'failed');
  assert.equal(f.invocations.length, 1);
  assert.equal(f.runtime.status().status, 'unknown');
  const read = await invoke(f, 'project.files.read', { path: 'input.txt' });
  assert.equal(read.action.status, 'completed', read.action.diagnostics.join('\n'));
  const replay = await invoke(f, 'test.run');
  assert.equal(replay.action.status, 'failed');
  assert.equal(f.invocations.length, 1);
});

test('releaseOwner revokes task grants while retaining the canonical workspace for reconnect', async t => {
  const f = planningGateway(t);
  await prepare(f);
  const workspace = f.runtime.diagnosticsRuntime;
  await f.runtime.releaseOwner();
  const restored = f.bundle.runtime.forSession(f.chatId);
  assert.equal(restored.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }), false);
  assert.equal(restored.diagnosticsRuntime, workspace);
  assert.ok((await restored.inspect()).id);
});

test('default preparation selects available live tools from the catalog without blocking on other profiles', async t => {
  const f = planningGateway(t);
  f.controls.liveTools = ['test.run'];
  const { ready } = await prepare(f, { tools: undefined });
  assert.deepEqual(ready.tools, ['test.run']);
  assert.deepEqual([...ready.unavailableTools].sort(), ['test.extra', 'test.inspect']);
  assert.equal(f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }), true);
  assert.equal(
    f.runtime.hasStandingApproval({ toolId: 'test.inspect' }, { taskId: f.taskId }),
    false,
  );
  const result = await invoke(f, 'test.run');
  assert.equal(result.verification.status, 'passed');
});

test('an explicitly requested tool unavailable in the live profile cannot receive a batch grant', async t => {
  const f = planningGateway(t);
  f.controls.liveTools = ['test.run'];
  const proposed = await plan(f, { tools: ['test.inspect'] });
  const result = await invoke(f, PREPARE, { reviewId: proposed.reviewId });
  assert.equal(result.action.status, 'failed');
  assert.equal(
    f.runtime.hasStandingApproval({ toolId: 'test.inspect' }, { taskId: f.taskId }),
    false,
  );
  assert.equal(f.invocations.length, 0);
});

test('a separate manual upload cannot replace bytes under a one-time task grant', async t => {
  const f = planningGateway(t);
  await prepare(f, { remember: false });
  fs.writeFileSync(path.join(f.projectDir, 'input.txt'), 'manually uploaded new contents');
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt']);
  await f.settings.sync(f.projectDir, 'test', review.id);
  assert.equal(f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }), false);
  const result = await invoke(f, 'test.run');
  assert.equal(result.action.status, 'failed');
  assert.equal(f.invocations.length, 0);
});

test('closing another chat does not interrupt the active owner and active owner close is refused', async t => {
  const f = planningGateway(t);
  await prepare(f);
  let entered, release;
  const started = new Promise(resolve => (entered = resolve));
  const resume = new Promise(resolve => (release = resolve));
  f.controls.beforeInvoke = async () => {
    entered();
    await resume;
  };
  const pending = invoke(f, 'test.run');
  await started;
  const other = f.bundle.runtime.forSession(randomUUID());
  await other.close();
  await assert.rejects(f.runtime.close(), /running/);
  release();
  const result = await pending;
  assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
  assert.equal(result.verification.status, 'passed');
  assert.equal(f.invocations.length, 1);
  assert.ok((await f.runtime.inspect()).id);
});

for (const file of [
  '.harness-runs/input.txt',
  'nested/.harness-runs/input.txt',
  'remote-results/input.txt',
  'runtime/input.txt',
])
  test(`managed input ${file} cannot enter a remote upload plan`, async t => {
    const f = planningGateway(t, { runtimeInsideProject: true });
    const absolute = path.join(f.projectDir, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'runtime-owned bytes');
    const result = await invoke(f, PLAN, { files: [file], tools: ['test.run'] });
    assert.equal(result.action.status, 'failed');
    assert.equal(result.artifacts.length, 0);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.sessions.size, 0);
    assert.equal(
      f.runtime.hasStandingApproval({ toolId: 'test.run' }, { taskId: f.taskId }),
      false,
    );
  });

test('closing a planner releases its canonical store before asynchronous transport cleanup', async t => {
  const f = planningGateway(t);
  const { result } = await prepare(f);
  const project = f.runtime.project;
  const oldStore = f.runtime.diagnosticsRuntime;
  const closing = f.bundle.runtime.close();
  const replacement = createProjectRuntime(f.runtimeOptions);
  try {
    assert.equal(f.bundle.runtime.closed, true);
    assert.equal(oldStore.db, null);
    assert.notEqual(replacement.runtime.diagnosticsRuntime, oldStore);
    assert.deepEqual(replacement.runtime.project, project);
    assert.equal(replacement.runtime.domain, 'test');
    replacement.runtime.assertProjectBound();
    assert.deepEqual(replacement.runtime.get('action', result.action.id), result.action);
    assert.ok((await replacement.runtime.inspect()).id);
    await closing;
  } finally {
    await replacement.runtime.close();
  }
});

test('approval preview remains complete and a scope exceeding its display budget is rejected', async t => {
  const f = planningGateway(t);
  const files = [];
  for (let i = 0; i < 180; i++) {
    const file = `${String(i).padStart(3, '0')}-${'x'.repeat(180)}.txt`;
    fs.writeFileSync(path.join(f.projectDir, file), 'input');
    files.push(file);
  }
  const result = await invoke(f, PLAN, { files, tools: ['test.run'] });
  assert.equal(result.action.status, 'failed');
  assert.match(result.action.diagnostics.join('\n'), /display limit/i);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.sessions.size, 0);
});
