const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  resolveProjectTask,
  resourceCatalog,
} = require('../../packages/harness-core/src/index.cjs');
const { prepareSessionFiles } = require('../../packages/agent-kimi/src/index.cjs');
const { providerRuntime } = require('../../packages/domain-mcp/src/gateway.cjs');
const { selectMcpServers, listMcpServers } = require('../../packages/domain-mcp/src/index.cjs');
const execute = promisify(execFile);
let runtime;
try {
  runtime = providerRuntime(
    selectMcpServers(resolveProjectTask('chip', { task: 'project status' }).scope)[0],
  );
} catch {}

test(
  'shared Project → Broker → Kimi config → real scoped MCP rejects undeclared and cross-project calls',
  { timeout: 60000, skip: !runtime },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-mcp-scope-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    // No EDA job or image is needed to exercise persistent project context through MCP.
    fs.writeFileSync(
      path.join(directory, 'eda.yaml'),
      'name: mcp-test\ntop: top\nruntime:\n  kind: local\ninputs: {}\nactions: {}\nrequired_verification: []\n',
    );
    fs.writeFileSync(path.join(directory, 'config.toml'), 'default_model = "industrial"\n');
    const catalog = resourceCatalog('chip');
    assert.equal(catalog.mcpServers[0].id, 'chip-pack.eda');
    const pcbProviders = resourceCatalog('pcb').mcpServers;
    assert.ok(
      pcbProviders.some(
        provider => provider.transport === 'runtime' && provider.toolIds.includes('pcb.kicad.edit'),
      ),
    );
    assert.deepEqual(
      listMcpServers('pcb'),
      [],
      'Runtime resources remain outside standalone MCP configuration',
    );
    const { scope } = resolveProjectTask('chip', { task: 'project status' });
    const session = prepareSessionFiles(
      scope,
      { shareDir: directory, disabledMcpServers: [] },
      undefined,
      directory,
    );
    t.after(() => fs.rmSync(session, { recursive: true, force: true }));
    const config = path.join(session, 'mcp.json');
    const { stdout } = await execute(
      runtime.python,
      [path.join(__dirname, 'fixtures/domain-mcp-client.py'), config],
      { timeout: 40000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true);
    assert.equal(result.rejections, 6);
    assert.equal(result.projectDir, fs.realpathSync(directory));
    assert.ok(fs.existsSync(path.join(directory, '.eda')));
    const disabled = resolveProjectTask('chip', { task: 'project status' }, undefined, undefined, {
      mcpServers: ['chip-pack.eda'],
    });
    assert.ok(!disabled.scope.tools.some(id => id.startsWith('eda.harness.')));
    assert.deepEqual(selectMcpServers(disabled.scope), []);
  },
);
