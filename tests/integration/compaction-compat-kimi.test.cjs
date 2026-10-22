const test = require('node:test');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');

test(
  'Harness preserves native auto compaction, events and persisted context across application-host restarts',
  { timeout: 90000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-compaction-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const summary = 'NATIVE_COMPACTION_SUMMARY_MARKER';
    const isCompaction = body =>
      JSON.stringify(body.messages.at(-1)?.content).includes('Create a handoff summary');
    const model = await startModel({
      calls: [],
      success: body => (isCompaction(body) ? summary : 'CONTROLLED_TURN_FINISHED'),
      // Report a high context count once. Kimi alone chooses whether and how to
      // compact; this exercises the wrapper boundary, not summary quality.
      usage: (_body, index) =>
        index === 0
          ? { prompt_tokens: 30000, completion_tokens: 10, total_tokens: 30010 }
          : undefined,
    });
    t.after(model.close);
    async function run(task, chatId) {
      const args = taskArguments({
        projectDir: project,
        domain: 'godot',
        task: task,
        provider: 'openai_legacy',
        endpoint: model.endpoint,
        model: 'controlled',
        thinking: false,
        contextSize: 32768,
        chatDir: path.join(directory, 'chats'),
        stateDir: path.join(directory, 'state'),
        logDir: path.join(directory, 'logs'),
        chatId,
      });
      const { stdout } = await execute(process.execPath, args, {
        cwd: root,
        timeout: 25000,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'local-compaction-fixture',
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'settings'),
        },
      });
      const rows = stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).status, 'finished', stdout);
      const events = rows.filter(row => row.event).map(row => row.event);
      assert.equal(events.filter(event => event.type === 'context-reset').length, 0, stdout);
      const log = fs
        .readFileSync(events.find(event => event.type === 'diagnostic-log').path, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      return {
        chatId: rows.at(-1).chatId,
        events,
        log,
        sessionId: log.find(row => row.type === 'session.ready').payload.sessionId,
      };
    }
    const first = await run('FIRST_BEFORE_NATIVE_COMPACTION');
    const second = await run('SECOND_AFTER_NATIVE_COMPACTION', first.chatId);
    assert.equal(second.chatId, first.chatId);
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(
      second.events.filter(event => event.type === 'compaction').map(event => event.state),
      ['begin', 'end'],
    );
    assert.ok(
      second.log.some(
        row =>
          row.type === 'kimi-code.event' &&
          row.payload.payload.type === 'compaction.started' &&
          row.payload.payload.payload.trigger === 'auto',
      ),
    );
    const summaryRequests = model.requests.filter(isCompaction);
    assert.equal(summaryRequests.length, 1);
    const normalRequests = () => model.requests.filter(body => !isCompaction(body));
    assert.match(JSON.stringify(normalRequests().at(-1).messages), new RegExp(summary));
    assert.equal(second.events.find(event => event.type === 'context-metrics').compactions, 1);
    const third = await run('THIRD_RESUMED_AFTER_NATIVE_COMPACTION', first.chatId);
    assert.equal(third.sessionId, first.sessionId);
    assert.match(JSON.stringify(normalRequests().at(-1).messages), new RegExp(summary));
    assert.equal(normalRequests().length, 3);
  },
);
