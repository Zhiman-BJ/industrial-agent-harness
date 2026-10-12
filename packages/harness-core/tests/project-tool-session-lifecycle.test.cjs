const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Project Runtime closes Pack-created idle sessions before reopening the same persistent project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-session-scope-'));
  const project = path.join(root, 'project'),
    pack = path.join(root, 'pack');
  fs.mkdirSync(project);
  fs.mkdirSync(pack);
  fs.writeFileSync(
    path.join(pack, 'index.cjs'),
    `exports.createRuntimePlugin=({runtimeApi})=>{
    let session;
    return {stateProvider:()=>({stage:null,inputHashes:{}}),tools:[{
      descriptor:{schemaVersion:'1',id:'example.status',version:'1',risk:'read-only',verification:[]},
      execute:async()=>{session ||= await runtimeApi.openToolSession({}); await session.callTool(); return {executionSucceeded:true,artifacts:[]};}
    }]};
  };`,
  );
  const backend = require('../../domain-runtime/src/index.cjs');
  let held = false,
    starts = 0,
    closes = 0;
  t.mock.method(backend, 'openToolSession', async () => {
    assert.equal(held, false, 'The old project session must release its workspace ownership.');
    held = true;
    starts++;
    return {
      callTool: async () => {},
      close: async () => {
        held = false;
        closes++;
      },
    };
  });
  delete require.cache[require.resolve('../src/project-runtime.cjs')];
  const { createProjectRuntime } = require('../src/project-runtime.cjs');
  let view;
  t.after(async () => {
    await view?.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = () =>
    createProjectRuntime({
      projectDir: project,
      domain: 'example',
      directory: path.join(root, 'state'),
      environment: { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') },
      registry: {
        runtimePacks: [{ domain: 'example', directory: pack, runtime: { entry: 'index.cjs' } }],
      },
    });
  const call = async () => {
    const state = await view.runtime.inspect();
    const result = await view.runtime.execute(
      { toolId: 'example.status', inputs: {}, expectedStateId: state.id },
      {
        scope: {
          domain: 'example',
          projectId: state.projectId,
          stateId: state.id,
          tools: ['example.status'],
        },
      },
    );
    assert.equal(result.action.status, 'completed', JSON.stringify(result.action));
  };
  view = open();
  await call();
  assert.equal(held, true);
  await view.runtime.close();
  assert.equal(held, false);
  assert.equal(closes, 1);
  view = open();
  await call();
  assert.equal(starts, 2);
  await view.runtime.close();
  assert.equal(held, false);
  assert.equal(closes, 2);
});
