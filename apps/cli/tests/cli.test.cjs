const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { parseArgs } = require('../src/args.cjs');
const { run, loadArtifacts } = require('../src/main.cjs');

test('headless CLI resolves a domain task as JSON Lines without Electron or a model key', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-test-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const environment = { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'config') };
  const rows = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      rows.push(...String(chunk).trim().split('\n').map(JSON.parse));
      callback();
    },
  });
  const options = parseArgs([
    'run',
    '--project-dir',
    projectDir,
    '--domain',
    'pcb',
    '--task',
    'Inspect PCB board routing',
    '--scope-only',
  ]);
  assert.equal(await run(options, output, environment), 0);
  assert.deepEqual(
    rows.map(item => item.type),
    ['scope', 'result'],
  );
  assert.equal(rows[0].scope.domain, 'pcb');
  assert.deepEqual(rows[0].scope.capabilityIds, ['pcb.native.task']);
  assert.equal(rows[1].status, 'scoped');
  assert.ok(!Object.keys(require.cache).some(key => key.includes('/electron/')));
  assert.ok(
    !Object.keys(require.cache).some(
      key => key.includes('/apps/desktop/') || key.includes('/packages/viewer-builtin/'),
    ),
  );
});

test('CLI requires one task source and a known domain', async t => {
  assert.throws(() => parseArgs(['run', '--project-dir', '.', '--domain', 'chip']), /exactly one/);
  assert.throws(
    () =>
      parseArgs([
        'run',
        '--project-dir',
        '.',
        '--domain',
        'chip',
        '--task',
        'a',
        '--task-file',
        'b',
      ]),
    /exactly one/,
  );
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-domain-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  await assert.rejects(
    run(
      { projectDir, domain: 'unknown', task: 'Inspect netlist', scopeOnly: true },
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    ),
    /valid project domain/,
  );
});

test('CLI disable flag removes a repository skill from the resolved scope', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-disabled-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const environment = { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'config') };
  const rows = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      rows.push(...String(chunk).trim().split('\n').map(JSON.parse));
      callback();
    },
  });
  const options = parseArgs([
    'run',
    '--project-dir',
    projectDir,
    '--domain',
    'chip',
    '--task',
    'Inspect netlist signals',
    '--scope-only',
    '--disable-skill',
    'chip.netlist.inspect',
  ]);
  assert.equal(await run(options, output, environment), 0);
  assert.deepEqual(rows[0].scope.skills, []);
  await assert.rejects(
    run({ ...options, disabledSkills: ['unknown'] }, output, environment),
    /Unknown project skill/,
  );
});

test('artifact manifest cannot reference files outside its project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(root, 'outside.vcd'), 'x');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify([{ id: 'outside', kind: 'waveform', path: '../outside.vcd' }]),
  );
  await assert.rejects(loadArtifacts(manifest, projectDir), /inside the project/);
});

test('headless CLI runs a task and emits agent and approval events', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-run-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const rows = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      rows.push(...String(chunk).trim().split('\n').map(JSON.parse));
      callback();
    },
  });
  const approvals = [];
  class FakeSession {
    constructor(_directory, getScope, _artifact, _disclose, emit) {
      assert.equal(getScope().domain, 'chip');
      this.emit = emit;
    }
    async run(task) {
      assert.equal(task, 'Inspect netlist signals');
      this.emit({ type: 'text', text: 'Checking the netlist.' });
      this.emit({ type: 'approval', id: 'a1', description: 'Read file' });
      await new Promise(resolve => setImmediate(resolve));
      this.emit({ type: 'done', result: { status: 'completed' } });
    }
    approve(id, decision) {
      approvals.push({ id, decision });
    }
    async close() {}
  }
  const options = parseArgs([
    'run',
    '--project-dir',
    projectDir,
    '--domain',
    'chip',
    '--task',
    'Inspect netlist signals',
    '--state-dir',
    path.join(projectDir, 'state'),
    '--chat-dir',
    path.join(projectDir, 'chats'),
  ]);
  assert.equal(
    await run(
      options,
      output,
      {
        KIMI_API_KEY: 'test-key',
        INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'config'),
      },
      FakeSession,
    ),
    0,
  );
  assert.deepEqual(
    rows.map(item => item.type),
    [
      'scope',
      'chat',
      'agent_event',
      'agent_event',
      'approval_decision',
      'agent_event',
      'results_changed',
      'results_ready',
      'result',
    ],
  );
  assert.deepEqual(approvals, [{ id: 'a1', decision: 'reject' }]);
  assert.equal(rows.at(-1).status, 'completed');
});

test('headless clarification preserves the question and stops without inventing a user answer', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-question-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const rows = [];
  let interrupted = false;
  class QuestionSession {
    constructor(_directory, _scope, _artifact, _disclose, emit) {
      this.emit = emit;
    }
    async run() {
      this.emit({ type: 'question', id: 'question-1', questions: [{ question: 'Which shape?' }] });
      await new Promise(resolve => {
        this.done = resolve;
      });
      this.emit({ type: 'done', result: { status: 'interrupted' } });
    }
    async interrupt() {
      interrupted = true;
      this.done();
    }
    async answerQuestion() {
      assert.fail('A headless run must not invent a user answer');
    }
    async close() {}
  }
  const chatDir = path.join(projectDir, 'chats');
  const code = await run(
    {
      projectDir,
      domain: 'chip',
      task: 'Inspect netlist signals',
      chatDir,
      stateDir: path.join(projectDir, 'state'),
    },
    { write: line => rows.push(JSON.parse(line)) },
    { KIMI_API_KEY: 'test-key', INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'resources') },
    QuestionSession,
  );
  assert.equal(code, 2);
  assert.equal(interrupted, true);
  assert.equal(rows.at(-1).status, 'needs_input');
  assert.equal(rows.find(r => r.type === 'needs_input').questions[0].question, 'Which shape?');
  const { ChatStore } = require('@industrial-agent-harness/harness-core');
  const chats = new ChatStore(chatDir);
  try {
    assert.equal(
      chats.history(rows.at(-1).chatId, projectDir, 'chip').turns[0].status,
      'needs_input',
    );
  } finally {
    chats.close();
  }
});

test('CLI uses the same persisted global and per-project policy as Desktop', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-policy-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const { ResourceSettings, resourceCatalog } = require('@industrial-agent-harness/harness-core');
  const store = new ResourceSettings(path.join(projectDir, 'config'));
  const catalog = resourceCatalog('chip');
  store.set(catalog, { kind: 'skill', id: 'chip.netlist.inspect', mode: 'disabled' });
  async function scope() {
    const rows = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        rows.push(...String(chunk).trim().split('\n').map(JSON.parse));
        callback();
      },
    });
    await run(
      { projectDir, domain: 'chip', task: 'Inspect netlist signals', scopeOnly: true },
      output,
      { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'config') },
    );
    return rows[0].scope;
  }
  assert.deepEqual((await scope()).skills, []);
  store.set(catalog, { kind: 'skill', id: 'chip.netlist.inspect', mode: 'enabled' }, projectDir);
  assert.deepEqual((await scope()).skills, ['chip.netlist.inspect']);
  store.set(catalog, { kind: 'skill', id: 'chip.netlist.inspect', mode: 'inherit' }, projectDir);
  assert.deepEqual((await scope()).skills, []);
});

test('CLI lists shared project chats without a model key and validates resume ownership', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-chat-list-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const environment = { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(projectDir, 'config') };
  const { ChatStore } = require('@industrial-agent-harness/harness-core');
  const chatDir = path.join(projectDir, 'chats');
  const store = new ChatStore(chatDir);
  const chat = store.create(projectDir, 'chip');
  store.finish(store.beginTurn(chat.id, 'Persisted task'), 'finished');
  store.close();
  const rows = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      rows.push(...String(chunk).trim().split('\n').map(JSON.parse));
      callback();
    },
  });
  const options = parseArgs([
    'chats',
    '--project-dir',
    projectDir,
    '--domain',
    'chip',
    '--chat-dir',
    chatDir,
  ]);
  assert.equal(await run(options, output, environment), 0);
  assert.equal(rows[0].chats[0].id, chat.id);
  assert.equal(rows[0].chats[0].title, 'Persisted task');
  await assert.rejects(
    run(
      { projectDir, domain: 'pcb', task: 'Continue', chatId: chat.id, chatDir },
      output,
      environment,
    ),
    /unavailable/,
  );
});
