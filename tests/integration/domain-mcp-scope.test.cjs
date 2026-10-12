const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createProjectRuntime,
  resourceCatalog,
} = require('../../packages/harness-core/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const { prepareSessionFiles } = require('../../packages/agent-kimi/src/index.cjs');
const { selectMcpServers } = require('../../packages/domain-mcp/src/index.cjs');

test('shared Project → Broker → Kimi config → canonical Runtime rejects undeclared and cross-project calls', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-runtime-scope-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'source.txt'), 'bound source');
  fs.writeFileSync(path.join(directory, 'outside.txt'), 'other project');
  fs.writeFileSync(path.join(directory, 'config.toml'), 'default_model = "industrial"\n');
  const bound = createProjectRuntime({
    projectDir: project,
    domain: 'chip',
    directory: path.join(directory, 'store'),
    environment: { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config') },
  });
  t.after(async () => {
    await bound.runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(resourceCatalog('chip').mcpServers, []);
  assert.deepEqual(resourceCatalog('pcb').mcpServers, []);
  const state = await bound.runtime.inspect();
  const scope = resolveFromState({ task: 'read project files', state }, bound.capabilities).scope;
  assert.ok(scope.tools.includes('project.files.read'));
  assert.deepEqual(selectMcpServers(scope), []);
  const session = prepareSessionFiles(
    scope,
    { shareDir: directory, disabledMcpServers: [] },
    undefined,
    project,
  );
  t.after(() => fs.rmSync(session, { recursive: true, force: true }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session, 'mcp.json'))).mcpServers, {});
  const call = (request = {}, policy = {}) =>
    bound.runtime.execute(
      {
        schemaVersion: '1',
        projectId: state.projectId,
        domain: 'chip',
        toolId: 'project.files.read',
        expectedStateId: state.id,
        inputs: { path: 'source.txt' },
        ...request,
      },
      { scope, ...policy },
    );
  const allowed = await call();
  assert.equal(allowed.action.status, 'completed');
  assert.ok(allowed.artifacts.length > 0);
  const cases = [
    [{ toolId: 'chip.eda.execute', inputs: { action: 'rtl.simulate' } }, {}, /outside.*scope/],
    [{}, { scope: { ...scope, projectId: 'a'.repeat(64) } }, /different.*project/],
    [{ projectId: 'b'.repeat(64) }, {}, /different.*project/],
    [{ inputs: { path: '../outside.txt' } }, {}, /path|project/i],
    [{ expectedStateId: crypto.randomUUID() }, {}, /stale/],
    [
      {
        toolId: 'project.files.apply',
        inputs: {
          changes: [
            {
              path: 'source.txt',
              content: 'unauthorized',
              expectedSha256: state.inputHashes['source.txt'],
            },
          ],
        },
      },
      { scope: { ...scope, tools: [...scope.tools, 'project.files.apply'] } },
      /approval/,
    ],
  ];
  for (const [request, policy, diagnostic] of cases) {
    const result = await call(request, policy);
    assert.equal(result.action.status, 'failed');
    assert.equal(result.verification.status, 'insufficient_evidence');
    assert.match(result.action.diagnostics.join('\n'), diagnostic);
  }
  assert.equal(fs.readFileSync(path.join(project, 'source.txt'), 'utf8'), 'bound source');
  assert.equal(fs.readFileSync(path.join(directory, 'outside.txt'), 'utf8'), 'other project');
});
