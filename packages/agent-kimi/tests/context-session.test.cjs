const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {KimiSession} = require('../src/index.cjs');

test('equivalent Broker scope keeps the session; a changed effective scope replaces it', async t => {
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-test-'));
  t.after(() => fs.rmSync(shareDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(shareDir, 'config.toml'), 'default_model = "industrial"\n');
  let scope = {version: 'one', domain: 'chip', stage: 'rtl', capabilityIds: ['chip.rtl.netlist.inspect'], skills: ['chip.netlist.inspect'], tools: ['eda.netlist.inspect']};
  const created = [];
  const prompts = [];
  const events = [];
  const factory = options => {
    const instance = {options, closes: 0, async close() {this.closes++;}, prompt(text) {
      prompts.push(text);
      return {result: Promise.resolve({status: 'completed'}), async *[Symbol.asyncIterator]() {
        yield {type: 'StatusUpdate', payload: {context_usage: 0.72, token_usage: null}};
        yield {type: 'ToolResult', payload: {tool_call_id: 't1', return_value: {output: 'x'.repeat(13000), message: 'Read', is_error: false}}};
        yield {type: 'CompactionBegin', payload: {}};
        yield {type: 'CompactionEnd', payload: {}};
        yield {type: 'StatusUpdate', payload: {context_usage: 0.24, token_usage: null}};
      }};
    }};
    created.push(instance);
    return instance;
  };
  const session = new KimiSession(shareDir, () => scope, async () => null, () => null, event => events.push(event), () => ({apiKey: 'test', revision: 0, shareDir, profile: {thinking: false}, disabledMcpServers: []}), factory);
  t.after(() => session.close());

  await session.run('Inspect netlist');
  scope = {...scope, version: 'two'};
  await session.run('Inspect netlist again');
  assert.equal(created.length, 1);
  assert.match(prompts[1], /Industrial Context \(current Broker scope\)/);
  assert.match(prompts[1], /chip\.rtl\.netlist\.inspect/);
  assert.deepEqual(events.filter(event => event.type === 'context-metrics')[0], {type: 'context-metrics', peakContextUsage: 0.72, lastContextUsage: 0.24, compactions: 1, toolResults: 1, peakToolResultBytes: 13000});
  assert.equal(events.find(event => event.type === 'tool-result').outputTruncated, true);
  assert.equal(events.find(event => event.type === 'tool-result').outputBytes, 13000);

  scope = {...scope, stage: 'verification', version: 'three'};
  await session.run('Inspect verification');
  assert.equal(created.length, 2);
  assert.equal(created[0].closes, 1);
  assert.match(prompts[2], /"stage":"verification"/);
});
