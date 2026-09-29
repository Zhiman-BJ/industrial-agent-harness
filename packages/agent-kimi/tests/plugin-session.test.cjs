const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {z} = require('zod');
const {createKimiPaths} = require('@moonshot-ai/kimi-agent-sdk');
const {KimiSession} = require('../src/index.cjs');

function makePlugin({enabled = true} = {}) {
  return {
    name: 'fake-gui',
    enabled: () => enabled,
    toolNames: ['fake_click', 'fake_state'],
    materializeSkill: directory => {
      const target = path.join(directory, 'skills', 'fake-gui');
      fs.mkdirSync(target, {recursive: true});
      fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: fake-gui\n---\n');
      return path.join(directory, 'skills');
    },
    toolsFactory: () => [{name: 'fake_click', description: 'd', parameters: z.object({}), handler: async () => ({output: 'ok', message: 'ok'})}],
  };
}

function startSession(t, plugin) {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const created = [];
  const events = [];
  const approvals = [];
  const scope = {version: 'one', domain: 'chip', stage: 'rtl', capabilityIds: ['chip.rtl.netlist.inspect'], skills: ['chip.netlist.inspect'], tools: ['eda.netlist.inspect']};
  const factory = options => {
    const instance = {options, async close() {}, prompt() {
      return {
        result: Promise.resolve({status: 'completed'}),
        approve: (id, response) => {approvals.push({id, response}); return Promise.resolve();},
        async *[Symbol.asyncIterator]() {
          yield {type: 'ApprovalRequest', payload: {id: 'a1', sender: 'fake_click', action: 'click', description: 'click e1'}};
          yield {type: 'ApprovalRequest', payload: {id: 'a2', sender: 'Shell', action: 'run', description: 'ls'}};
        },
      };
    }};
    created.push(instance);
    return instance;
  };
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'k', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory, {directory: path.join(shareDir, 'logs'), getBrokerTrace: () => []}, plugin ? [plugin] : []);
  t.after(() => session.close());
  return {session, created, events, approvals, shareDir};
}

test('an enabled plugin contributes skill dir and tools; its approvals are auto-approved', async t => {
  const {session, created, events, approvals} = startSession(t, makePlugin());
  await session.run('do it');
  const options = created[0].options;
  const toolNames = options.externalTools.map(item => item.name);
  assert.ok(toolNames.includes('fake_click'), 'plugin tool registered');
  assert.ok(toolNames.includes('eda_netlist_inspect'), 'broker tools still registered');
  assert.match(fs.readFileSync(path.join(options.shareDir, 'config.toml'), 'utf8'), /^extra_skill_dirs = \[/);
  assert.ok(fs.existsSync(path.join(options.shareDir, 'skills', 'fake-gui', 'SKILL.md')), 'plugin skill materialized');
  assert.ok(fs.existsSync(path.join(options.shareDir, 'skills', 'chip-netlist-inspect', 'SKILL.md')), 'domain skill still materialized');
  // The plugin tool approval (sender fake_click) is auto-approved for the session;
  // the non-plugin approval (Shell) is still surfaced to the user.
  assert.deepEqual(approvals, [{id: 'a1', response: 'approve_for_session'}]);
  const surfaced = events.filter(event => event.type === 'approval');
  assert.deepEqual(surfaced.map(event => event.id), ['a2']);
});

test('streamed ToolCallPart arguments are assembled and replayed with the tool result', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {version: 'one', domain: 'chip', stage: null, capabilityIds: [], skills: [], tools: []};
  const factory = () => ({async close() {}, prompt: () => ({
    result: Promise.resolve({status: 'completed'}),
    approve: async () => {},
    async *[Symbol.asyncIterator]() {
      // Mirrors the real SDK stream: the ToolCall frame carries arguments:null,
      // the real arguments arrive as id-less ToolCallPart frames, then the result.
      yield {type: 'ToolCall', payload: {type: 'function', id: 't1', function: {name: 'screenshot', arguments: null}}};
      yield {type: 'ToolCallPart', payload: {arguments_part: '{"app": "com'}};
      yield {type: 'ToolCallPart', payload: {arguments_part: '.google.Chrome"'}};
      yield {type: 'ToolCallPart', payload: {arguments_part: '}'}};
      yield {type: 'ToolResult', payload: {tool_call_id: 't1', return_value: {is_error: false, output: 'captured', message: 'Tool completed', display: []}}};
      yield {type: 'ToolResult', payload: {tool_call_id: 't2', return_value: {is_error: false, message: 'Tool completed', display: [], output: [{type: 'text', text: 'window'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}]}}};
    },
  })});
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'k', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory);
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
  assert.ok(!JSON.stringify(imageResult).includes('AAAA'), 'base64 payload must not enter the event stream');
  assert.match(imageResult.output, /window/);
});

test('a turn interrupted mid-tool-call does not leak a phantom event into the next turn', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {version: 'one', domain: 'chip', stage: null, capabilityIds: [], skills: [], tools: []};
  const scripts = [
    // Interrupted: the ToolCall frame and part of its streamed arguments
    // arrived, but the turn ended before any ToolResult.
    [
      {type: 'ToolCall', payload: {type: 'function', id: 't1', function: {name: 'type_text', arguments: null}}},
      {type: 'ToolCallPart', payload: {arguments_part: '{"text": "hel'}},
    ],
    [
      {type: 'ToolCall', payload: {type: 'function', id: 't2', function: {name: 'screenshot', arguments: null}}},
      {type: 'ToolResult', payload: {tool_call_id: 't2', return_value: {is_error: false, output: 'ok', message: 'Tool completed', display: []}}},
    ],
  ];
  let promptCount = 0;
  const factory = () => ({async close() {}, prompt: () => ({
    result: Promise.resolve({status: promptCount === 0 ? 'cancelled' : 'completed'}),
    approve: async () => {},
    async *[Symbol.asyncIterator]() {yield* scripts[promptCount++];},
  })});
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'k', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory);
  await session.run('first turn');
  events.length = 0;
  await session.run('second turn');
  const toolEvents = events.filter(event => event.type === 'tool');
  assert.deepEqual(toolEvents.map(event => event.id), ['t2'], 'the interrupted call t1 must not reappear in the new turn');
});

test('an interleaved tool result replays with its own tool name', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {version: 'one', domain: 'chip', stage: null, capabilityIds: [], skills: [], tools: []};
  const factory = () => ({async close() {}, prompt: () => ({
    result: Promise.resolve({status: 'completed'}),
    approve: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {type: 'ToolCall', payload: {type: 'function', id: 't1', function: {name: 'screenshot', arguments: null}}};
      yield {type: 'ToolCallPart', payload: {arguments_part: '{"display": 0}'}};
      yield {type: 'ToolCall', payload: {type: 'function', id: 't2', function: {name: 'click', arguments: null}}};
      yield {type: 'ToolResult', payload: {tool_call_id: 't1', return_value: {is_error: false, output: 'img', message: 'Tool completed', display: []}}};
    },
  })});
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'k', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory);
  await session.run('parallel calls');
  const t1Events = events.filter(event => event.type === 'tool' && event.id === 't1');
  assert.ok(t1Events.length >= 2, 'the initial frame and the replay both fire');
  for (const event of t1Events) assert.equal(event.name, 'screenshot', 'every t1 event carries its own tool name');
});

test('kimi snapshots keep base64 image payloads out of the diagnostic directory', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const scope = {version: 'one', domain: 'chip', stage: null, capabilityIds: [], skills: [], tools: []};
  const base64 = 'A'.repeat(5000);
  const nativeLine = JSON.stringify({role: 'tool', content: [{type: 'image_url', image_url: {url: `data:image/png;base64,${base64}`}}]});
  const factory = settings => {
    const directory = createKimiPaths(settings.shareDir).sessionDir(shareDir, 'snap-session');
    fs.mkdirSync(directory, {recursive: true});
    return {sessionId: 'snap-session', async close() {}, prompt: () => ({
      result: Promise.resolve({status: 'completed'}),
      approve: async () => {},
      async *[Symbol.asyncIterator]() {
        // The native CLI history records the screenshot as a data URI; the
        // diagnostic snapshot must not copy that payload to disk.
        fs.writeFileSync(path.join(directory, 'context.jsonl'), `${nativeLine}\n`);
        fs.writeFileSync(path.join(directory, 'wire.jsonl'), `${nativeLine}\n`);
        yield {type: 'ContentPart', payload: {type: 'text', text: 'done'}};
      },
    })};
  };
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'k', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory, {directory: path.join(shareDir, 'logs')});
  await session.run('screenshot');
  const diagnostic = events.find(event => event.type === 'diagnostic-log');
  assert.ok(diagnostic, 'the run records its diagnostic log');
  for (const kind of ['context', 'wire']) {
    const snapshotFile = path.join(path.dirname(diagnostic.path), `${diagnostic.traceId}.after-turn.${kind}.jsonl`);
    const content = fs.readFileSync(snapshotFile, 'utf8');
    assert.ok(!content.includes(base64), `${kind} snapshot must not carry the base64 payload`);
    assert.match(content, /\[image redacted, 5000 chars\]/, `${kind} snapshot notes the redacted payload`);
  }
});

test('plugin tools are built with the session diagnostics log sink', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-plugin-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  const events = [];
  const sinks = [];
  const scope = {version: 'one', domain: 'chip', stage: null, capabilityIds: [], skills: [], tools: []};
  const plugin = {
    name: 'fake-gui',
    enabled: () => true,
    toolNames: ['fake_click'],
    materializeSkill: () => shareDir,
    toolsFactory: sink => {
      sinks.push(sink);
      return [{name: 'fake_click', description: 'd', parameters: z.object({}), handler: async () => ({output: 'ok', message: 'ok'})}];
    },
  };
  const factory = () => ({async close() {}, prompt: () => ({result: Promise.resolve({status: 'completed'}), approve: async () => {}, async *[Symbol.asyncIterator]() {}})});
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'k', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory, {directory: path.join(shareDir, 'logs'), pluginLog: (...args) => events.push({type: 'plugin-log', args})}, [plugin]);
  await session.run('do it');
  assert.equal(sinks.length, 1, 'toolsFactory is called once per session build');
  assert.equal(typeof sinks[0], 'function', 'the diagnostics pluginLog sink reaches the plugin tools');
});

test('a disabled plugin contributes nothing', async t => {
  const {session, created, events} = startSession(t, makePlugin({enabled: false}));
  await session.run('do it');
  const toolNames = created[0].options.externalTools.map(item => item.name);
  assert.ok(!toolNames.includes('fake_click'));
  assert.ok(!fs.existsSync(path.join(created[0].options.shareDir, 'skills', 'fake-gui')));
  assert.deepEqual(events.filter(event => event.type === 'approval').map(event => event.id), ['a1', 'a2']);
});
