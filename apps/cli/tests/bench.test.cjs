const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadSuite, runBench} = require('../src/bench.cjs');

test('bench keeps per-scenario evidence and fails on a wrong capability expectation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-bench-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, 'project'));
  const suiteFile = path.join(directory, 'suite.json');
  fs.writeFileSync(suiteFile, JSON.stringify({schemaVersion: 1, scenarios: [
    {id: 'matched', projectDir: './project', domain: 'chip', task: 'Inspect netlist signals', scopeOnly: true, expected: {capabilityIds: ['chip.rtl.netlist.inspect'], skills: ['chip.netlist.inspect'], tools: ['eda.netlist.inspect'], mcpServers: []}},
    {id: 'gap', projectDir: './project', domain: 'chip', task: 'Run RTL verification', scopeOnly: true, expected: {capabilityIds: ['chip.rtl.simulate']}},
  ]}));
  const outputDir = path.join(directory, 'results');
  assert.equal(await runBench(['--suite', suiteFile, '--output-dir', outputDir]), 1);
  const summary = JSON.parse(fs.readFileSync(path.join(outputDir, 'summary.json')));
  assert.equal(summary.scenarios[0].passed, true);
  assert.equal(summary.scenarios[1].passed, false);
  assert.match(summary.scenarios[1].failures.join(' '), /capabilityIds/);
  assert.equal(fs.readFileSync(path.join(outputDir, 'matched.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('bench rejects duplicate scenario IDs before writing results', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-bench-invalid-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const suiteFile = path.join(directory, 'suite.json');
  const item = {id: 'same', projectDir: '.', domain: 'chip', task: 'Inspect netlist'};
  fs.writeFileSync(suiteFile, JSON.stringify({schemaVersion: 1, scenarios: [item, item]}));
  assert.throws(() => loadSuite(suiteFile), /duplicate scenario ID/);
});
