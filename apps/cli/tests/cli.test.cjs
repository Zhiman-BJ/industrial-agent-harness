const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Writable} = require('node:stream');
const {parseArgs} = require('../src/args.cjs');
const {run, loadArtifacts} = require('../src/main.cjs');

test('headless CLI resolves a domain task as JSON Lines without Electron or a model key', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-test-'));
  t.after(() => fs.rmSync(projectDir, {recursive: true, force: true}));
  const rows = [];
  const output = new Writable({write(chunk, _encoding, callback) {rows.push(...String(chunk).trim().split('\n').map(JSON.parse)); callback();}});
  const options = parseArgs(['run', '--project-dir', projectDir, '--domain', 'pcb', '--task', 'Inspect PCB board routing', '--scope-only']);
  assert.equal(await run(options, output, {}), 0);
  assert.deepEqual(rows.map(item => item.type), ['scope', 'result']);
  assert.equal(rows[0].scope.domain, 'pcb');
  assert.deepEqual(rows[0].scope.capabilityIds, ['pcb.layout.inspect']);
  assert.equal(rows[1].status, 'scoped');
  assert.ok(!Object.keys(require.cache).some(key => key.includes('/electron/')));
  assert.ok(!Object.keys(require.cache).some(key => key.includes('/apps/desktop/') || key.includes('/packages/viewer-builtin/')));
});

test('CLI requires one task source and a known domain', async t => {
  assert.throws(() => parseArgs(['run', '--project-dir', '.', '--domain', 'chip']), /exactly one/);
  assert.throws(() => parseArgs(['run', '--project-dir', '.', '--domain', 'chip', '--task', 'a', '--task-file', 'b']), /exactly one/);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-domain-'));
  t.after(() => fs.rmSync(projectDir, {recursive: true, force: true}));
  await assert.rejects(run({projectDir, domain: 'unknown', task: 'Inspect netlist', scopeOnly: true}, new Writable({write(_chunk, _encoding, callback) {callback();}})), /valid project domain/);
});

test('CLI disable flag removes a repository skill from the resolved scope', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-disabled-'));
  t.after(() => fs.rmSync(projectDir, {recursive: true, force: true}));
  const rows = [];
  const output = new Writable({write(chunk, _encoding, callback) {rows.push(...String(chunk).trim().split('\n').map(JSON.parse)); callback();}});
  const options = parseArgs(['run', '--project-dir', projectDir, '--domain', 'chip', '--task', 'Inspect netlist signals', '--scope-only', '--disable-skill', 'chip.netlist.inspect']);
  assert.equal(await run(options, output, {}), 0);
  assert.deepEqual(rows[0].scope.skills, []);
  await assert.rejects(run({...options, disabledSkills: ['unknown']}, output, {}), /Unknown project skill/);
});

test('artifact manifest cannot reference files outside its project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-artifact-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(root, 'outside.vcd'), 'x');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify([{id: 'outside', kind: 'waveform', path: '../outside.vcd'}]));
  await assert.rejects(loadArtifacts(manifest, projectDir), /inside the project/);
});

test('headless CLI runs a task and emits agent and approval events', async t => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cli-run-'));
  t.after(() => fs.rmSync(projectDir, {recursive: true, force: true}));
  const rows = [];
  const output = new Writable({write(chunk, _encoding, callback) {rows.push(...String(chunk).trim().split('\n').map(JSON.parse)); callback();}});
  const approvals = [];
  class FakeSession {
    constructor(_directory, getScope, _artifact, _disclose, emit) {
      assert.equal(getScope().domain, 'chip');
      this.emit = emit;
    }
    async run(task) {
      assert.equal(task, 'Inspect netlist signals');
      this.emit({type: 'text', text: 'Checking the netlist.'});
      this.emit({type: 'approval', id: 'a1', description: 'Read file'});
      await new Promise(resolve => setImmediate(resolve));
      this.emit({type: 'done', result: {status: 'completed'}});
    }
    approve(id, decision) {approvals.push({id, decision});}
    async close() {}
  }
  const options = parseArgs(['run', '--project-dir', projectDir, '--domain', 'chip', '--task', 'Inspect netlist signals']);
  assert.equal(await run(options, output, {KIMI_API_KEY: 'test-key'}, FakeSession), 0);
  assert.deepEqual(rows.map(item => item.type), ['scope', 'agent_event', 'agent_event', 'approval_decision', 'agent_event', 'result']);
  assert.deepEqual(approvals, [{id: 'a1', decision: 'reject'}]);
  assert.equal(rows.at(-1).status, 'completed');
});
