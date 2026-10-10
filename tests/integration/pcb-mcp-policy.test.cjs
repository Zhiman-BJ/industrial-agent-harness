const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  resourceCatalog,
  ResourceSettings,
  resolveProjectTask,
} = require('../../packages/harness-core/src/index.cjs');
const { selectMcpServers } = require('../../packages/domain-mcp/src/index.cjs');
test('Desktop/CLI PCB policy keeps public Skills local and withholds the frozen private MCP modification path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pcb-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = resourceCatalog('pcb');
  assert.deepEqual(catalog.mcpServers, []);
  const settings = new ResourceSettings(path.join(root, 'settings'));
  settings.set(catalog, { kind: 'skill', id: 'pcb.design.e2e', mode: 'disabled' });
  const disabled = resolveProjectTask(
    'pcb',
    { task: 'KiCad board edit' },
    undefined,
    undefined,
    settings.snapshot(catalog, root).effective,
  );
  assert.ok(!disabled.scope.skills.includes('pcb.design.e2e'));
  const enabled = resolveProjectTask('pcb', { task: 'KiCad board edit' }).scope;
  assert.deepEqual(enabled.tools, ['pcb.kicad.edit', 'pcb.kicad.verify']);
  assert.deepEqual(selectMcpServers(enabled), []);
  assert.ok(!enabled.tools.some(id => id.startsWith('pcb.bench.')));
});
test('real CLI scopes typed PCB Runtime Actions without starting any native process', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pcb-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stdout = execFileSync(
    process.execPath,
    [
      path.resolve(__dirname, '../../apps/cli/src/main.cjs'),
      'run',
      '--project-dir',
      root,
      '--domain',
      'pcb',
      '--task',
      'KiCad board edit',
      '--scope-only',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') },
    },
  );
  const rows = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0].scope.tools, ['pcb.kicad.edit', 'pcb.kicad.verify']);
  assert.equal(rows.at(-1).status, 'scoped');
});
test('PCB bench tool names resolve the declared bench surface through the Broker without standalone MCP servers', () => {
  const scope = resolveProjectTask('pcb', {
    task: 'pcb.bench.place_component verify_design finalize_claims',
  }).scope;
  const bench = scope.tools.filter(id => id.startsWith('pcb.bench.'));
  assert.equal(bench.length, 89);
  assert.ok(bench.includes('pcb.bench.project_status'));
  assert.ok(bench.includes('pcb.bench.run_python'));
  // The bounded native profile stays reachable on its own keywords.
  const native = resolveProjectTask('pcb', { task: 'KiCad board edit' }).scope;
  assert.deepEqual(native.tools, ['pcb.kicad.edit', 'pcb.kicad.verify']);
  // Bench execution rides industrial_action_call through the pack runtime;
  // the standalone MCP gateway transport stays undisclosed.
  assert.deepEqual(selectMcpServers(scope), []);
  assert.deepEqual(selectMcpServers(native), []);
});
