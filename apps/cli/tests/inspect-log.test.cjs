const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {inspectLog} = require('../src/inspect-log.cjs');

test('log inspector reports full tool bytes and detects missing records', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-log-inspect-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'trace.jsonl');
  const payloads = [
    {type: 'run.start', payload: {projectDir: '/project', model: {model: '27B'}, scope: {tools: []}}},
    {type: 'prompt', payload: {text: 'Inspect'}},
    {type: 'sdk.event', payload: {type: 'ToolCall', payload: {id: 't1', function: {name: 'inspect', arguments: '{}'}}}},
    {type: 'sdk.event', payload: {type: 'ToolCallPart', payload: {arguments_part: 'more'}}},
    {type: 'sdk.event', payload: {type: 'ToolResult', payload: {tool_call_id: 't1', return_value: {output: '中'.repeat(5000), is_error: false}}}},
    {type: 'sdk.event', payload: {type: 'CompactionBegin', payload: {}}},
    {type: 'run.end', payload: {status: 'finished'}},
  ];
  const rows = payloads.map((row, index) => ({schemaVersion: 1, traceId: 'trace', sequence: index + 1, at: '2026-09-25T00:00:00Z', ...row}));
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const result = inspectLog(file);
  assert.equal(result.toolCalls[0].resultBytes, 15000);
  assert.equal(result.toolCalls[0].arguments, '{}more');
  assert.equal(result.compactions, 1);
  assert.equal(result.logComplete, true);
  fs.writeFileSync(file, rows.filter(row => row.sequence !== 3).map(JSON.stringify).join('\n') + '\n');
  assert.throws(() => inspectLog(file), /missing or inconsistent/);
});
