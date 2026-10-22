const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskChecks = [
  'Electron runs in Node mode',
  'selected input is readable',
  'unselected project input is denied',
  'outside host input is denied',
  'task work is writable',
];

function verify(result, platform = process.platform, arch = process.arch, executable) {
  assert.equal(result?.report?.platform, platform, 'The packaged probe must run on this OS.');
  assert.equal(result.report.arch, arch, 'The packaged probe must run on this architecture.');
  assert.equal(typeof result.actionId, 'string', 'The probe must have a canonical Action ID.');
  assert.ok(result.actionId.length > 0, 'The probe must retain its Action ID.');
  const check = result.report.checks?.find(item => item.name === 'protected local execution');
  assert.ok(check, 'The packaged environment report must include the protected local probe.');
  if (platform === 'darwin') {
    assert.equal(check.status, 'ready', JSON.stringify(check));
    assert.match(check.detail, /HARNESS_PROTECTED_TASK_READY/);
    assert.equal(typeof result.executable, 'string');
    if (executable) assert.equal(result.executable, executable);
    const contents = path.dirname(path.dirname(result.executable));
    assert.equal(path.basename(contents), 'Contents');
    const task = result.electronTask;
    assert.ok(task?.actionId, 'The Electron task must retain its canonical Action ID.');
    assert.ok(task.executionArtifactId, 'The Electron task must retain its execution artifact.');
    assert.ok(
      task.checkArtifactId,
      'The Electron task must retain its independent checks artifact.',
    );
    assert.equal(task.verificationStatus, 'passed', JSON.stringify(task));
    assert.equal(task.execution.status, 'COMPLETED');
    assert.equal(task.execution.exitCode, 0);
    assert.equal(task.execution.identity.executable, result.executable);
    assert.equal(task.execution.identity.runAsNode, true);
    const roots = task.execution.identity.readOnlyRoots;
    assert.ok(roots.includes(contents), 'The application runtime must be readable.');
    assert.ok(
      !roots.includes(path.dirname(contents)),
      'The application bundle root must stay private.',
    );
    assert.ok(
      !roots.includes(path.dirname(path.dirname(contents))),
      'Adjacent applications must stay private.',
    );
    assert.deepEqual(
      task.checkReport.checks.map(item => item.name),
      taskChecks,
    );
    assert.ok(task.checkReport.checks.every(item => item.passed === true));
  } else if (platform === 'win32') {
    assert.equal(check.status, 'unavailable', JSON.stringify(check));
    assert.match(
      check.detail,
      /Task executable is unavailable|Protected local task execution is unavailable/,
    );
  } else throw Error('Packaged runtime smoke supports macOS and Windows.');
  return result;
}

async function electronTask(service, project, registry, outsidePrivate) {
  const projectPrivate = path.join(project.path, 'private.txt');
  fs.writeFileSync(projectPrivate, 'unselected project fixture');
  fs.writeFileSync(path.join(project.path, 'selected.txt'), 'selected fixture');
  fs.writeFileSync(
    path.join(project.path, 'probe.cjs'),
    `const fs = require('node:fs'), path = require('node:path');
const denied = file => {
  try { fs.readFileSync(file); return false; }
  catch (error) { return ['EACCES', 'EPERM'].includes(error.code); }
};
const checks = [
  {name: ${JSON.stringify(taskChecks[0])}, passed: Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1'},
  {name: ${JSON.stringify(taskChecks[1])}, passed: fs.readFileSync(path.join(process.env.HARNESS_INPUT_DIR, 'selected.txt'), 'utf8') === 'selected fixture'},
  {name: ${JSON.stringify(taskChecks[2])}, passed: denied(${JSON.stringify(projectPrivate)})},
  {name: ${JSON.stringify(taskChecks[3])}, passed: denied(${JSON.stringify(outsidePrivate)})}
];
const output = path.join(process.env.HARNESS_OUTPUT_DIR, 'result.txt');
fs.writeFileSync(output, 'packaged Electron task');
checks.push({name: ${JSON.stringify(taskChecks[4])}, passed: fs.readFileSync(output, 'utf8') === 'packaged Electron task'});
fs.writeFileSync(path.join(process.env.HARNESS_OUTPUT_DIR, 'checks.json'), JSON.stringify({schemaVersion: '1', checks}));
if (checks.some(check => !check.passed)) process.exitCode = 1;
`,
  );
  fs.writeFileSync(
    path.join(project.path, 'harness.tasks.json'),
    JSON.stringify({
      schemaVersion: '1',
      tasks: {
        'packaged-runtime': {
          command: [process.execPath, '{input}/probe.cjs'],
          inputs: ['probe.cjs', 'selected.txt'],
          outputs: [{ path: 'result.txt', kind: 'report.packaged-runtime' }],
          runtime: { kind: 'local' },
          timeoutMs: 5000,
          verification: { kind: 'checks-json', path: 'checks.json' },
        },
      },
    }),
  );
  const { runtime } = service.projects.get(project, registry);
  const state = await runtime.inspect();
  const toolId = 'project.task.run';
  const result = await runtime.execute(
    { toolId, inputs: { task: 'packaged-runtime' }, expectedStateId: state.id },
    {
      approval: true,
      scope: {
        domain: project.domain,
        projectId: state.projectId,
        stateId: state.id,
        tools: [toolId],
      },
    },
  );
  assert.equal(result.action.status, 'completed', JSON.stringify(result.action));
  assert.equal(result.verification.status, 'passed', JSON.stringify(result.verification));
  const execution = result.artifacts.find(item => item.kind === 'report.execution');
  const checks = result.artifacts.find(item => item.kind === 'report.task-checks');
  assert.ok(
    execution && checks,
    'The task must retain execution and independent verification evidence.',
  );
  return {
    actionId: result.action.id,
    verificationStatus: result.verification.status,
    executionArtifactId: execution.id,
    checkArtifactId: checks.id,
    execution: JSON.parse(runtime.readArtifact(execution.id).content),
    checkReport: JSON.parse(runtime.readArtifact(checks.id).content),
  };
}

async function run({ TaskService, getRegistry }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-packaged-runtime-'));
  const project = {
    id: 'packaged-runtime',
    path: path.join(directory, 'project'),
    domain: 'general',
  };
  const environment = {
    ...process.env,
    INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
  };
  let service, result;
  const errors = [];
  try {
    fs.mkdirSync(project.path);
    service = new TaskService({
      environment,
      getRegistry,
      chatDirectory: path.join(directory, 'chats'),
      resourceDirectory: environment.INDUSTRIAL_HARNESS_CONFIG_DIR,
      runtimeOptions: { directory: path.join(directory, 'state'), environment },
    });
    // Inspect the canonical check itself: overall ready can hide a failed
    // optional probe when an empty project has no declared local tasks.
    result = await service.diagnose(project);
    result.executable = fs.realpathSync(process.execPath);
    if (process.platform === 'darwin') {
      const outsidePrivate = path.join(directory, 'outside-private.txt');
      fs.writeFileSync(outsidePrivate, 'outside host fixture');
      result.electronTask = await electronTask(service, project, getRegistry(), outsidePrivate);
    }
    verify(result, process.platform, process.arch, result.executable);
  } catch (error) {
    errors.push(error);
  }
  try {
    await service?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    // The async remover handles Windows read-only CAS files with chmod/unlink;
    // the bundled Node's synchronous remove_all can reject them with EPERM.
    // Retry transient locks within a bound; exhausted cleanup still fails.
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Packaged runtime smoke encountered multiple failures.', {
      cause: errors[0],
    });
  return result;
}

module.exports = { run, verify };
