const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { z } = require('zod');
const { createKimiPaths } = require('../src/legacy-paths.cjs');
const { KimiSession } = require('../src/index.cjs');

function makePlugin({ enabled = true } = {}) {
  return {
    name: 'fake-gui',
    enabled: () => enabled,
    toolNames: ['fake_click', 'fake_state'],
    materializeSkill: directory => {
      const target = path.join(directory, 'skills', 'fake-gui');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: fake-gui\n---\n');
      return path.join(directory, 'skills');
    },
    toolsFactory: () => [
      {
        name: 'fake_click',
        description: 'd',
        parameters: z.object({}),
        handler: async () => ({ output: 'ok', message: 'ok' }),
      },
    ],
  };
}

function startSession(t, plugin, externalServers = [], diagnostics = {}) {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const created = [];
  const events = [];
  const approvals = [];
  const scope = {
    version: 'one',
    domain: 'chip',
    stage: 'rtl',
    capabilityIds: ['chip.rtl.netlist.inspect'],
    skills: ['chip.netlist.inspect'],
    tools: [
      'eda.netlist.inspect',
      ...externalServers.flatMap(server => server.tools.map(tool => tool.id)),
    ],
  };
  const factory = options => {
    const instance = {
      options,
      async close() {},
      prompt() {
        return {
          result: Promise.resolve({ status: 'completed' }),
          approve: (id, response) => {
            approvals.push({ id, response });
            return Promise.resolve();
          },
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'ApprovalRequest',
              payload: { id: 'a1', sender: 'fake_click', action: 'click', description: 'click e1' },
            };
            yield {
              type: 'ApprovalRequest',
              payload: { id: 'a2', sender: 'Shell', action: 'run', description: 'ls' },
            };
            if (externalServers.length)
              yield {
                type: 'ApprovalRequest',
                payload: {
                  id: 'a3',
                  sender: 'external_tool_call',
                  action: 'call',
                  description: 'external mutation',
                },
              };
          },
        };
      },
    };
    created.push(instance);
    return instance;
  };
  const session = new KimiSession(
    shareDir,
    () => scope,
    async () => null,
    () => null,
    event => events.push(event),
    () => ({
      apiKey: 'k',
      revision: 0,
      shareDir,
      profile: { thinking: false },
      disabledMcpServers: [],
      externalServers,
    }),
    factory,
    { directory: path.join(shareDir, 'logs'), getBrokerTrace: () => [], ...diagnostics },
    plugin ? [plugin] : [],
  );
  t.after(() => session.close());
  return { session, created, events, approvals, shareDir };
}

test('an industrial turn runs while excluding configured host MCP and application plugins before materialization', async t => {
  const plugin = {
    name: 'unavailable-gui',
    enabled: () => true,
    toolNames: ['unavailable_click'],
    materializeSkill: () => assert.fail('Excluded plugin materialized'),
    toolsFactory: () => assert.fail('Excluded plugin exposed'),
  };
  const external = [{ id: 'external.unavailable', tools: [{ id: 'external.unavailable.call' }] }];
  const industrialRuntime = {
    cancel() {},
    async waitForIdle() {},
    inspect: async () => ({
      id: 'example',
      projectId: 'example',
      domain: 'example',
      stage: null,
      status: 'unverified',
      verificationIds: [],
      inputHashes: {},
    }),
  };
  const { session, created, events } = startSession(t, plugin, external, { industrialRuntime });
  await session.run('Use registered industrial tools');
  const options = created[0].options;
  assert.ok(options.externalTools.some(t => t.name === 'industrial_action_call'));
  assert.ok(
    !options.externalTools.some(
      t => t.name === 'unavailable_click' || t.name === 'external_tool_call',
    ),
  );
  assert.ok(
    !fs
      .readFileSync(path.join(options.shareDir, 'mcp.json'), 'utf8')
      .includes('external.unavailable'),
  );
  assert.ok(
    events.some(
      e => e.type === 'resources-filtered' && e.externalMcp.includes('external.unavailable'),
    ),
    'excluded resources surface as a structured event, not assistant text',
  );
  assert.ok(events.some(e => e.type === 'done'));
  assert.equal(plugin.enabled(), true);
  assert.equal(external.length, 1);
});

test('a protected industrial session admits a protectedSafe plugin and auto-approves its tools', async t => {
  const plugin = { ...makePlugin(), protectedSafe: true };
  const industrialRuntime = {
    cancel() {},
    async waitForIdle() {},
    inspect: async () => ({
      id: 'example',
      projectId: 'example',
      domain: 'example',
      stage: null,
      status: 'unverified',
      verificationIds: [],
      inputHashes: {},
    }),
  };
  const { session, created, events, approvals } = startSession(t, plugin, [], {
    industrialRuntime,
  });
  await session.run('click e1');
  const options = created[0].options;
  const toolNames = options.externalTools.map(item => item.name);
  assert.ok(toolNames.includes('fake_click'), 'protectedSafe plugin tool registered');
  assert.ok(toolNames.includes('industrial_action_call'), 'host Runtime tools still registered');
  assert.ok(
    fs.existsSync(path.join(options.shareDir, 'skills', 'fake-gui', 'SKILL.md')),
    'plugin skill materialized inside the protected session',
  );
  // The plugin tool approval is auto-approved for the session (enable is the
  // authorization); the unrelated Shell approval still surfaces to the user.
  assert.deepEqual(approvals, [{ id: 'a1', response: 'approve_for_session' }]);
  assert.deepEqual(
    events.filter(event => event.type === 'approval').map(event => event.id),
    ['a2'],
  );
  assert.ok(
    !events.some(event => event.type === 'resources-filtered'),
    'an admitted plugin is not reported as filtered',
  );
  assert.ok(events.some(e => e.type === 'done'));
});

test('a protected industrial session still excludes plugins without protectedSafe', async t => {
  const plugin = {
    name: 'unvetted-gui',
    enabled: () => true,
    toolNames: ['unvetted_click'],
    materializeSkill: () => assert.fail('Excluded plugin materialized'),
    toolsFactory: () => assert.fail('Excluded plugin exposed'),
  };
  const industrialRuntime = {
    cancel() {},
    async waitForIdle() {},
    inspect: async () => ({
      id: 'example',
      projectId: 'example',
      domain: 'example',
      stage: null,
      status: 'unverified',
      verificationIds: [],
      inputHashes: {},
    }),
  };
  const { session, created, events } = startSession(t, plugin, [], { industrialRuntime });
  await session.run('Use registered industrial tools');
  assert.ok(
    !created[0].options.externalTools.some(tool => tool.name === 'unvetted_click'),
    'a plugin without protectedSafe stays out of protected sessions',
  );
  assert.ok(
    events.some(e => e.type === 'resources-filtered' && e.plugins.includes('unvetted-gui')),
    'the excluded plugin surfaces as a structured event',
  );
  assert.ok(events.some(e => e.type === 'done'));
});

test('an enabled plugin contributes skill dir and tools; its approvals are auto-approved', async t => {
  const { session, created, events, approvals } = startSession(t, makePlugin());
  await session.run('do it');
  const options = created[0].options;
  const toolNames = options.externalTools.map(item => item.name);
  assert.ok(toolNames.includes('fake_click'), 'plugin tool registered');
  assert.ok(toolNames.includes('eda_netlist_inspect'), 'broker tools still registered');
  assert.match(
    fs.readFileSync(path.join(options.shareDir, 'config.toml'), 'utf8'),
    /^extra_skill_dirs = \[/,
  );
  assert.ok(
    fs.existsSync(path.join(options.shareDir, 'skills', 'fake-gui', 'SKILL.md')),
    'plugin skill materialized',
  );
  assert.ok(
    fs.existsSync(path.join(options.shareDir, 'skills', 'chip-netlist-inspect', 'SKILL.md')),
    'domain skill still materialized',
  );
  // The plugin tool approval (sender fake_click) is auto-approved for the session;
  // the non-plugin approval (Shell) is still surfaced to the user.
  assert.deepEqual(approvals, [{ id: 'a1', response: 'approve_for_session' }]);
  const surfaced = events.filter(event => event.type === 'approval');
  assert.deepEqual(
    surfaced.map(event => event.id),
    ['a2'],
  );
});

test('a remote host Runtime materializes no local domain MCP and binds native compatibility to its remote identity', async t => {
  let identity = 'service-project-snapshot-one';
  const industrialRuntime = {
    hostRuntimeOnly: true,
    compatibilityKey: () => identity,
    descriptors: () => [],
    cancel() {},
    async waitForIdle() {},
    inspect: async () => ({
      id: 'example',
      projectId: 'example',
      domain: 'example',
      stage: null,
      status: 'unverified',
      verificationIds: [],
      inputHashes: {},
    }),
  };
  const { session, created } = startSession(t, null, [], { industrialRuntime });
  await session.run('use remote');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(created[0].options.shareDir, 'mcp.json'), 'utf8'))
      .mcpServers,
    {},
  );
  assert.ok(created[0].options.externalTools.some(tool => tool.name === 'industrial_action_call'));
  identity = 'service-project-snapshot-two';
  await session.run('continue with changed snapshot');
  assert.equal(created.length, 2);
});

test('streamed ToolCallPart arguments are assembled and replayed with the tool result', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {
    version: 'one',
    domain: 'chip',
    stage: null,
    capabilityIds: [],
    skills: [],
    tools: [],
  };
  const factory = () => ({
    async close() {},
    prompt: () => ({
      result: Promise.resolve({ status: 'completed' }),
      approve: async () => {},
      async *[Symbol.asyncIterator]() {
        // Mirrors the real SDK stream: the ToolCall frame carries arguments:null,
        // the real arguments arrive as id-less ToolCallPart frames, then the result.
        yield {
          type: 'ToolCall',
          payload: {
            type: 'function',
            id: 't1',
            function: { name: 'screenshot', arguments: null },
          },
        };
        yield { type: 'ToolCallPart', payload: { arguments_part: '{"app": "com' } };
        yield { type: 'ToolCallPart', payload: { arguments_part: '.google.Chrome"' } };
        yield { type: 'ToolCallPart', payload: { arguments_part: '}' } };
        yield {
          type: 'ToolResult',
          payload: {
            tool_call_id: 't1',
            return_value: {
              is_error: false,
              output: 'captured',
              message: 'Tool completed',
              display: [],
            },
          },
        };
        yield {
          type: 'ToolResult',
          payload: {
            tool_call_id: 't2',
            return_value: {
              is_error: false,
              message: 'Tool completed',
              display: [],
              output: [
                { type: 'text', text: 'window' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
              ],
            },
          },
        };
      },
    }),
  });
  const session = new KimiSession(
    shareDir,
    () => scope,
    async () => null,
    () => null,
    event => events.push(event),
    () => ({
      apiKey: 'k',
      revision: 0,
      shareDir,
      profile: { thinking: false },
      disabledMcpServers: [],
    }),
    factory,
  );
  await session.run('screenshot chrome');
  const toolEvents = events.filter(event => event.type === 'tool' && event.id === 't1');
  // The initial frame plus one replay carrying the assembled arguments.
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0].arguments, '');
  assert.equal(toolEvents[1].arguments, '{\n  "app": "com.google.Chrome"\n}');
  const resultEvent = events.find(event => event.type === 'tool-result');
  assert.equal(resultEvent.error, false);
  // Array (ContentPart) outputs: image payloads stay out of the event stream,
  // only their count is surfaced alongside the text parts.
  const imageResult = events.filter(event => event.type === 'tool-result')[1];
  assert.equal(imageResult.imageCount, 1);
  assert.ok(
    !JSON.stringify(imageResult).includes('AAAA'),
    'base64 payload must not enter the event stream',
  );
  assert.match(imageResult.output, /window/);
});

test('complete native tool arguments survive concurrent calls and out-of-order results alongside legacy fragments', async t => {
  const { session, events } = startSession(t);
  const first = { capabilityId: 'not-selected', section: 'all' };
  const last = { capabilityId: 'selected', section: 'tools' };
  const call = (id, name, args) => ({
    type: 'ToolCall',
    payload: { id, function: { name, arguments: args === null ? null : JSON.stringify(args) } },
  });
  const result = (id, error = false) => ({
    type: 'ToolResult',
    payload: {
      tool_call_id: id,
      return_value: { is_error: error, output: error ? 'outside scope' : 'ok', message: '' },
    },
  });
  session.sessionFactory = () => ({
    async close() {},
    prompt: () => ({
      result: Promise.resolve({ status: 'completed' }),
      async *[Symbol.asyncIterator]() {
        yield call('full-first', 'industrial_capability_detail', first);
        yield call('legacy', 'legacy_tool', null);
        yield { type: 'ToolCallPart', payload: { arguments_part: '{"text":"leg' } };
        yield { type: 'ToolCallPart', payload: { arguments_part: 'acy"}' } };
        yield call('full-last', 'industrial_capability_detail', last);
        yield { type: 'ToolCallPart', payload: { arguments_part: '' } };
        yield result('full-last');
        yield result('full-first', true);
        yield result('legacy');
      },
    }),
  });
  await session.run('parallel capability inspection');
  for (const [id, expected] of [
    ['full-first', first],
    ['full-last', last],
  ]) {
    const calls = events.filter(event => event.type === 'tool' && event.id === id);
    assert.ok(calls.length, `Missing ${id} tool event`);
    for (const event of calls) {
      assert.equal(event.name, 'industrial_capability_detail');
      assert.ok(event.arguments, `${id} arguments must never be overwritten with an empty update`);
      assert.deepEqual(JSON.parse(event.arguments), expected);
    }
  }
  const legacy = events.filter(event => event.type === 'tool' && event.id === 'legacy').at(-1);
  assert.equal(legacy.name, 'legacy_tool');
  assert.deepEqual(JSON.parse(legacy.arguments), { text: 'legacy' });
  assert.deepEqual(
    events.filter(event => event.type === 'tool-result').map(event => [event.id, event.error]),
    [
      ['full-last', false],
      ['full-first', true],
      ['legacy', false],
    ],
  );
  assert.equal(session.pendingToolArgs.size, 0);
  assert.equal(session.toolNames.size, 0);
  assert.equal(session.lastToolCall, null);
});

test('a turn interrupted mid-tool-call does not leak a phantom event into the next turn', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {
    version: 'one',
    domain: 'chip',
    stage: null,
    capabilityIds: [],
    skills: [],
    tools: [],
  };
  const scripts = [
    // Interrupted: the ToolCall frame and part of its streamed arguments
    // arrived, but the turn ended before any ToolResult.
    [
      {
        type: 'ToolCall',
        payload: { type: 'function', id: 't1', function: { name: 'type_text', arguments: null } },
      },
      { type: 'ToolCallPart', payload: { arguments_part: '{"text": "hel' } },
    ],
    [
      {
        type: 'ToolCall',
        payload: { type: 'function', id: 't2', function: { name: 'screenshot', arguments: null } },
      },
      {
        type: 'ToolResult',
        payload: {
          tool_call_id: 't2',
          return_value: { is_error: false, output: 'ok', message: 'Tool completed', display: [] },
        },
      },
    ],
  ];
  let promptCount = 0;
  const factory = () => ({
    async close() {},
    prompt: () => ({
      result: Promise.resolve({ status: promptCount === 0 ? 'cancelled' : 'completed' }),
      approve: async () => {},
      async *[Symbol.asyncIterator]() {
        yield* scripts[promptCount++];
      },
    }),
  });
  const session = new KimiSession(
    shareDir,
    () => scope,
    async () => null,
    () => null,
    event => events.push(event),
    () => ({
      apiKey: 'k',
      revision: 0,
      shareDir,
      profile: { thinking: false },
      disabledMcpServers: [],
    }),
    factory,
  );
  await session.run('first turn');
  events.length = 0;
  await session.run('second turn');
  const toolEvents = events.filter(event => event.type === 'tool');
  assert.deepEqual(
    toolEvents.map(event => event.id),
    ['t2'],
    'the interrupted call t1 must not reappear in the new turn',
  );
});

test('an interleaved tool result replays with its own tool name', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {
    version: 'one',
    domain: 'chip',
    stage: null,
    capabilityIds: [],
    skills: [],
    tools: [],
  };
  const factory = () => ({
    async close() {},
    prompt: () => ({
      result: Promise.resolve({ status: 'completed' }),
      approve: async () => {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'ToolCall',
          payload: {
            type: 'function',
            id: 't1',
            function: { name: 'screenshot', arguments: null },
          },
        };
        yield { type: 'ToolCallPart', payload: { arguments_part: '{"display": 0}' } };
        yield {
          type: 'ToolCall',
          payload: { type: 'function', id: 't2', function: { name: 'click', arguments: null } },
        };
        yield {
          type: 'ToolResult',
          payload: {
            tool_call_id: 't1',
            return_value: {
              is_error: false,
              output: 'img',
              message: 'Tool completed',
              display: [],
            },
          },
        };
      },
    }),
  });
  const session = new KimiSession(
    shareDir,
    () => scope,
    async () => null,
    () => null,
    event => events.push(event),
    () => ({
      apiKey: 'k',
      revision: 0,
      shareDir,
      profile: { thinking: false },
      disabledMcpServers: [],
    }),
    factory,
  );
  await session.run('parallel calls');
  const t1Events = events.filter(event => event.type === 'tool' && event.id === 't1');
  assert.ok(t1Events.length >= 2, 'the initial frame and the replay both fire');
  for (const event of t1Events)
    assert.equal(event.name, 'screenshot', 'every t1 event carries its own tool name');
});

test('kimi snapshots keep base64 image payloads out of the diagnostic directory', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {
    version: 'one',
    domain: 'chip',
    stage: null,
    capabilityIds: [],
    skills: [],
    tools: [],
  };
  const base64 = 'A'.repeat(5000);
  const nativeLine = JSON.stringify({
    role: 'tool',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }],
  });
  const factory = settings => {
    const directory = createKimiPaths(settings.shareDir).sessionDir(shareDir, 'snap-session');
    fs.mkdirSync(directory, { recursive: true });
    return {
      sessionId: 'snap-session',
      async close() {},
      prompt: () => ({
        result: Promise.resolve({ status: 'completed' }),
        approve: async () => {},
        async *[Symbol.asyncIterator]() {
          // The native CLI history records the screenshot as a data URI; the
          // diagnostic snapshot must not copy that payload to disk.
          fs.writeFileSync(path.join(directory, 'context.jsonl'), `${nativeLine}\n`);
          fs.writeFileSync(path.join(directory, 'wire.jsonl'), `${nativeLine}\n`);
          yield { type: 'ContentPart', payload: { type: 'text', text: 'done' } };
        },
      }),
    };
  };
  const session = new KimiSession(
    shareDir,
    () => scope,
    async () => null,
    () => null,
    event => events.push(event),
    () => ({
      apiKey: 'k',
      revision: 0,
      shareDir,
      profile: { thinking: false },
      disabledMcpServers: [],
    }),
    factory,
    { directory: path.join(shareDir, 'logs') },
  );
  await session.run('screenshot');
  const diagnostic = events.find(event => event.type === 'diagnostic-log');
  assert.ok(diagnostic, 'the run records its diagnostic log');
  for (const kind of ['context', 'wire']) {
    const snapshotFile = path.join(
      path.dirname(diagnostic.path),
      `${diagnostic.traceId}.after-turn.${kind}.jsonl`,
    );
    const content = fs.readFileSync(snapshotFile, 'utf8');
    assert.ok(!content.includes(base64), `${kind} snapshot must not carry the base64 payload`);
    assert.match(
      content,
      /\[image redacted, 5000 chars\]/,
      `${kind} snapshot notes the redacted payload`,
    );
  }
});

test('plugin tools are built with the session diagnostics log sink', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const sinks = [];
  const scope = {
    version: 'one',
    domain: 'chip',
    stage: null,
    capabilityIds: [],
    skills: [],
    tools: [],
  };
  const plugin = {
    name: 'fake-gui',
    enabled: () => true,
    toolNames: ['fake_click'],
    materializeSkill: () => shareDir,
    toolsFactory: sink => {
      sinks.push(sink);
      return [
        {
          name: 'fake_click',
          description: 'd',
          parameters: z.object({}),
          handler: async () => ({ output: 'ok', message: 'ok' }),
        },
      ];
    },
  };
  const factory = () => ({
    async close() {},
    prompt: () => ({
      result: Promise.resolve({ status: 'completed' }),
      approve: async () => {},
      async *[Symbol.asyncIterator]() {},
    }),
  });
  const session = new KimiSession(
    shareDir,
    () => scope,
    async () => null,
    () => null,
    event => events.push(event),
    () => ({
      apiKey: 'k',
      revision: 0,
      shareDir,
      profile: { thinking: false },
      disabledMcpServers: [],
    }),
    factory,
    {
      directory: path.join(shareDir, 'logs'),
      pluginLog: (...args) => events.push({ type: 'plugin-log', args }),
    },
    [plugin],
  );
  await session.run('do it');
  assert.equal(sinks.length, 1, 'toolsFactory is called once per session build');
  assert.equal(
    typeof sinks[0],
    'function',
    'the diagnostics pluginLog sink reaches the plugin tools',
  );
});

test('a disabled plugin contributes nothing', async t => {
  const { session, created, events } = startSession(t, makePlugin({ enabled: false }));
  await session.run('do it');
  const toolNames = created[0].options.externalTools.map(item => item.name);
  assert.ok(!toolNames.includes('fake_click'));
  assert.ok(!fs.existsSync(path.join(created[0].options.shareDir, 'skills', 'fake-gui')));
  assert.deepEqual(
    events.filter(event => event.type === 'approval').map(event => event.id),
    ['a1', 'a2'],
  );
});

test('external MCP and plugin skills coexist; external approvals remain interactive across session renewals', async t => {
  const { toolSnapshot, hash } = require('../../domain-mcp/src/external-client.cjs');
  const tools = toolSnapshot('external.host', [
    { name: 'observe', inputSchema: { type: 'object', properties: {} } },
  ]);
  const server = {
    id: 'external.host',
    tools,
    surfaceHash: hash(tools),
    revision: 'first',
    config: {
      transport: 'stdio',
      command: process.execPath,
      args: [],
      cwd: os.tmpdir(),
      env: {},
      envRefs: {},
    },
  };
  let enabled = true;
  const plugin = { ...makePlugin(), enabled: () => enabled };
  const { session, created, events, approvals } = startSession(t, plugin, [server]);
  await session.run('both');
  const files = created[0].options.shareDir;
  assert.ok(
    JSON.parse(fs.readFileSync(path.join(files, 'mcp.json'))).mcpServers['harness.external'],
  );
  assert.ok(fs.existsSync(path.join(files, 'skills', 'fake-gui', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(files, 'skills', 'chip-netlist-inspect', 'SKILL.md')));
  assert.deepEqual(approvals, [{ id: 'a1', response: 'approve_for_session' }]);
  assert.deepEqual(
    events.filter(event => event.type === 'approval').map(event => event.id),
    ['a2', 'a3'],
  );
  await session.run('unchanged');
  assert.equal(created.length, 1);
  server.revision = 'refreshed';
  await session.run('MCP changed');
  assert.equal(created.length, 2);
  enabled = false;
  await session.run('plugin disabled');
  assert.equal(created.length, 3);
  assert.ok(!created[2].options.externalTools.some(tool => tool.name === 'fake_click'));
  assert.ok(
    JSON.parse(fs.readFileSync(path.join(created[2].options.shareDir, 'mcp.json'))).mcpServers[
      'harness.external'
    ],
  );
});
