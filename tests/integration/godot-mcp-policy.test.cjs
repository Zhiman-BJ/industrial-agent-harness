const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const mcpRequire = createRequire(path.resolve(__dirname, '../../packages/domain-mcp/package.json'));
const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');
const {
  resolveProjectTask,
  resourceCatalog,
  ResourceSettings,
} = require('../../packages/harness-core/src/index.cjs');
const {
  selectMcpServers,
  writeMcpConfig,
  listMcpServers,
} = require('../../packages/domain-mcp/src/index.cjs');
const { materializeSkills } = require('../../packages/domain-skills/src/index.cjs');
const { ActionJournal } = require('../../packages/domain-runtime/src/index.cjs');
const { prepareSessionFiles } = require('../../packages/agent-kimi/src/index.cjs');
const repo = path.resolve(__dirname, '../..');
const legacy = require(
  path.join(
    require('@zhiman-bj/industrial-domain-packs').sourceDirectory('godot-pack'),
    'legacy-harness-pack.json',
  ),
);
const legacyResolve = (domain, request) =>
  resolveProjectTask(domain, request, undefined, legacy.capabilities);

const json = result => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-godot-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function fakeGodot(dir) {
  const file = path.join(dir, 'godot');
  fs.writeFileSync(
    file,
    `#!${process.execPath}\nconst fs=require('fs');\nif (process.argv.includes('--version')) {console.log('4.4.1.stable.fixture'); process.exit(0);}\nif (process.argv.includes('--script')) console.log('HARNESS_SCENE_JSON:'+JSON.stringify({ok:true,scene:process.argv.at(-1),nodes:[{path:'.',type:'Node2D',properties:{}}]}));\nif (process.argv.includes('--import') && fs.existsSync(${JSON.stringify(path.join(dir, 'engine-error'))})) console.error('ERROR: Fixture parse problem');\n`,
    { mode: 0o700 },
  );
  return file;
}

async function connect(t, root, project, scope) {
  const configFile = writeMcpConfig(
    root,
    selectMcpServers(
      scope,
      [],
      [{ ...legacy.provider, toolIds: legacy.provider.tools.map(t => t.id) }],
    ),
    {
      projectDir: project,
      environment: {
        ...process.env,
        INDUSTRIAL_HARNESS_GODOT_BIN: fakeGodot(root),
        INDUSTRIAL_HARNESS_ACTION_DIR: path.join(root, 'actions'),
      },
    },
  );
  const config = JSON.parse(fs.readFileSync(configFile)).mcpServers['godot.local'];
  const client = new Client({ name: 'godot-policy-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ ...config, stderr: 'pipe' }));
  return client;
}

test('Godot product disclosure uses versioned structural Runtime Actions and no legacy native MCP', t => {
  const scope = resolveProjectTask('godot', { task: 'Godot scene edit' }).scope;
  assert.deepEqual(scope.tools, ['godot.scene.edit', 'godot.scene.verify']);
  assert.deepEqual(selectMcpServers(scope), []);
  const catalog = resourceCatalog('godot');
  const provider = catalog.mcpServers.find(item => item.id === 'godot.local');
  assert.equal(provider.transport, 'runtime');
  assert.deepEqual(provider.toolIds, scope.tools);
  assert.deepEqual(listMcpServers('godot'), []);
  const root = temporary(t);
  const directory = materializeSkills(scope, root);
  assert.ok(
    fs
      .readFileSync(path.join(directory, 'godot-game-develop/SKILL.md'), 'utf8')
      .includes('independent'),
  );
  assert.ok(!scope.tools.some(id => id.startsWith('godot.game.')));
  const settings = new ResourceSettings(path.join(root, 'settings'));
  settings.set(catalog, { kind: 'mcp', id: provider.id, mode: 'disabled' });
  assert.deepEqual(
    resolveProjectTask(
      'godot',
      { task: 'Godot scene edit' },
      undefined,
      undefined,
      settings.snapshot(catalog, root).effective,
    ).scope.tools,
    [],
  );
});

test(
  'standalone frozen Godot MCP transport enforces scope and arguments, records native actions, and preserves failed checks',
  { timeout: 30000 },
  async t => {
    const root = temporary(t),
      project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, 'project.godot'),
      'config_version=5\n[application]\nconfig/name="Fixture"\n',
    );
    fs.writeFileSync(
      path.join(project, 'main.tscn'),
      '[gd_scene format=3]\n[node name="Main" type="Node2D"]\nposition = Vector2(1, 2)\n',
    );
    const inspect = legacyResolve('godot', {
      task: 'Inspect scene tree and scene properties',
    }).scope;
    const client = await connect(t, root, project, inspect);
    assert.deepEqual(
      (await client.listTools()).tools.map(row => row.name),
      ['domain_tool_list', 'domain_tool_describe', 'domain_tool_call', 'domain_tool_result_read'],
    );
    const listed = json(await client.callTool({ name: 'domain_tool_list', arguments: {} }));
    assert.deepEqual(
      listed.tools.map(row => row.toolId),
      inspect.tools,
    );
    assert.equal(
      (
        await client.callTool({
          name: 'domain_tool_describe',
          arguments: { toolId: 'godot.game.run_scene' },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: 'domain_tool_call',
          arguments: {
            toolId: 'godot.game.run_scene',
            arguments: { scenePath: 'main.tscn', frames: 1 },
          },
        })
      ).isError,
      true,
    );
    const source = json(
      await client.callTool({
        name: 'domain_tool_call',
        arguments: {
          toolId: 'godot.game.inspect_scene_source',
          arguments: { scenePath: 'main.tscn' },
        },
      }),
    );
    assert.equal(source.result.sections[1].properties.position, 'Vector2(1, 2)');
    assert.equal(
      (
        await client.callTool({
          name: 'domain_tool_call',
          arguments: {
            toolId: 'godot.game.inspect_scene_source',
            arguments: { scenePath: '../outside.tscn' },
          },
        })
      ).isError,
      true,
    );
    const outside = path.join(root, 'outside.tscn');
    fs.writeFileSync(outside, '[gd_scene format=3]\n');
    fs.symlinkSync(outside, path.join(project, 'escape.tscn'));
    assert.equal(
      (
        await client.callTool({
          name: 'domain_tool_call',
          arguments: {
            toolId: 'godot.game.inspect_scene_source',
            arguments: { scenePath: 'escape.tscn' },
          },
        })
      ).isError,
      true,
    );
    const full = legacyResolve('godot', { task: 'Build a Godot game scene' }).scope;
    const fullClient = await connect(t, root, project, full);
    const observed = json(
      await fullClient.callTool({
        name: 'domain_tool_call',
        arguments: {
          toolId: 'godot.game.inspect_scene_runtime',
          arguments: { scenePath: 'main.tscn' },
        },
      }),
    );
    assert.equal(observed.result.observation.nodes[0].type, 'Node2D');
    const imported = json(
      await fullClient.callTool({
        name: 'domain_tool_call',
        arguments: { toolId: 'godot.game.check_project', arguments: {} },
      }),
    );
    assert.equal(imported.result.importStatus, 'PASS');
    fs.writeFileSync(path.join(root, 'engine-error'), '1');
    const failedImport = json(
      await fullClient.callTool({
        name: 'domain_tool_call',
        arguments: { toolId: 'godot.game.check_project', arguments: {} },
      }),
    );
    assert.equal(failedImport.result.importStatus, 'FAIL');
    assert.match(failedImport.result.diagnostics[0], /Fixture parse problem/);
    fs.rmSync(path.join(root, 'engine-error'));
    const played = json(
      await fullClient.callTool({
        name: 'domain_tool_call',
        arguments: {
          toolId: 'godot.game.run_scene',
          arguments: { scenePath: 'main.tscn', frames: 2 },
        },
      }),
    );
    assert.equal(played.result.executionStatus, 'completed');
    assert.equal(played.result.engineeringAcceptance, 'not_run');
    assert.deepEqual(played.result.artifactSet, []);
    assert.equal(played.result.verificationResult.status, 'not_run');
    assert.equal(played.result.actionStatus, 'completed');
    assert.equal(played.result.artifactCoverage, 'not_enumerated');
    const receipts = fs.readdirSync(path.join(root, 'mcp-godot.local-receipts'));
    assert.equal(receipts.length, 4);
    assert.ok(
      receipts.every(
        file =>
          (fs.statSync(path.join(root, 'mcp-godot.local-receipts', file)).mode & 0o777) === 0o600,
      ),
    );
    const journal = new ActionJournal(project, 'godot', { directory: path.join(root, 'actions') });
    assert.deepEqual(
      journal.list().map(item => item.status),
      ['completed', 'completed', 'failed', 'completed'],
    );
    journal.close();
  },
);
