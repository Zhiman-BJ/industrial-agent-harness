const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('packaged headless entry runs outside the workspace with Broker and Skill resources', t => {
  const root = path.resolve(__dirname, '../../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-headless-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const target = path.join(directory, 'bundle');
  const built = spawnSync(process.execPath, [path.join(root, 'scripts/package-headless.cjs'), target], {cwd: root, encoding: 'utf8'});
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const suite = path.join(root, 'examples/bench/scope-smoke.json');
  const outputDir = path.join(directory, 'results');
  const executed = spawnSync(process.execPath, [path.join(target, 'industrial-harness.cjs'), 'bench', '--suite', suite, '--output-dir', outputDir], {cwd: os.tmpdir(), encoding: 'utf8'});
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, 'summary.json'))).passed, true);
  assert.ok(fs.existsSync(path.join(target, 'node_modules/@industrial-agent-harness/domain-skills/skills/chip-netlist-inspect/SKILL.md')));
  assert.equal(fs.existsSync(path.join(target, 'node_modules/@industrial-agent-harness/desktop')), false);
});
