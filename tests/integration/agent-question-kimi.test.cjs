const test = require('node:test');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { KimiSession } = require('../../packages/agent-kimi/src/index.cjs');
const { DiagnosticReader } = require('../../packages/agent-kimi/src/diagnostic-reader.cjs');
const {
  writeCliConfig,
  validateProfile,
  sessionEnv,
} = require('../../packages/agent-kimi/src/model-config.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const root = path.resolve(__dirname, '../..');
const kimi =
  process.env.KIMI_EXECUTABLE ||
  require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();

for (const scenario of [
  { name: 'single choice', answers: { 'Which layer?': 'Bottom' }, kind: 'single' },
  {
    name: 'multiple choices including a comma in an option label',
    multi: true,
    answers: { 'Which layer?': 'Top, front, Bottom' },
    kind: 'multi',
  },
  {
    name: 'multiple choices with custom text and a second custom answer',
    multi: true,
    extra: true,
    answers: { 'Which layer?': 'Bottom, custom, note', 'Which finish?': 'custom finish' },
    kind: 'multi_with_other',
  },
  { name: 'dismissal', answers: {} },
])
  test(
    `pinned Kimi Code question resumes after ${scenario.name} in auto-approval mode`,
    { timeout: 45000, skip: !fs.existsSync(kimi) },
    async t => {
      let asked = false;
      const fixture = await startModel({
        success: 'QUESTION_ANSWERED',
        calls: () =>
          asked
            ? []
            : ((asked = true),
              [
                {
                  name: 'AskUserQuestion',
                  arguments: {
                    questions: [
                      {
                        question: 'Which layer?',
                        header: 'Layout',
                        options: [
                          {
                            label: scenario.multi ? 'Top, front' : 'Top',
                            description: 'Upper layer',
                          },
                          { label: 'Bottom', description: 'Lower layer' },
                        ],
                        multi_select: Boolean(scenario.multi),
                      },
                      ...(scenario.extra
                        ? [
                            {
                              question: 'Which finish?',
                              header: 'Finish',
                              options: [{ label: 'Gold' }, { label: 'Silver' }],
                            },
                          ]
                        : []),
                    ],
                  },
                },
              ]),
      });
      t.after(fixture.close);
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kimi-question-'));
      t.after(() => fs.rmSync(project, { recursive: true, force: true }));
      const profile = validateProfile({
        provider: 'openai_legacy',
        endpoint: fixture.endpoint,
        model: 'controlled-question',
        contextSize: 32768,
        thinking: false,
      });
      const runtime = {
        apiKey: 'controlled-question-key',
        profile,
        revision: 0,
        executable: kimi,
        shareDir: writeCliConfig(project, profile),
        env: sessionEnv(profile, 'controlled-question-key'),
        approvalMode: 'auto',
      };
      const scope = { domain: 'godot', stage: null, capabilityIds: [], skills: [], tools: [] };
      const events = [];
      let submissionError, wireAnswer;
      let session;
      session = new KimiSession(
        project,
        () => scope,
        () => null,
        () => null,
        event => {
          events.push(event);
          if (event.type === 'question')
            queueMicrotask(() => {
              const transport = session.session;
              const original = transport.request.bind(transport);
              transport.request = (route, options) => {
                if (route.includes('/questions/')) wireAnswer = { route, ...options };
                return original(route, options);
              };
              void session.answerQuestion(event.id, scenario.answers).catch(error => {
                submissionError = error;
              });
            });
        },
        () => runtime,
        undefined,
        { directory: path.join(project, 'logs') },
      );
      t.after(() => session.close());
      await session.run('Ask me which layer, then continue');
      assert.equal(
        events.filter(event => event.type === 'question').length,
        1,
        JSON.stringify(events),
      );
      assert.equal(submissionError, undefined);
      assert.equal(
        events.find(event => event.type === 'question-resolved')?.decision,
        scenario.kind ? 'answered' : 'skipped',
      );
      if (scenario.kind) {
        assert.equal(wireAnswer.body.answers.q_0.kind, scenario.kind);
        if (scenario.kind === 'multi')
          assert.deepEqual(wireAnswer.body.answers.q_0.option_ids, ['opt_0_0', 'opt_0_1']);
        if (scenario.extra) {
          assert.equal(wireAnswer.body.answers.q_0.other_text, 'custom, note');
          assert.deepEqual(wireAnswer.body.answers.q_1, { kind: 'other', text: 'custom finish' });
        }
      } else assert.ok(wireAnswer.route.endsWith(':dismiss'));
      assert.equal(
        events.find(event => event.type === 'done')?.result.status,
        'finished',
        JSON.stringify(events),
      );
      assert.ok(fixture.requests[0].tools.some(tool => tool.function.name === 'AskUserQuestion'));
      assert.ok(
        fixture.requests.length >= 2,
        'Kimi should resume the model after the question is answered',
      );
      for (const text of Object.values(scenario.answers))
        assert.ok(
          events.some(event => event.type === 'tool-result' && event.output.includes(text)),
          'Kimi should return the answer through the native tool result',
        );
      if (!scenario.kind)
        assert.ok(
          events.some(event => event.type === 'tool-result' && /dismissed/i.test(event.output)),
        );
      const reader = new DiagnosticReader(path.join(project, 'logs'));
      const { runs } = await reader.list(project);
      const page = await reader.page(project, { runId: runs[0].runId, category: 'approvals' });
      assert.ok(page.records.some(record => record.event === 'QuestionRequest'));
      assert.ok(page.records.some(record => record.type === 'question.response'));
      const timeline = await reader.view(project, { runId: runs[0].runId });
      assert.ok(timeline.entries.some(entry => entry.title === '询问用户'));
      assert.ok(timeline.entries.some(entry => entry.title === '用户回答'));
    },
  );

test(
  'noninteractive application host preserves native questions as needs_input without reporting a question error',
  { timeout: 30000 },
  async t => {
    let asked = false;
    const fixture = await startModel({
      success: 'CLI_QUESTION_DISMISSED',
      calls: () =>
        asked
          ? []
          : ((asked = true),
            [
              {
                name: 'AskUserQuestion',
                arguments: {
                  questions: [
                    {
                      question: 'Which layer?',
                      options: [{ label: 'Top' }, { label: 'Bottom' }],
                      multi_select: false,
                    },
                  ],
                },
              },
            ]),
    });
    t.after(fixture.close);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-question-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const result = await promisify(execFile)(
      process.execPath,
      taskArguments({
        projectDir: project,
        domain: 'godot',
        task: 'Ask me about layers and continue after dismissal',
        provider: 'openai_legacy',
        endpoint: fixture.endpoint,
        model: 'controlled-question',
        thinking: false,
        approval: 'auto',
        chatDir: path.join(directory, 'chats'),
        stateDir: path.join(directory, 'state'),
        logDir: path.join(directory, 'logs'),
      }),
      {
        cwd: root,
        timeout: 25000,
        env: {
          ...process.env,
          KIMI_EXECUTABLE: kimi,
          OPENAI_API_KEY: 'local-question-fixture',
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'settings'),
        },
      },
    ).catch(error => {
      assert.equal(error.code, 2);
      return error;
    });
    assert.equal(result.code, 2);
    const { stdout } = result;
    const rows = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).status, 'needs_input');
    assert.equal(rows.filter(row => row.type === 'question_error').length, 0, stdout);
    assert.ok(rows.some(row => row.type === 'needs_input' && row.questions.length === 1));
    assert.equal(fixture.requests.length, 1);
  },
);
