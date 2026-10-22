const test = require('node:test');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { KimiSession } = require('../../packages/agent-kimi/src/index.cjs');
const { SessionResourceManager, ChatStore } = require('../../packages/harness-core/src/index.cjs');
const {
  validateProfile,
  writeCliConfig,
  sessionEnv,
} = require('../../packages/agent-kimi/src/model-config.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline) await pause(10);
  assert.ok(predicate(), 'Expected native background event did not arrive');
}
const notification = body =>
  JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content).includes(
    'background_task',
  );
const tool = (name, args) => ({ name, arguments: args });
async function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-background-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const model = await startModel({ perPrompt: true, ...options });
  const resources = new SessionResourceManager({
    directory: path.join(directory, 'resources'),
    limits: { maxConcurrent: 1, maxResident: 1, idleMs: 30, minFreeMemoryBytes: 0 },
    sweepIntervalMs: 10,
  });
  const chats = new ChatStore(path.join(directory, 'chats'));
  const chat = chats.create(project, 'godot');
  let session;
  t.after(async () => {
    await session?.close();
    await resources.close();
    chats.close();
    model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const profile = validateProfile({
    provider: 'openai_legacy',
    endpoint: model.endpoint,
    model: 'background-fixture',
    contextSize: 32768,
    thinking: false,
  });
  const runtime = {
    profile,
    apiKey: 'local-background-key',
    revision: 0,
    shareDir: writeCliConfig(directory, profile),
    env: sessionEnv(profile, 'local-background-key'),
  };
  const events = [],
    failures = [];
  session = new KimiSession(
    project,
    () => ({ domain: 'godot', capabilityIds: [], skills: [], tools: [] }),
    () => null,
    () => null,
    event => {
      events.push(event);
      if (event.type === 'approval')
        queueMicrotask(() =>
          session.approve(event.id, 'approve').catch(error => failures.push(error)),
        );
      if (event.type === 'question' && options.answerQuestions !== false)
        queueMicrotask(() =>
          session
            .answerQuestion(event.id, { 'Continue after completion?': 'Continue' })
            .catch(error => failures.push(error)),
        );
    },
    () => runtime,
    undefined,
    {
      resources,
      directory: path.join(directory, 'logs'),
      resolveSession: key => chats.runtimeSession(chat.id, key),
      sessionInitialized: id => chats.initialized(id),
    },
  );
  return { directory, project, model, resources, session, events, failures };
}

for (const delay of [0, 1])
  test(
    `native background Bash (${delay}s) retains resources through completion, follow-up approval and question`,
    { timeout: 25000 },
    async t => {
      const f = await fixture(t, {
        calls: body =>
          notification(body)
            ? [
                tool('Bash', {
                  command: 'echo FOLLOWUP_TOOL_OK',
                  description: 'Follow-up approval',
                }),
                tool('AskUserQuestion', {
                  questions: [
                    {
                      question: 'Continue after completion?',
                      header: 'Continue',
                      options: [{ label: 'Continue' }, { label: 'Stop' }],
                    },
                  ],
                }),
              ]
            : [
                tool('Bash', {
                  command: `sleep ${delay}; echo BACKGROUND_OUTPUT_OK`,
                  description: 'Background command',
                  run_in_background: true,
                }),
              ],
        success: body => (notification(body) ? 'BACKGROUND_FOLLOWUP_OK' : 'STARTED_OK'),
      });
      await f.session.run('Run the background command and report its completion.');
      if (delay) {
        assert.equal(f.session.backgroundTasks, true);
        assert.equal(f.resources.snapshot().active, 1);
        await pause(100);
        assert.equal(f.resources.snapshot().resident, 1, 'idle sweep cannot kill background work');
        await assert.rejects(f.session.run('Another prompt'), /already running/);
      }
      await f.session.waitForBackgroundIdle();
      assert.equal(f.failures.length, 0, String(f.failures));
      assert.ok(f.events.some(e => e.type === 'text' && e.text === 'BACKGROUND_FOLLOWUP_OK'));
      assert.ok(f.events.some(e => e.type === 'question-resolved' && e.decision === 'answered'));
      assert.equal(f.events.filter(e => e.type === 'approval').length, 2);
      assert.equal(
        f.model.requests.filter(notification).length,
        3,
        'Kimi alone starts one automatic follow-up',
      );
      const firstBusy = f.events.findIndex(e => e.type === 'background-state' && e.running);
      const lastText = f.events.findIndex(
        e => e.type === 'text' && e.text === 'BACKGROUND_FOLLOWUP_OK',
      );
      assert.ok(firstBusy >= 0);
      assert.ok(
        !f.events.slice(firstBusy, lastText).some(e => e.type === 'background-state' && !e.running),
        'no premature idle gap',
      );
      assert.equal(f.resources.snapshot().active, 0);
      const log = f.events.find(e => e.type === 'diagnostic-log').path;
      assert.match(fs.readFileSync(log, 'utf8'), /BACKGROUND_FOLLOWUP_OK/);
      assert.match(fs.readFileSync(log, 'utf8'), /BackgroundTaskState/);
    },
  );

test(
  'a real event connection failure after the foreground turn fails visibly and frees background leases',
  { timeout: 25000 },
  async t => {
    const f = await fixture(t, {
      calls: body =>
        notification(body)
          ? []
          : [
              tool('Bash', {
                command: 'sleep 30; echo LOST_OUTPUT',
                description: 'Transport failure task',
                run_in_background: true,
              }),
            ],
      success: 'STARTED_OK',
    });
    await f.session.run('Start background work, then lose the event connection.');
    const idle = f.session.waitForBackgroundIdle();
    f.session.session.socket.close();
    await idle;
    assert.ok(f.events.some(e => e.type === 'error' && /connection closed/.test(e.message)));
    assert.equal(f.session.session, undefined);
    assert.equal(f.resources.snapshot().active, 0);
    assert.equal(f.model.requests.filter(notification).length, 0, 'failed work is never replayed');
  },
);

for (const scenario of ['question', 'timeout'])
  test(
    `shared application background ${scenario} settles with the expected exit status`,
    { timeout: 25000 },
    async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'application-background-'));
      const project = path.join(directory, 'project');
      fs.mkdirSync(project);
      const model = await startModel({
        perPrompt: true,
        calls: body =>
          notification(body)
            ? [
                tool('AskUserQuestion', {
                  questions: [
                    {
                      question: 'Continue after completion?',
                      header: 'Continue',
                      options: [{ label: 'Continue' }, { label: 'Stop' }],
                    },
                  ],
                }),
              ]
            : [
                tool('Bash', {
                  command: `sleep ${scenario === 'timeout' ? 30 : 1}; echo APPLICATION_OUTPUT`,
                  description: 'Application background task',
                  run_in_background: true,
                }),
              ],
        success: 'APPLICATION_STARTED',
      });
      t.after(() => {
        model.close();
        fs.rmSync(directory, { recursive: true, force: true });
      });
      let stdout, exitCode;
      try {
        await promisify(execFile)(
          process.execPath,
          taskArguments({
            projectDir: project,
            domain: 'godot',
            task: 'Run the background task.',
            provider: 'openai_legacy',
            endpoint: model.endpoint,
            model: 'controlled',
            thinking: false,
            approval: 'approve',
            chatDir: path.join(directory, 'chats'),
            stateDir: path.join(directory, 'state'),
            logDir: path.join(directory, 'logs'),
            ...(scenario === 'timeout' ? { timeoutMs: 4000 } : {}),
          }),
          {
            timeout: 20000,
            env: {
              ...process.env,
              OPENAI_API_KEY: 'local-application-background',
              INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'settings'),
            },
          },
        );
        assert.fail('Expected a nonzero fixture status');
      } catch (error) {
        stdout = error.stdout;
        exitCode = error.code;
      }
      assert.equal(exitCode, scenario === 'question' ? 2 : 124);
      const rows = stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).status, scenario === 'question' ? 'needs_input' : 'timeout');
      assert.ok(
        rows.some(row => row.event?.text === 'APPLICATION_STARTED'),
        'initial turn finished before interruption',
      );
      if (scenario === 'question') assert.ok(rows.some(row => row.type === 'needs_input'));
      assert.ok(
        !rows.some(row => row.event?.type === 'error'),
        'explicit Headless interruption is not a native failure',
      );
    },
  );

for (const waits of [true, false])
  test(
    `native background child ${waits ? 'WaitFor' : 'notification'} completion stays observable without mixing child text into the parent`,
    { timeout: 25000 },
    async t => {
      const child = body =>
        body.messages.some(
          m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_WAIT_JOB'),
        );
      let taskId;
      const f = await fixture(t, {
        calls: body => {
          if (child(body)) {
            if (notification(body)) return [];
            taskId ||= /task_id: (\S+)/
              .exec(JSON.stringify(body.messages.find(m => m.role === 'tool')?.content))?.[1]
              ?.replace(/\\n.*/, '');
            return [
              tool('Bash', {
                command: 'sleep 1; echo CHILD_WAIT_OUTPUT',
                description: 'Child-owned background command',
                run_in_background: true,
              }),
              ...(waits ? [tool('WaitFor', { task_id: taskId || 'unknown', timeout: 10 })] : []),
            ];
          }
          return notification(body)
            ? []
            : [
                tool('Agent', {
                  prompt: 'CHILD_WAIT_JOB: run a background command and wait for its result.',
                  description: 'Child waits for work',
                  subagent_type: 'coder',
                  run_in_background: true,
                }),
              ];
        },
        success: body =>
          child(body)
            ? 'CHILD_PRIVATE_ANSWER'
            : notification(body)
              ? 'PARENT_CHILD_COMPLETE'
              : 'PARENT_CHILD_STARTED',
      });
      await f.session.run('Run the background child and report when it completes.');
      await f.session.waitForBackgroundIdle();
      assert.ok(f.events.some(e => e.text === 'PARENT_CHILD_COMPLETE'));
      assert.ok(!f.events.some(e => e.type === 'text' && /CHILD_PRIVATE_ANSWER/.test(e.text)));
      assert.ok(
        [...f.session.nativeTasks.values()].some(
          task =>
            task.agentId !== 'main' &&
            task.kind === 'process' &&
            task.status === 'completed' &&
            task.notified,
        ),
      );
      assert.ok(f.model.requests.find(child).tools.some(tool => tool.function.name === 'WaitFor'));
      assert.equal(f.failures.length, 0, String(f.failures));
      assert.equal(f.resources.snapshot().active, 0);
    },
  );

test(
  'native TaskStop suppresses completion notification and releases without waiting for one',
  { timeout: 25000 },
  async t => {
    let taskId;
    const f = await fixture(t, {
      calls: body => {
        taskId ||= /task_id: (\S+)/
          .exec(JSON.stringify(body.messages.find(m => m.role === 'tool')?.content))?.[1]
          ?.replace(/\\n.*/, '');
        return [
          tool('Bash', {
            command: 'sleep 30; echo NEVER_FINISH',
            description: 'Stopped native task',
            run_in_background: true,
          }),
          tool('TaskStop', { task_id: taskId || 'unknown' }),
        ];
      },
      success: 'TASK_STOPPED',
    });
    await f.session.run('Stop the background task using its native tool.');
    await f.session.waitForBackgroundIdle();
    assert.ok(f.events.some(e => e.text === 'TASK_STOPPED'));
    assert.equal([...f.session.nativeTasks.values()][0].status, 'killed');
    assert.equal(f.resources.snapshot().active, 0);
    assert.equal(f.model.requests.length, 3);
  },
);

test(
  'native failed background command delivers its exit code and settles without replay',
  { timeout: 25000 },
  async t => {
    const f = await fixture(t, {
      calls: body =>
        notification(body)
          ? []
          : [
              tool('Bash', {
                command: 'sleep 1; echo FAILED_OUTPUT; exit 7',
                description: 'Failing background command',
                run_in_background: true,
              }),
            ],
      success: body => (notification(body) ? 'FAILURE_HANDLED' : 'STARTED_OK'),
    });
    await f.session.run('Observe a failing background command.');
    await f.session.waitForBackgroundIdle();
    assert.ok(f.events.some(e => e.text === 'FAILURE_HANDLED'));
    const states = [...f.session.nativeTasks.values()];
    assert.equal(states.length, 1, 'canonical and legacy task events are deduplicated');
    assert.equal(states[0].status, 'failed');
    assert.equal(states[0].exitCode, 7);
    assert.equal(states[0].notificationPending, false);
    assert.equal(f.model.requests.filter(notification).length, 1);
    assert.equal(f.resources.snapshot().active, 0);
  },
);

test(
  'Stop kills owned native background work and resolves idle waiters',
  { timeout: 25000 },
  async t => {
    const f = await fixture(t, {
      calls: body =>
        notification(body)
          ? []
          : [
              tool('Bash', {
                command: 'sleep 30; echo SHOULD_NOT_COMPLETE',
                description: 'Cancelled background command',
                run_in_background: true,
              }),
            ],
      success: 'STARTED_OK',
    });
    await f.session.run('Start cancellable background work.');
    const idle = f.session.waitForBackgroundIdle();
    const processIds = [...f.session.session.tasks.values()].map(item => item.taskId);
    assert.equal(processIds.length, 1);
    const child = f.session.session.child;
    await f.session.interrupt();
    assert.equal((await idle).status, 'cancelled');
    assert.equal(f.session.session, undefined);
    assert.equal(f.resources.snapshot().active, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(f.model.requests.filter(notification).length, 0);
    assert.ok(!f.events.some(e => e.type === 'error'), 'explicit Stop is not a transport failure');
  },
);

test(
  'Stop during a native background question expires controls and resumes without stale tool events',
  { timeout: 25000 },
  async t => {
    let resumed = false;
    const f = await fixture(t, {
      answerQuestions: false,
      calls: body =>
        resumed
          ? []
          : notification(body)
            ? [
                tool('AskUserQuestion', {
                  questions: [
                    {
                      question: 'Continue after completion?',
                      header: 'Continue',
                      options: [{ label: 'Continue' }, { label: 'Stop' }],
                    },
                  ],
                }),
              ]
            : [
                tool('Bash', {
                  command: 'sleep 1; echo QUESTION_BACKGROUND_OUTPUT',
                  description: 'Question continuation task',
                  run_in_background: true,
                }),
              ],
      success: () => (resumed ? 'RESUMED_AFTER_STOP' : 'STARTED_OK'),
    });
    await f.session.run('Run background work and ask when it completes.');
    await until(() => f.events.some(e => e.type === 'question'));
    assert.ok(f.session.pendingToolArgs.size > 0, 'question has an unfinished native tool call');
    await f.session.interrupt();
    assert.equal(f.session.pendingQuestions.size, 0);
    assert.equal(f.session.pendingToolArgs.size, 0);
    resumed = true;
    const start = f.events.length;
    await f.session.run('Continue after Stop.');
    await f.session.waitForBackgroundIdle();
    assert.ok(f.events.slice(start).some(e => e.text === 'RESUMED_AFTER_STOP'));
    assert.ok(
      !f.events.slice(start).some(e => e.type === 'tool'),
      'old background tools cannot leak into the next turn',
    );
    assert.ok(!f.events.slice(start).some(e => e.type === 'error'));
  },
);

test(
  'native WaitFor timeout and TaskOutput stay nonblocking; waiting makes no extra model requests',
  { timeout: 25000 },
  async t => {
    let taskId, waitingRequests;
    const f = await fixture(t, {
      calls: body => {
        const results = body.messages.filter(m => m.role === 'tool');
        taskId ||= /task_id: (\S+)/
          .exec(JSON.stringify(results[0]?.content))?.[1]
          ?.replace(/\\n.*/, '');
        return notification(body)
          ? []
          : [
              tool('Bash', {
                command: 'sleep 3; echo WAITED_OUTPUT_OK',
                description: 'Waiting command',
                run_in_background: true,
              }),
              tool('TaskOutput', { task_id: taskId || 'unknown' }),
              tool('WaitFor', { task_id: taskId || 'unknown', timeout: 1 }),
              tool('WaitFor', { task_id: taskId || 'unknown', timeout: 10 }),
            ];
      },
      success: 'WAIT_COMPLETE',
    });
    const running = f.session.run('Use TaskOutput and WaitFor on background work.');
    await until(() => f.events.filter(e => e.type === 'tool' && e.name === 'WaitFor').length === 1);
    waitingRequests = f.model.requests.length;
    await pause(250);
    assert.equal(
      f.model.requests.length,
      waitingRequests,
      'WaitFor suspends native turn without model polling',
    );
    await running;
    await f.session.waitForBackgroundIdle();
    const outputs = f.events.filter(e => e.type === 'tool-result').map(e => e.output);
    assert.ok(
      outputs.some(output => /status: running/.test(output)),
      'TaskOutput snapshots running work',
    );
    assert.ok(
      outputs.some(output => /timed_out|timeout|timed out/i.test(output)),
      'WaitFor timeout returns control',
    );
    assert.ok(f.events.some(e => e.text === 'WAIT_COMPLETE'));
    assert.equal(f.resources.snapshot().active, 0);
  },
);
