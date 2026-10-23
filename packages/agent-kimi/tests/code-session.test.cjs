const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSession } = require('../src/code-session.cjs');
const { externalTools } = require('../src/index.cjs');
const { configToml, sessionEnv } = require('../src/model-config.cjs');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');

async function fixture(t, options = {}) {
  const model = await startModel(options);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-code-contract-'));
  const profile = {
    provider: 'openai_legacy',
    endpoint: model.endpoint,
    model: 'controlled',
    contextSize: 32768,
    thinking: false,
  };
  fs.writeFileSync(path.join(directory, 'config.toml'), configToml(profile));
  fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
  const session = createSession({
    workDir: directory,
    shareDir: directory,
    env: sessionEnv(profile, 'contract-secret-key'),
  });
  t.after(async () => {
    await session.close();
    model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { model, session, directory };
}

async function consume(session, onEvent, expectedStatus = 'finished') {
  const turn = session.prompt('Execute the controlled task');
  const events = [];
  for await (const event of turn) {
    events.push(event);
    await onEvent?.(event, turn);
  }
  assert.equal((await turn.result).status, expectedStatus);
  return events;
}

test('native frame boundary preserves child interactions, rejects other sessions and keeps stream replay/gap checks', () => {
  const session = createSession({ shareDir: os.tmpdir() }),
    events = [];
  session.nativeId = 'bound';
  session.active = {
    ended: false,
    turnId: 2,
    push: e => events.push(e),
    offsets: new Map(),
    calls: new Map(),
  };
  const frame = (type, payload, seq, offset) => ({
    type,
    payload,
    session_id: 'bound',
    epoch: 'epoch',
    seq,
    offset,
  });
  const question = frame(
    'event.question.requested',
    {
      agentId: 'child',
      turnId: 99,
      question_id: 'q',
      questions: [{ id: 'item', question: 'Choose', options: [{ id: 'yes', label: 'Yes' }] }],
    },
    1,
  );
  session.onFrame({ ...question, session_id: 'other' });
  session.onFrame(question);
  session.onFrame(question);
  session.onFrame(frame('assistant.delta', { agentId: 'child', delta: 'HIDDEN' }, 2, 0));
  assert.deepEqual(
    events.filter(e => e.type === 'QuestionRequest').map(e => e.payload.agentId),
    ['child'],
  );
  session.onFrame(frame('turn.step.started', { agentId: 'main', turnId: 2, step: 1 }, 3));
  session.onFrame(frame('assistant.delta', { agentId: 'main', turnId: 2, delta: 'abc' }, 4, 0));
  session.onFrame(frame('assistant.delta', { agentId: 'main', turnId: 2, delta: 'bc' }, 5, 1));
  const second = frame('turn.step.started', { agentId: 'main', turnId: 2, step: 2 }, 6);
  session.onFrame(second);
  session.onFrame(frame('assistant.delta', { agentId: 'main', turnId: 2, delta: 'd' }, 7, 0));
  session.onFrame(second);
  assert.equal(
    events
      .filter(e => e.type === 'ContentPart')
      .map(e => e.payload.text)
      .join(''),
    'abcd',
  );
  assert.throws(
    () =>
      session.onFrame(frame('assistant.delta', { agentId: 'main', turnId: 2, delta: 'gap' }, 8, 5)),
    /gap/,
  );
});

test('real thinking and answer streams retain separate offsets', { timeout: 15000 }, async t => {
  const f = await fixture(t, {
    calls: [],
    thinking: 'CONTROLLED_THINKING',
    success: 'CONTROLLED_ANSWER',
  });
  f.session.options.thinking = true;
  const config = path.join(f.directory, 'config.toml');
  fs.writeFileSync(
    config,
    fs
      .readFileSync(config, 'utf8')
      .replace('enabled = false', 'enabled = true')
      .replace('capabilities = []', 'capabilities = ["thinking"]'),
  );
  const events = await consume(f.session);
  assert.ok(
    events.some(
      event => event.type === 'ContentPart' && event.payload.think === 'CONTROLLED_THINKING',
    ),
  );
  assert.ok(
    events.some(
      event => event.type === 'ContentPart' && event.payload.text === 'CONTROLLED_ANSWER',
    ),
  );
});

test(
  'native multi-step text and thinking survive a tool call, including shorter final output',
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, {
      calls: () => [{ name: 'Read', arguments: { path: path.join(f.directory, 'input.txt') } }],
      stepText: 'I will read the controlled file.',
      thinking: (_, index) => (index === 0 ? 'FIRST_THINKING' : 'SECOND_THINKING'),
      success: 'DONE',
    });
    fs.writeFileSync(path.join(f.directory, 'input.txt'), 'controlled input');
    f.session.options.thinking = true;
    const config = path.join(f.directory, 'config.toml');
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace('enabled = false', 'enabled = true')
        .replace('capabilities = []', 'capabilities = ["thinking"]'),
    );
    const events = await consume(f.session);
    assert.equal(
      events
        .filter(e => e.type === 'ContentPart' && e.payload.text)
        .map(e => e.payload.text)
        .join(''),
      'I will read the controlled file.DONE',
    );
    assert.equal(
      events
        .filter(e => e.type === 'ContentPart' && e.payload.think)
        .map(e => e.payload.think)
        .join(''),
      'FIRST_THINKINGSECOND_THINKING',
    );
    assert.equal(f.model.requests.length, 2);
  },
);

test(
  'native child approvals support approve, reject and cancel through the parent session',
  { timeout: 60000 },
  async t => {
    for (const decision of ['approve', 'reject', 'cancel']) {
      const child = body =>
        body.messages.some(
          m => m.role === 'user' && JSON.stringify(m.content).includes('CONTROLLED_CHILD_JOB'),
        );
      const f = await fixture(t, {
        stopOnRejection: false,
        calls: body =>
          child(body)
            ? [
                {
                  name: 'Bash',
                  arguments: {
                    command: 'printf CHILD_OK > child-marker.txt',
                    description: 'Controlled child write',
                  },
                },
              ]
            : [
                {
                  name: 'Agent',
                  arguments: {
                    prompt: 'CONTROLLED_CHILD_JOB',
                    description: 'Controlled interaction test',
                    subagent_type: 'coder',
                  },
                },
              ],
        success: body => (child(body) ? 'CHILD_FINISHED' : 'PARENT_FINISHED'),
      });
      const events = await consume(
        f.session,
        async (event, turn) => {
          if (event.type === 'ApprovalRequest') {
            if (event.payload.agentId !== 'main' && decision === 'cancel') await turn.interrupt();
            else
              await turn.approve(
                event.payload.id,
                event.payload.agentId !== 'main' ? decision : 'approve',
              );
          }
        },
        decision === 'cancel' ? 'cancelled' : 'finished',
      );
      assert.ok(
        events.some(
          e => e.type === 'ApprovalRequest' && e.payload.agentId && e.payload.agentId !== 'main',
        ),
      );
      assert.equal(
        fs.existsSync(path.join(f.directory, 'child-marker.txt')),
        decision === 'approve',
      );
      if (decision !== 'cancel')
        assert.equal(
          events
            .filter(e => e.type === 'ContentPart' && e.payload.text)
            .map(e => e.payload.text)
            .join(''),
          'PARENT_FINISHED',
        );
    }
  },
);

test(
  'failed configured MCP blocks prompting instead of silently omitting tools',
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { calls: [] });
    fs.writeFileSync(
      path.join(f.directory, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          broken: {
            command: process.execPath,
            args: [path.join(f.directory, 'missing-server.cjs')],
          },
        },
      }),
    );
    await assert.rejects(f.session.prompt('Never execute').result, /MCP broken failed/);
    await f.session.close();
    assert.equal(f.model.requests.length, 0);
  },
);

test(
  'native auth tokens stay out of transport events and diagnostic snapshots',
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, {
      calls: body => [
        { name: 'Read', arguments: { path: path.join(f.directory, 'server.token') } },
      ],
    });
    const events = await consume(f.session);
    assert.ok(
      JSON.stringify(f.model.requests[1].messages).includes(f.session.token),
      'the upstream tool still returns the authorized file to the model',
    );
    assert.ok(!JSON.stringify(events).includes(f.session.token));
    assert.ok(!JSON.stringify(await f.session.diagnosticSnapshot()).includes(f.session.token));
  },
);

test(
  'real native Bash requires approval; reject leaves files untouched and approve executes with complete arguments',
  { timeout: 30000 },
  async t => {
    for (const decision of ['reject', 'approve']) {
      const f = await fixture(t, {
        calls: [
          {
            name: 'Bash',
            arguments: {
              command: 'printf CODE_BASH_OK > approved.txt',
              description: 'Write the controlled marker',
            },
          },
        ],
      });
      const events = await consume(f.session, async (event, turn) => {
        if (event.type === 'ApprovalRequest') await turn.approve(event.payload.id, decision);
      });
      assert.ok(events.some(event => event.type === 'ApprovalRequest'));
      const calls = events.filter(
        event => event.type === 'ToolCall' && event.payload.function.name === 'Bash',
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].payload.function.arguments), {
        command: 'printf CODE_BASH_OK > approved.txt',
        description: 'Write the controlled marker',
      });
      assert.equal(
        f.model.requests[0].max_completion_tokens ?? f.model.requests[0].max_tokens,
        8192,
      );
      const marker = path.join(f.directory, 'approved.txt');
      if (decision === 'approve') assert.equal(fs.readFileSync(marker, 'utf8'), 'CODE_BASH_OK');
      else assert.equal(fs.existsSync(marker), false);
    }
  },
);

test(
  'real MCP host callback rechecks revoked Broker scope, and local service rejects unauthenticated callers',
  { timeout: 20000 },
  async t => {
    let scope = { capabilityIds: ['chip.rtl.netlist.inspect'], tools: ['eda.netlist.inspect'] };
    let reads = 0;
    const f = await fixture(t, {
      calls: body => {
        scope = { capabilityIds: [], tools: [] };
        return [{ name: 'eda_netlist_inspect', arguments: { artifactId: 'artifact-1' } }];
      },
    });
    f.session.options.externalTools = externalTools(
      () => scope,
      async () => {
        reads++;
        return { kind: 'netlist' };
      },
      () => ({}),
    );
    const events = await consume(f.session, async (event, turn) => {
      if (event.type === 'ApprovalRequest') await turn.approve(event.payload.id, 'approve');
    });
    assert.equal(reads, 0);
    assert.ok(
      events.some(
        event =>
          event.type === 'ToolResult' &&
          event.payload.return_value.is_error &&
          /outside the current Broker scope/.test(event.payload.return_value.output),
      ),
    );
    assert.equal(
      (await fetch(f.session.toolServer.config.url, { method: 'POST', body: '{}' })).status,
      401,
    );
    assert.equal((await fetch(`${f.session.baseUrl}/api/v1/sessions`)).status, 401);
  },
);

test(
  'startup failure rejects the turn, repeated close settles, and cancelled startup leaves no live child',
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { calls: [] });
    f.session.options.executable = path.join(f.directory, 'missing-cli.mjs');
    const turn = f.session.prompt('Never execute');
    await assert.rejects(async () => {
      for await (const event of turn) {
        // Drain the stream; events are not inspected.
      }
    }, /process exited/);
    await assert.rejects(turn.result, /process exited/);
    await Promise.all([f.session.close(), f.session.close()]);
    assert.equal(f.model.requests.length, 0);
    assert.notEqual(f.session.child.exitCode, null);
    const cancelled = await fixture(t, { calls: [] });
    const pending = cancelled.session.prompt('Cancel during startup');
    await pending.interrupt();
    await cancelled.session.close();
    await cancelled.session.initializing.catch(() => {});
    assert.equal((await pending.result).status, 'cancelled');
    assert.ok(!cancelled.session.child || cancelled.session.child.exitCode !== null);
    assert.equal(cancelled.model.requests.length, 0);
  },
);

test('pinned server version is enforced before sending a prompt', { timeout: 15000 }, async t => {
  const f = await fixture(t, { calls: [] });
  const executable = path.join(f.directory, 'wrong-version.cjs');
  fs.writeFileSync(
    executable,
    `const http = require('node:http'); const port = Number(process.argv[process.argv.indexOf('--port') + 1]); const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({code: 0, data: {server_version: '2.1.2'}})); if(req.url.endsWith('/shutdown')) server.close(); }); server.listen(port, '127.0.0.1');`,
  );
  f.session.options.executable = executable;
  const turn = f.session.prompt('Never execute');
  await assert.rejects(turn.result, /2\.1\.1 is required; found 2\.1\.2/);
  await f.session.close();
  assert.equal(f.model.requests.length, 0);
});

test(
  'real scoped Skills are discovered and read progressively; TodoList retains its display contract',
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, { calls: [] });
    const skills = path.join(f.directory, 'selected-skills');
    const skill = path.join(skills, 'controlled-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(
      skill,
      '---\nname: controlled-skill\ndescription: Controlled discovery summary\n---\n\nPRIVATE_SKILL_BODY_MARKER\n',
    );
    const config = path.join(f.directory, 'config.toml');
    fs.writeFileSync(
      config,
      `extra_skill_dirs = [${JSON.stringify(skills)}]\n` + fs.readFileSync(config, 'utf8'),
    );
    f.model.close();
    const model = await startModel({
      calls: [
        { name: 'Read', arguments: { path: skill } },
        {
          name: 'TodoList',
          arguments: { todos: [{ title: 'Controlled completion', status: 'done' }] },
        },
      ],
    });
    t.after(model.close);
    f.session.options.env.OPENAI_BASE_URL = model.endpoint;
    fs.writeFileSync(
      config,
      fs.readFileSync(config, 'utf8').replace(f.model.endpoint, model.endpoint),
    );
    const events = await consume(f.session, async (event, turn) => {
      if (event.type === 'ApprovalRequest') await turn.approve(event.payload.id, 'approve');
    });
    assert.ok(JSON.stringify(model.requests[0].messages).includes('Controlled discovery summary'));
    assert.ok(!JSON.stringify(model.requests[0].messages).includes('PRIVATE_SKILL_BODY_MARKER'));
    assert.ok(JSON.stringify(model.requests[1].messages).includes('PRIVATE_SKILL_BODY_MARKER'));
    const catalog = await f.session.request(`sessions/${f.session.nativeId}/skills`);
    assert.ok(
      catalog.skills.some(item => item.name === 'controlled-skill' && item.source === 'extra'),
    );
    assert.ok(
      events.some(
        event =>
          event.type === 'ToolResult' &&
          event.payload.return_value.display.some(
            block => block.type === 'todo' && block.items[0].status === 'done',
          ),
      ),
    );
  },
);

test(
  'tool preamble does not swallow the final answer when native step offsets restart',
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, {
      beforeTool: 'Checking the requested file. '.repeat(8),
      calls: [
        { name: 'Bash', arguments: { command: 'echo OFFSET_OK', description: 'Read-only marker' } },
      ],
      success: 'FINAL_ANSWER_OK',
    });
    const events = await consume(f.session, async (event, turn) => {
      if (event.type === 'ApprovalRequest') await turn.approve(event.payload.id, 'approve');
    });
    assert.equal(
      events
        .filter(e => e.type === 'ContentPart')
        .map(e => e.payload.text || '')
        .join(''),
      'Checking the requested file. '.repeat(8) + 'FINAL_ANSWER_OK',
    );
  },
);

test(
  'native child approval is routed once, rejection and approval settle the parent with lifecycle and summary',
  { timeout: 45000 },
  async t => {
    for (const decision of ['reject', 'approve']) {
      const child = body =>
        body.messages.some(
          m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_ONLY'),
        );
      const f = await fixture(t, {
        calls: body =>
          child(body)
            ? [
                {
                  name: 'Bash',
                  arguments: {
                    command: 'echo CHILD_TOOL_OK',
                    description: 'Read-only child marker',
                  },
                },
              ]
            : [
                {
                  name: 'Agent',
                  arguments: {
                    description: 'Inspect independently',
                    prompt: 'CHILD_ONLY: run the marker, then summarize.',
                    subagent_type: 'coder',
                  },
                },
              ],
        success: body => (child(body) ? 'CHILD_SUMMARY_OK' : 'PARENT_FINAL_OK'),
      });
      const events = await consume(f.session, async (event, turn) => {
        if (event.type === 'ApprovalRequest') {
          assert.notEqual(event.payload.agentId, 'main');
          assert.ok(event.payload.agentId);
          await turn.approve(event.payload.id, decision);
        }
      });
      assert.equal(events.filter(e => e.type === 'ApprovalRequest').length, 1);
      assert.ok(events.some(e => e.type === 'SubagentState' && e.payload.status === 'running'));
      assert.ok(events.some(e => e.type === 'SubagentState' && e.payload.status === 'completed'));
      assert.equal(
        events
          .filter(e => e.type === 'ContentPart')
          .map(e => e.payload.text || '')
          .join(''),
        decision === 'approve' ? 'PARENT_FINAL_OK' : 'MCP_REJECTED',
      );
      assert.ok(
        !events.some(e => e.type === 'ContentPart' && /CHILD_SUMMARY/.test(e.payload.text || '')),
        'child output stays out of main answer',
      );
    }
  },
);
