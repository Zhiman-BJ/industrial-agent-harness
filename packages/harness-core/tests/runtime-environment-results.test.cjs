const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectRuntime } = require('../src/project-runtime.cjs');
function fixture(t, { cancel = false, failPost = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-result-retention-')));
  const project = path.join(root, 'project'),
    packDir = path.join(root, 'pack');
  fs.mkdirSync(project);
  fs.mkdirSync(packDir);
  fs.writeFileSync(
    path.join(packDir, 'index.cjs'),
    `
    const fs = require('node:fs'), path = require('node:path');
    exports.createRuntimePlugin = () => ({tools:[{descriptor:{schemaVersion:'1',id:'fixture.verify',version:'1.0.0',risk:'mutating',verification:['fixture.result']},execute:async ({projectDir,signal})=>{
      if (${cancel}) await new Promise(resolve=>{ if(signal.aborted) resolve(); else signal.addEventListener('abort',resolve,{once:true}); });
      fs.mkdirSync(path.join(projectDir,'.harness'),{recursive:true});
      fs.writeFileSync(path.join(projectDir,'.harness','receipt.json'),'actual cleanup receipt');
      return {executionSucceeded:true,artifacts:[{file:'.harness/receipt.json',kind:'report.fixture'}],diagnostics:['cleanup confirmed']};
    }}],verifiers:{'fixture.result':({result})=>({status:'passed',reason:'native result retained',checks:{succeeded:result.executionSucceeded}})}});
  `,
  );
  let validations = 0;
  const registry = {
    capabilities: [],
    runtimePacks: [
      {
        domain: 'fixture',
        id: 'fixture-pack',
        version: '1.0.0',
        directory: packDir,
        runtime: { entry: 'index.cjs' },
        runtimeEnvironmentResolver: () => ({
          identity: 'a'.repeat(64),
          legacy: false,
          readyToolIds: ['fixture.verify'],
          environment: {},
        }),
        validateRuntimeEnvironment: async ({ signal } = {}) => {
          signal?.throwIfAborted();
          if (++validations > 1 && failPost)
            throw Error('Application changed after native execution');
        },
      },
    ],
  };
  const bundle = createProjectRuntime({
    projectDir: project,
    domain: 'fixture',
    directory: path.join(root, 'state'),
    registry,
    environment: { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') },
  });
  t.after(async () => {
    await bundle.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return bundle.runtime;
}
async function execute(runtime) {
  const state = await runtime.inspect();
  return runtime.execute(
    { toolId: 'fixture.verify', inputs: {}, expectedStateId: state.id },
    {
      approval: true,
      scope: {
        domain: 'fixture',
        projectId: state.projectId,
        stateId: state.id,
        tools: ['fixture.verify'],
      },
    },
  );
}
test('post-execution environment failure preserves actual artifacts and native cleanup diagnostics', async t => {
  const runtime = fixture(t, { failPost: true }),
    result = await execute(runtime);
  assert.equal(result.action.status, 'failed');
  assert.equal(result.artifacts.length, 1);
  assert.ok(result.action.diagnostics.includes('cleanup confirmed'));
  assert.ok(result.action.diagnostics.some(line => line.includes('Application changed')));
  assert.notEqual(result.verification.status, 'passed');
  assert.notEqual((await runtime.inspect()).status, 'verified');
});
test('cancelled native result reaches canonical collection without an aborted post-probe discarding its receipts', async t => {
  const runtime = fixture(t, { cancel: true }),
    pending = execute(runtime);
  const timer = setTimeout(() => runtime.cancel(), 30);
  try {
    const result = await pending;
    assert.equal(result.action.status, 'failed');
    assert.equal(result.artifacts.length, 1);
    assert.notEqual(result.verification.status, 'passed');
    assert.notEqual((await runtime.inspect()).status, 'verified');
    assert.ok(result.action.diagnostics.includes('cleanup confirmed'));
  } finally {
    clearTimeout(timer);
  }
});
