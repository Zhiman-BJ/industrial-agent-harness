const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskService } = require('../src/index.cjs');
const { runAgents } = require('../../../apps/cli/src/agents.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-profiles-'));
  const project = { id: 'project', domain: 'chip', path: path.join(root, 'project') };
  fs.mkdirSync(project.path);
  const environment = { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') };
  delete environment.INDUSTRIAL_HARNESS_PACK_STORE;
  const options = {
    environment,
    chatDirectory: path.join(root, 'chats'),
    runtimeOptions: { directory: path.join(root, 'state') },
  };
  const tasks = new TaskService(options);
  t.after(async () => {
    await tasks.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = {
    name: 'Reviewer',
    description: 'Review with evidence',
    domain: 'chip',
    instructions: 'ORIGINAL ROLE',
    tools: ['Read', 'Grep'],
    skills: [],
    subagents: [],
  };
  return { tasks, project, root, options, input, environment };
}

test('project defaults and draft selection freeze a complete role snapshot at the first prepared turn', async t => {
  const { tasks, project, input } = fixture(t);
  const role = tasks.saveAgent(input);
  tasks.setProjectAgent(project, role.id);
  const chat = tasks.newChat(project);
  assert.equal(chat.agent.id, role.id);
  assert.equal(chat.agentLocked, false);
  tasks.setChatAgent(project, chat.id, 'builtin:default');
  tasks.setChatAgent(project, chat.id, role.id);
  const entry = tasks.resume(project, chat.id);
  const before = structuredClone(entry.agentSnapshot);
  const prepared = await tasks.prepare(entry, { task: 'Inspect RTL verification sources' });
  assert.deepEqual(prepared.scope.skills, []);
  assert.ok(tasks.chats.get(chat.id, project.path, project.domain).agentLocked);
  assert.throws(() => tasks.setChatAgent(project, chat.id, 'builtin:default'), /fixed/);
  tasks.saveAgent({ ...input, id: role.id, instructions: 'CHANGED ROLE' });
  tasks.agents.remove(role.id);
  assert.deepEqual(tasks.resume(project, chat.id).agentSnapshot, before);
  assert.equal(tasks.agentCatalog(project).defaultAgentId, 'builtin:default');
  assert.equal(tasks.newChat(project).agent.id, 'builtin:default');
});

test('saved role dependencies are snapshotted and domain boundaries, cycles and unknown tools reject before saving', t => {
  const { tasks, project, input } = fixture(t);
  const child = tasks.saveAgent({ ...input, name: 'Specialist' });
  const parent = tasks.saveAgent({
    ...input,
    name: 'Coordinator',
    subagents: [child.id, 'builtin:explore'],
  });
  const chat = tasks.newChat(project, { agentId: parent.id });
  const snapshot = tasks.chats.agentSnapshot(chat.id);
  assert.equal(snapshot.profiles.length, 3);
  tasks.saveAgent({ ...input, id: child.id, instructions: 'UPDATED CHILD' });
  assert.equal(snapshot.profiles.find(role => role.id === child.id).instructions, 'ORIGINAL ROLE');
  assert.throws(() => tasks.saveAgent({ ...input, id: child.id, subagents: [parent.id] }), /cycle/);
  assert.throws(() => tasks.saveAgent({ ...input, tools: ['ToolTypo'] }), /Unsupported/);
  assert.throws(
    () => tasks.saveAgent({ ...input, domain: '*', subagents: [child.id] }),
    /unavailable/,
  );
  assert.throws(() => tasks.saveAgent({ ...input, skills: ['missing.skill'] }), /unavailable/);
  assert.throws(() => tasks.agents.remove(child.id), /other Agents/);
  assert.throws(() => tasks.saveAgent({ ...input, id: 'chip.engineer' }), /Only custom/);
});

test('legacy chats keep the default role and persisted snapshots survive reopening the application', async t => {
  const { tasks, project, input, options } = fixture(t);
  const old = tasks.chats.create(project.path, project.domain);
  tasks.chats.beginTurn(old.id, 'historical turn', null, false);
  const role = tasks.saveAgent(input);
  tasks.setProjectAgent(project, role.id);
  assert.equal(tasks.resume(project, old.id).agentSnapshot.id, 'builtin:default');
  const chat = tasks.newChat(project);
  const snapshot = tasks.chats.agentSnapshot(chat.id);
  await tasks.close();
  const reopened = new TaskService(options);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.resume(project, chat.id).agentSnapshot, snapshot);
  assert.equal(reopened.resume(project, old.id).agentSnapshot.id, 'builtin:default');
});

test('selection checks the project and execution lock, and invalid new-chat selection leaves no draft behind', t => {
  const { tasks, project, input, root } = fixture(t);
  const role = tasks.saveAgent(input);
  const chat = tasks.newChat(project);
  const release = tasks.chats.acquire(chat.id);
  assert.throws(() => tasks.setChatAgent(project, chat.id, role.id), /fixed/);
  release();
  const other = { ...project, id: 'other', path: path.join(root, 'other') };
  fs.mkdirSync(other.path);
  assert.throws(() => tasks.setChatAgent(other, chat.id, role.id), /unavailable/);
  assert.throws(() => tasks.chatAgent(other, chat.id), /unavailable/);
  const count = tasks.chats.list(project.path, project.domain).length;
  assert.throws(() => tasks.newChat(project, { agentId: 'missing', draft: false }), /unavailable/);
  assert.equal(tasks.chats.list(project.path, project.domain).length, count);
});

test('CLI configuration and desktop task service consume the same saved role and project default', async t => {
  const { tasks, project, input, root, environment } = fixture(t);
  const file = path.join(root, 'agent.json');
  fs.writeFileSync(file, JSON.stringify(input));
  const rows = [],
    output = { write: text => rows.push(JSON.parse(text)) };
  assert.equal(await runAgents(['save', '--file', file], output, environment), 0);
  const id = rows[0].agent.id;
  await runAgents(
    ['default', '--project-dir', project.path, '--domain', project.domain, '--id', id],
    output,
    environment,
  );
  assert.equal(tasks.newChat(project).agent.id, id);
  assert.equal(
    tasks.agentCatalog(project).agents.find(agent => agent.id === id).instructions,
    input.instructions,
  );
});
