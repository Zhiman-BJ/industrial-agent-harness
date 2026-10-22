const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startResultsModel } = require('./fixtures/task-results-model.cjs');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const execute = promisify(execFile);
if (!process.env.INDUSTRIAL_HARNESS_FREECAD_CMD) throw Error('Pinned native FreeCAD is required.');
test(
  'real pinned Kimi and authenticated MCP preserve results through consecutive native edits without a selection call',
  { timeout: 150000 },
  async t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-task-results-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const model = await startResultsModel();
    t.after(model.close);
    const root = path.resolve(__dirname, '../..');
    const { stdout } = await execute(
      process.execPath,
      taskArguments({
        projectDir: project,
        domain: 'cad',
        task: 'Create a FreeCAD plate, modify its width twice, then inspect the final model',
        provider: 'openai_legacy',
        endpoint: model.endpoint,
        model: 'controlled-results',
        thinking: false,
        approval: 'approve',
        chatDir: path.join(directory, 'chats'),
        stateDir: path.join(directory, 'state'),
        logDir: path.join(directory, 'logs'),
        timeoutMs: 120000,
      }),
      {
        cwd: root,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'controlled-results',
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
        },
        timeout: 140000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const rows = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).status, 'finished', stdout);
    const facts = rows.filter(row => row.type === 'industrial_result');
    assert.equal(facts.length, 4, stdout);
    assert.ok(
      facts.every(fact => fact.verification.status === 'passed'),
      JSON.stringify(
        facts.map(fact => ({ tool: fact.action.toolId, reason: fact.verification.reason })),
      ),
    );
    const readiness = rows.filter(row => row.type === 'results_ready').at(-1);
    assert.equal(readiness.autoPreviewEligible, true);
    const results = readiness.results;
    assert.equal(
      results.groups.filter(group => group.previewArtifactId && !group.superseded).length,
      1,
    );
    assert.equal(
      results.groups.filter(group => group.previewArtifactId && group.superseded).length,
      2,
    );
    assert.equal(results.selection, null);
    assert.ok(
      JSON.stringify(model.requests).includes('primaryArtifactId'),
      'host groups actually cross the existing MCP bridge into the model response',
    );
    assert.ok(model.requests[0].tools.some(tool => tool.function.name.endsWith('select_result')));
  },
);
