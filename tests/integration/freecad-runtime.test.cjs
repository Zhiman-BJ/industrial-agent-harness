const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectRuntime } = require('../../packages/harness-core/src/project-runtime.cjs');
const { createCadPlugins } = require('../../packages/viewer-builtin/src/cad/service.cjs');
const { createViewerRegistry } = require('../../packages/viewer-core/src/registry.cjs');
const { hash } = require('../../packages/viewer-builtin/src/engineering/read.cjs');
const { execFileSync } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const crypto = require('node:crypto');
const execute = promisify(execFile);
const repo = path.resolve(__dirname, '../..');
if (!process.env.INDUSTRIAL_HARNESS_FREECAD_CMD)
  throw Error('Native FreeCAD suite requires pinned FreeCAD 1.1.4; tests cannot be skipped.');
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-freecad-e2e-')));
  const { runtime } = createProjectRuntime({ projectDir: dir, domain: 'cad' });
  t.after(() => {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, runtime };
}
const { call, plate } = require('./fixtures/freecad.cjs');
test(
  'native FreeCAD constrained sketch, pad and hole persist independent geometry evidence and real viewer artifacts',
  { timeout: 150000 },
  async t => {
    const { dir, runtime } = setup(t);
    const out = await call(runtime, 'build', {
      recipe: plate,
      expect: { volume: 4000 - 20 * Math.PI, solids: 1, bounds: [40, 20, 5] },
    });
    assert.equal(out.verification.status, 'passed', JSON.stringify(out.action));
    assert.equal(out.state.status, 'verified');
    assert.equal(out.verification.metrics.sketchesConstrained, true);
    const native = out.artifacts.find(a => a.kind === 'model.cad.fcstd');
    const preview = out.artifacts.find(a => a.kind === 'display.cad.sketches');
    const sketches = JSON.parse(fs.readFileSync(path.join(dir, preview.relativePath)));
    assert.equal(sketches.sourceSha256, native.sha256);
    assert.equal(sketches.sketches[0].geometry.length, 4);
    assert.deepEqual(sketches.sketches[0].geometry[0].end, [40, 0]);
    assert.equal(sketches.sketches[0].fullyConstrained, true);
    assert.deepEqual(
      sketches.sketches[0].constraints.filter(c => c.type === 'Distance').map(c => c.value),
      [40, 20],
    );
    const actionDir = path.dirname(path.join(dir, native.relativePath));
    for (const kind of ['report.cad.build', 'report.cad.readback']) {
      const artifact = out.artifacts.find(a => a.kind === kind);
      const report = JSON.parse(fs.readFileSync(path.join(dir, artifact.relativePath)));
      assert.equal(Object.keys(report.runtimePaths).length, 5);
      for (const location of Object.values(report.runtimePaths)) {
        const relative = path.relative(actionDir, fs.realpathSync(location));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), location);
      }
    }
    const registry = createViewerRegistry(createCadPlugins({ projectRoot: () => dir }));
    const file = path.join(dir, native.relativePath);
    const opened = await registry
      .get(registry.match(file))
      .open({ file, artifact: { id: native.id, name: 'model.FCStd', sha256: native.sha256 } });
    assert.equal(opened.kind, 'cad');
    assert.equal(opened.data.sketches[0].constraints.length, 11);
    assert.ok(opened.data.triangles > 20);
    const exported = await call(runtime, 'export', {
      file: native.relativePath,
      expect: { volume: 4000 - 20 * Math.PI, solids: 1 },
    });
    assert.equal(exported.verification.status, 'passed', JSON.stringify(exported.action));
    const step = exported.artifacts.find(a => a.kind === 'model.cad.step');
    const inspected = await call(runtime, 'inspect', {
      file: step.relativePath,
      expect: { solids: 1 },
    });
    assert.equal(inspected.verification.status, 'passed', JSON.stringify(inspected.action));
    assert.equal(runtime.listActions().length, 3);
    assert.equal(runtime.listVerifications().length, 3);
    assert.ok(runtime.latestCheckpoint());
  },
);
test(
  'native FreeCAD boolean fuse, cut and common preserve analytic volume',
  { timeout: 150000 },
  async t => {
    const { runtime } = setup(t);
    const recipe = {
      features: [
        { id: 'A', op: 'box', length: 10, width: 10, height: 5 },
        { id: 'B', op: 'box', length: 10, width: 10, height: 5, origin: [5, 0, 0] },
        { id: 'C', op: 'common', base: 'A', tool: 'B' },
        { id: 'D', op: 'cut', base: 'A', tool: 'B' },
        { id: 'E', op: 'fuse', base: 'D', tool: 'C' },
      ],
      result: 'E',
    };
    const out = await call(runtime, 'build', {
      recipe,
      expect: { volume: 500, solids: 1, bounds: [10, 10, 5] },
    });
    assert.equal(out.verification.status, 'passed', JSON.stringify(out.action));
  },
);
test(
  'native FreeCAD circular sketch placement and wrong dimensional expectation are evaluated on readback',
  { timeout: 150000 },
  async t => {
    const { runtime } = setup(t);
    const recipe = {
      features: [
        {
          id: 'Round',
          op: 'sketch_pad',
          profile: 'circle',
          radius: 3,
          height: 10,
          origin: [10, 20, 0],
        },
      ],
      result: 'Round',
    };
    const out = await call(runtime, 'build', {
      recipe,
      expect: { volume: 90 * Math.PI, bounds: [6, 6, 10] },
    });
    assert.equal(out.verification.status, 'passed', JSON.stringify(out.action));
    const bad = await call(runtime, 'build', { recipe, expect: { volume: 42 } });
    assert.equal(bad.action.status, 'completed');
    assert.equal(bad.verification.status, 'failed');
    assert.equal(bad.state.status, 'failed');
    assert.equal(bad.verification.metrics.expectedVolume, false);
  },
);
test('CAD rejected approvals, stale scopes and invalid recipes leave durable failures without engineering acceptance', async t => {
  const { dir, runtime } = setup(t);
  const denied = await call(runtime, 'build', { recipe: plate }, { approval: false });
  assert.equal(denied.action.status, 'failed');
  assert.deepEqual(denied.artifacts, []);
  assert.equal(fs.existsSync(path.join(dir, 'cad-output')), false);
  const out = await call(runtime, 'build', { recipe: { ...plate, script: 'import os' } });
  assert.equal(out.action.status, 'failed');
  assert.deepEqual(out.artifacts, []);
  const state = await runtime.inspect();
  fs.writeFileSync(path.join(dir, 'new.step'), 'changed');
  const stale = await runtime.execute(
    { toolId: 'cad.freecad.build', inputs: { recipe: plate }, expectedStateId: state.id },
    {
      scope: {
        domain: 'cad',
        projectId: state.projectId,
        stateId: state.id,
        tools: ['cad.freecad.build'],
      },
      approval: true,
    },
  );
  assert.equal(stale.action.status, 'failed');
  assert.match(stale.verification.reason, /stale/);
  assert.equal(runtime.listActions().length, 3);
});
test(
  'CAD malicious FCStd proxies and escaped input paths fail visibly',
  { timeout: 150000 },
  async t => {
    const { dir, runtime } = setup(t);
    const file = path.join(dir, 'proxy.FCStd');
    execFileSync('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("Document.xml",\'<Document><Objects><Object type="Part::FeaturePython" name="Exploit"/></Objects></Document>\'); z.close()',
      file,
    ]);
    const bad = await call(runtime, 'inspect', { file: 'proxy.FCStd' });
    assert.equal(bad.verification.status, 'insufficient_evidence');
    assert.ok(bad.artifacts.some(a => a.kind === 'diagnostic.cad'));
    const escaped = await call(runtime, 'inspect', { file: '../outside.step' });
    assert.equal(escaped.action.status, 'failed');
    assert.match(escaped.verification.reason, /project-relative/);
  },
);
test(
  'FreeCAD native cancellation closes the owned process group and cannot claim acceptance',
  { timeout: 150000 },
  async t => {
    const { runtime } = setup(t);
    const execution = call(runtime, 'build', { recipe: plate });
    const timer = setTimeout(() => runtime.cancel(), 50);
    const out = await execution;
    clearTimeout(timer);
    assert.equal(out.action.status, 'failed');
    assert.notEqual(out.verification.status, 'passed');
    assert.equal(runtime.executing, false);
  },
);
test(
  'shared CAD TaskService and pinned Kimi progressively describe then execute an approved FreeCAD recipe',
  { timeout: 150000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cad-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const native =
      process.env.KIMI_EXECUTABLE ||
      require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();
    assert.ok(fs.existsSync(native), 'Pinned Kimi is required; this test cannot be skipped.');
    const fixture = await startModel({
      success: 'CAD_GEOMETRY_RECORDED',
      calls: body => {
        const id = JSON.stringify(body.messages).match(/expectedStateId=([a-f0-9-]{36})/)?.[1];
        assert.ok(id);
        return [
          { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.build' } },
          {
            name: 'industrial_action_call',
            arguments: {
              toolId: 'cad.freecad.build',
              inputs: { recipe: plate, expect: { volume: 4000 - 20 * Math.PI, solids: 1 } },
              expectedStateId: id,
            },
          },
        ];
      },
    });
    t.after(fixture.close);
    const resources = path.join(directory, 'resources');
    fs.mkdirSync(resources);
    const marker = path.join(directory, 'host-service-started');
    const trap = path.join(directory, 'trap.cjs');
    fs.writeFileSync(trap, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`);
    const {
      toolSnapshot,
      hash: surfaceHash,
    } = require('../../packages/domain-mcp/src/external-client.cjs');
    const hostTools = toolSnapshot('external.native-trap', [
      {
        name: 'call',
        description: 'Registered host service must remain idle unless explicitly called',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    fs.writeFileSync(
      path.join(resources, 'external-mcp.json'),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: 'external.native-trap',
            title: 'Trap',
            revision: crypto.randomUUID(),
            checkedAt: new Date().toISOString(),
            config: {
              transport: 'stdio',
              command: process.execPath,
              args: [trap],
              cwd: fs.realpathSync(project),
              env: {},
              envRefs: {},
            },
            tools: hostTools,
            surfaceHash: surfaceHash(hostTools),
          },
        ],
      }),
    );
    const result = await execute(
      process.execPath,
      taskArguments({
        projectDir: project,
        domain: 'cad',
        task: 'FreeCAD 3D 参数化草图拉伸打孔零件建模',
        approval: 'approve',
        provider: 'openai_legacy',
        endpoint: fixture.endpoint,
        model: 'controlled-cad',
        thinking: false,
        kimiExecutable: native,
        timeoutMs: 90000,
        chatDir: path.join(directory, 'chats'),
        stateDir: path.join(directory, 'state'),
        logDir: path.join(directory, 'logs'),
      }),
      {
        cwd: repo,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'local-cad-fixture-key',
          INDUSTRIAL_HARNESS_CONFIG_DIR: resources,
        },
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const rows = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).status, 'finished', result.stderr + result.stdout);
    const engineering = rows.find(row => row.type === 'industrial_result');
    assert.ok(engineering);
    assert.equal(engineering.verification.status, 'passed', JSON.stringify(engineering));
    assert.ok(JSON.stringify(fixture.requests).includes('sketch_pad'));
    assert.equal(rows.at(-1).engineering.checkpointId, engineering.checkpoint.id);
    assert.equal(fs.existsSync(marker), false, 'An unused registered host MCP must not start');
    assert.ok(rows.find(r => r.type === 'scope').scope.tools.includes(hostTools[0].id));
    assert.ok(rows.find(r => r.type === 'scope').trace.some(t => t.event === 'mcp.external.scope'));
    assert.ok(JSON.stringify(fixture.requests).includes('external_tool_call'));
  },
);
test(
  'existing part tasks change width and outline in new versions, preserve originals and reject forged recipes',
  { timeout: 150000 },
  async t => {
    const { dir, runtime } = setup(t);
    const first = await call(runtime, 'build', {
      recipe: plate,
      expect: { bounds: [40, 20, 5], volume: 4000 - 20 * Math.PI },
    });
    assert.equal(first.verification.status, 'passed');
    const native = first.artifacts.find(a => a.kind === 'model.cad.fcstd');
    const original = hash(fs.readFileSync(path.join(dir, native.relativePath)));
    const wider = await call(runtime, 'edit', {
      file: native.relativePath,
      changes: { parameters: { W: 30, R: 3 } },
      expect: { bounds: [40, 30, 5], volume: 6000 - 45 * Math.PI, solids: 1 },
    });
    assert.equal(wider.verification.status, 'passed', JSON.stringify(wider));
    assert.notEqual(wider.artifacts.find(a => a.kind === 'model.cad.fcstd').sha256, native.sha256);
    assert.equal(hash(fs.readFileSync(path.join(dir, native.relativePath))), original);
    const previous = wider.artifacts.find(a => a.kind === 'model.cad.fcstd');
    const shape = await call(runtime, 'edit', {
      file: previous.relativePath,
      changes: {
        features: [
          { id: 'Plate', profile: 'circle', radius: 20 },
          { id: 'Drilled', origin: [0, 0, 0] },
        ],
      },
      expect: { bounds: [40, 40, 5], volume: 1955 * Math.PI, solids: 1 },
    });
    assert.equal(shape.verification.status, 'passed', JSON.stringify(shape));
    assert.equal(shape.verification.metrics.sketchesConstrained, true);
    assert.equal(hash(fs.readFileSync(path.join(dir, native.relativePath))), original);
    assert.equal(hash(fs.readFileSync(path.join(dir, previous.relativePath))), previous.sha256);
    const recipePath = path.join(dir, path.dirname(native.relativePath), 'model.recipe.json');
    fs.writeFileSync(recipePath, JSON.stringify({ ...plate, parameters: { W: 999 } }));
    const forged = await call(runtime, 'edit', {
      file: native.relativePath,
      changes: { parameters: { W: 25 } },
    });
    assert.equal(forged.action.status, 'failed');
    assert.match(forged.verification.reason, /hashes changed/);
  },
);
test(
  'real Kimi chat resumes an existing CAD part modification and records independent acceptance',
  { timeout: 150000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-chat-tasks-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const native = process.env.KIMI_EXECUTABLE;
    assert.ok(native && fs.existsSync(native), 'Pinned Kimi required');
    const fixture = await startModel({
      success: 'CAD_TASK_FINISHED',
      calls: body => {
        const text = JSON.stringify(body.messages);
        const id = [...text.matchAll(/expectedStateId=([a-f0-9-]{36})/g)].at(-1)?.[1];
        assert.ok(id);
        const follow = text.includes('把宽度改成30');
        const file = text.match(/cad-output\/[a-f0-9-]{36}\/model.FCStd/)?.[0];
        return follow
          ? [
              null,
              null,
              { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.edit' } },
              {
                name: 'industrial_action_call',
                arguments: {
                  toolId: 'cad.freecad.edit',
                  inputsJson: JSON.stringify({
                    file,
                    changes: { parameters: { W: 30, R: 3 } },
                    expect: { bounds: [40, 30, 5], volume: 6000 - 45 * Math.PI, solids: 1 },
                  }),
                  expectedStateId: id,
                },
              },
            ]
          : [
              { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.build' } },
              {
                name: 'industrial_action_call',
                arguments: {
                  toolId: 'cad.freecad.build',
                  inputs: { recipe: plate, expect: { bounds: [40, 20, 5], solids: 1 } },
                  expectedStateId: id,
                },
              },
            ];
      },
    });
    t.after(fixture.close);
    const env = {
      ...process.env,
      OPENAI_API_KEY: 'local-cad-task-fixture',
      INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
    };
    async function prompt(task, chatId) {
      const args = taskArguments({
        projectDir: project,
        domain: 'cad',
        task,
        approval: 'approve',
        provider: 'openai_legacy',
        endpoint: fixture.endpoint,
        model: 'controlled-cad-task',
        thinking: false,
        kimiExecutable: native,
        timeoutMs: 90000,
        chatDir: path.join(directory, 'chats'),
        stateDir: path.join(directory, 'state'),
        logDir: path.join(directory, 'logs'),
        chatId,
      });
      const result = await execute(process.execPath, args, {
        cwd: repo,
        env,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const rows = result.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).status, 'finished', result.stdout);
      return rows;
    }
    const first = await prompt('创建带孔安装板 FreeCAD 零件');
    const model = first
      .find(r => r.type === 'industrial_result')
      .artifacts.find(a => a.kind === 'model.cad.fcstd');
    const before = hash(fs.readFileSync(path.join(project, model.relativePath)));
    const second = await prompt(
      '继续把宽度改成30毫米、孔半径改成3毫米，保留原模型，创建新版本并验证',
      first.at(-1).chatId,
    );
    assert.equal(second.at(-1).chatId, first.at(-1).chatId);
    const result = second.find(r => r.type === 'industrial_result');
    assert.ok(result, 'Follow-up must actually call the native Runtime');
    assert.equal(result.action.toolId, 'cad.freecad.edit');
    assert.equal(result.verification.status, 'passed');
    assert.equal(result.verification.metrics.boundsY, 30);
    assert.equal(result.verification.metrics.expectedVolume, true);
    assert.equal(hash(fs.readFileSync(path.join(project, model.relativePath))), before);
  },
);
