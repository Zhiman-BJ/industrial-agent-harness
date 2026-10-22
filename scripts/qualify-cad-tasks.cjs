// Opt-in inference qualification: real model + pinned Kimi + native FreeCAD.
// Every scenario independently asserts measurable outputs, rather than trusting text.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { runTask: run } = require('../tests/integration/fixtures/task-service-process.cjs');
const { createProjectRuntime } = require('../packages/harness-core/src/project-runtime.cjs');
async function qualify({ directory, profile, apiKey }) {
  if (!apiKey) throw Error('Real CAD task qualification requires a model API key.');
  fs.mkdirSync(directory, { recursive: true });
  const project = path.join(directory, 'project');
  if (fs.existsSync(project)) throw Error('Use a fresh qualification directory.');
  fs.mkdirSync(project);
  const { runtime } = createProjectRuntime({ projectDir: project, domain: 'cad' });
  const recipe = {
    parameters: { Length: 40, Width: 20, Thickness: 5, HoleRadius: 2 },
    features: [
      {
        id: 'Plate',
        op: 'sketch_pad',
        profile: 'rectangle',
        length: 'Length',
        width: 'Width',
        height: 'Thickness',
      },
      {
        id: 'Drilled',
        op: 'hole',
        base: 'Plate',
        radius: 'HoleRadius',
        height: 'Thickness',
        origin: [10, 10, 0],
      },
    ],
    result: 'Drilled',
  };
  try {
    const state = await runtime.inspect();
    const out = await runtime.execute(
      {
        toolId: 'cad.freecad.build',
        inputs: { recipe, expect: { bounds: [40, 20, 5], volume: 4000 - 20 * Math.PI } },
        expectedStateId: state.id,
      },
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
    assert.equal(out.verification.status, 'passed');
    for (const name of [
      'model.FCStd',
      'model.step',
      'model.stl',
      'model.brep',
      'model.recipe.json',
      'model.cad-preview.json',
    ]) {
      const artifact = out.artifacts.find(a => path.basename(a.relativePath) === name);
      fs.copyFileSync(path.join(project, artifact.relativePath), path.join(project, name));
    }
  } finally {
    runtime.close();
  }
  const scenarios = [
    {
      id: 'ambiguous-shape',
      task: '修改零件的形状',
      mutations: false,
    },
    {
      id: 'wider-plate',
      task: '把工程根目录 model.FCStd 的安装板宽度从20改成30毫米，长度40、厚度5和孔位置(10,10)不变，孔半径从2改成3毫米。保留原件，输出新版本，并独立验证边界[40,30,5]和体积6000-45π mm³。',
      bounds: [40, 30, 5],
      volume: 6000 - 45 * Math.PI,
    },
    {
      id: 'round-outline',
      task: '继续把刚刚的新版本外轮廓改成半径20毫米的圆板，厚度5毫米，孔半径3毫米，并把孔移到圆心(0,0)。保留原件和上一版本，创建新版本并验证体积6141.813637768046 mm³（1955π）、边界[40,40,5]、一个实体。',
      bounds: [40, 40, 5],
      volume: 1955 * Math.PI,
    },
  ];
  fs.writeFileSync(
    path.join(project, 'README.md'),
    'Bounded CAD task qualification. Root model.FCStd has a hash-bound model.recipe.json. Use industrial_tool_describe and industrial_action_call. Read actual recipe parameters/features before editing. Preserve original and historical versions. Unknown shape intent requires clarification.\n',
  );
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const history = new Map([['model.FCStd', digest(path.join(project, 'model.FCStd'))]]);
  const report = {
    schemaVersion: 1,
    model: profile.model,
    provider: profile.provider,
    scenarios: [],
  };
  let chatId;
  for (const scenario of scenarios) {
    const rows = [];
    const started = Date.now();
    const options = {
      command: 'run',
      projectDir: project,
      domain: 'cad',
      task: scenario.task,
      provider: profile.provider,
      endpoint: profile.endpoint,
      model: profile.model,
      contextSize: profile.contextSize,
      thinking: profile.thinking,
      approval: 'approve',
      apiKeyEnv: 'HARNESS_CAD_EVAL_KEY',
      kimiExecutable: process.env.KIMI_EXECUTABLE,
      timeoutMs: '180000',
      chatDir: path.join(directory, 'chats'),
      stateDir: path.join(directory, 'state'),
      logDir: path.join(directory, 'logs'),
      chatId,
      disabledSkills: [],
      disabledMcpServers: [],
    };
    const env = {
      ...process.env,
      HARNESS_CAD_EVAL_KEY: apiKey,
      INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
    };
    const code = await run(
      options,
      {
        write: text => {
          for (const line of text.trim().split('\n')) if (line) rows.push(JSON.parse(line));
        },
      },
      env,
    );
    fs.writeFileSync(
      path.join(directory, scenario.id + '.jsonl'),
      rows.map(r => JSON.stringify(r)).join('\n') + '\n',
    );
    const result = rows.findLast(r => r.type === 'result');
    chatId = result?.chatId;
    const actions = rows.filter(r => r.type === 'industrial_result');
    const entry = {
      id: scenario.id,
      prompt: scenario.task,
      status: 'failed',
      elapsedMs: Date.now() - started,
      exitCode: code,
      result: result?.status,
      actions: actions.map(a => ({
        actionId: a.action.id,
        toolId: a.action.toolId,
        verification: a.verification.status,
        metrics: a.verification.metrics,
      })),
    };
    try {
      if (scenario.mutations === false) {
        assert.ok(
          (code === 0 && result?.status === 'finished') ||
            (code === 2 && result?.status === 'needs_input'),
          'Clarification did not finish or suspend cleanly',
        );
        assert.ok(
          actions.every(a => a.action.toolId === 'cad.freecad.inspect'),
          'Ambiguous request must not change the shape',
        );
        assert.ok(
          rows.some(r => r.event?.type === 'question') ||
            rows
              .filter(r => r.event?.type === 'text')
              .map(r => r.event.text)
              .join('')
              .includes('？'),
          'Agent did not ask for clarification',
        );
      } else {
        assert.equal(code, 0, 'CLI did not finish successfully');
        assert.equal(result?.status, 'finished');
        const action = actions.findLast(a => a.verification.status === 'passed');
        assert.ok(action, 'No independently verified CAD result');
        assert.ok(
          Math.abs(action.verification.metrics.volume - scenario.volume) < 1e-5,
          'Wrong resulting volume',
        );
        for (const [i, axis] of ['X', 'Y', 'Z'].entries())
          assert.ok(
            Math.abs(action.verification.metrics['bounds' + axis] - scenario.bounds[i]) < 1e-5,
            'Wrong resulting bounds',
          );
        assert.equal(action.verification.metrics.solids, 1, 'Expected exactly one solid');
        assert.ok(
          action.artifacts.some(a => a.kind === 'display.cad.brep'),
          'Missing OCCT shape',
        );
      }
      for (const [file, expected] of history)
        assert.equal(
          digest(path.join(project, file)),
          expected,
          'Historical model was overwritten: ' + file,
        );
      for (const action of actions)
        if (action.verification.status === 'passed')
          for (const artifact of action.artifacts)
            if (/\.FCStd$/i.test(artifact.relativePath)) {
              assert.equal(
                digest(path.join(project, artifact.relativePath)),
                artifact.sha256,
                'Saved model differs from verified artifact',
              );
              history.set(artifact.relativePath, artifact.sha256);
            }
      entry.preservedModels = history.size;
      entry.status = 'passed';
    } catch (error) {
      entry.reason = error.message;
    }
    report.scenarios.push(entry);
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(entry));
    if (entry.status !== 'passed') break;
  }
  if (
    report.scenarios.length !== scenarios.length ||
    report.scenarios.some(s => s.status !== 'passed')
  )
    throw Error(
      'Real CAD task qualification failed; inspect report.json and preserved diagnostics.',
    );
  return report;
}
module.exports = { qualify };
if (require.main === module) {
  qualify({
    directory: path.resolve(process.argv[2] || 'dist/cad-task-qualification'),
    profile: JSON.parse(process.env.HARNESS_CAD_EVAL_PROFILE || '{}'),
    apiKey: process.env.HARNESS_CAD_EVAL_KEY,
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
