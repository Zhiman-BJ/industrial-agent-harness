const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { verify } = require('./packaged-runtime-selftest.cjs');

function report(status = 'ready', detail = 'HARNESS_PROTECTED_TASK_READY\n') {
  const executable = path.join(
    path.parse(process.execPath).root,
    'Applications',
    'Industrial Agent Harness.app',
    'Contents',
    'MacOS',
    'Harness',
  );
  return {
    actionId: 'environment-action',
    executable,
    report: {
      ready: true,
      platform: 'darwin',
      arch: 'arm64',
      checks: [{ name: 'protected local execution', required: false, status, detail }],
    },
    electronTask: {
      actionId: 'task-action',
      executionArtifactId: 'execution-artifact',
      checkArtifactId: 'checks-artifact',
      verificationStatus: 'passed',
      execution: {
        status: 'COMPLETED',
        exitCode: 0,
        identity: {
          executable,
          runAsNode: true,
          readOnlyRoots: [path.dirname(path.dirname(executable))],
        },
      },
      checkReport: {
        schemaVersion: '1',
        checks: [
          'Electron runs in Node mode',
          'selected input is readable',
          'unselected project input is denied',
          'outside host input is denied',
          'task work is writable',
        ].map(name => ({ name, passed: true })),
      },
    },
  };
}

test('packaged smoke requires the actual local probe even when overall readiness passes', () => {
  assert.equal(verify(report(), 'darwin', 'arm64').actionId, 'environment-action');
  assert.throws(() => verify(report('failed', 'dyld: sandbox blocked open()'), 'darwin', 'arm64'));
  assert.throws(() => verify(report('ready', 'no probe output'), 'darwin', 'arm64'));
  const omitted = report();
  omitted.report.checks = [];
  assert.throws(() => verify(omitted, 'darwin', 'arm64'));
});

test('packaged smoke rejects missing Action identity and evidence for a different platform', () => {
  assert.throws(() => verify(undefined, 'darwin', 'arm64'));
  assert.throws(() => verify({ ...report(), actionId: '' }, 'darwin', 'arm64'));
  assert.throws(() => verify(report(), 'win32', 'x64'));
  assert.throws(() => verify(report(), 'darwin', 'x64'));
  assert.throws(() => verify(report(), 'darwin', 'arm64', '/other/Harness'));
});

test('macOS requires canonical Electron task checks and bounded application read roots', () => {
  for (const mutate of [
    value => delete value.electronTask,
    value => (value.electronTask.verificationStatus = 'not_run'),
    value => (value.electronTask.execution.identity.runAsNode = false),
    value => (value.electronTask.checkReport.checks[3].passed = false),
    value => (value.electronTask.checkReport.checks[3].passed = 'true'),
    value => (value.electronTask.checkReport.checks[3].passed = 1),
    value =>
      value.electronTask.execution.identity.readOnlyRoots.push(
        path.dirname(path.dirname(path.dirname(path.dirname(value.executable)))),
      ),
    value =>
      value.electronTask.execution.identity.readOnlyRoots.push(
        path.dirname(path.dirname(path.dirname(value.executable))),
      ),
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => verify(value, 'darwin', 'arm64'));
  }
});

test('Windows preserves the explicit unsupported local-task boundary', () => {
  const unavailable = report('unavailable', 'Task executable is unavailable: /bin/sh');
  unavailable.report.platform = 'win32';
  unavailable.report.arch = 'x64';
  assert.equal(verify(unavailable, 'win32', 'x64'), unavailable);
  unavailable.report.checks[0].detail = 'unexpected DLL loading failure';
  assert.throws(() => verify(unavailable, 'win32', 'x64'));
});

for (const failure of [false, true]) {
  test(`packaged diagnosis ${failure ? 'failure' : 'success'} closes its service and removes its isolated fixture`, async t => {
    const application = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-test-')),
    );
    t.after(() => fs.rmSync(application, { recursive: true, force: true }));
    const executable = path.join(application, 'Harness.app', 'Contents', 'MacOS', 'Harness');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'test app');
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, 'packaged-runtime-selftest.cjs'), 'utf8'),
      {
        module,
        require,
        process: { platform: 'darwin', arch: 'arm64', execPath: executable, env: process.env },
      },
    );
    let options, fixture, closed;
    class TaskService {
      constructor(config) {
        options = config;
        const task = report().electronTask;
        task.execution.identity.executable = executable;
        task.execution.identity.readOnlyRoots = [path.dirname(path.dirname(executable))];
        const runtime = {
          inspect: async () => ({ id: 'bound-state', projectId: 'bound-project' }),
          execute: async (action, policy) => {
            assert.equal(action.toolId, 'project.task.run');
            assert.equal(action.inputs.task, 'packaged-runtime');
            assert.equal(action.expectedStateId, 'bound-state');
            assert.equal(policy.approval, true);
            assert.deepEqual(Array.from(policy.scope.tools), ['project.task.run']);
            const manifest = JSON.parse(
              fs.readFileSync(path.join(fixture, 'project', 'harness.tasks.json')),
            );
            assert.equal(manifest.tasks['packaged-runtime'].command[0], executable);
            assert.ok(!manifest.tasks['packaged-runtime'].inputs.includes('private.txt'));
            return {
              action: { id: task.actionId, status: 'completed' },
              verification: { status: 'passed' },
              artifacts: [
                { id: task.executionArtifactId, kind: 'report.execution' },
                { id: task.checkArtifactId, kind: 'report.task-checks' },
              ],
            };
          },
          readArtifact: id => ({
            content: JSON.stringify(
              id === task.executionArtifactId ? task.execution : task.checkReport,
            ),
          }),
        };
        this.projects = { get: () => ({ runtime }) };
      }
      async diagnose(project) {
        fixture = path.dirname(project.path);
        assert.equal(project.domain, 'general');
        assert.ok(fs.statSync(project.path).isDirectory());
        assert.deepEqual(fs.readdirSync(project.path), []);
        for (const directory of [
          options.chatDirectory,
          options.resourceDirectory,
          options.runtimeOptions.directory,
        ])
          assert.equal(path.dirname(directory), fixture);
        assert.equal(options.runtimeOptions.environment, options.environment);
        if (failure) throw Error('diagnosis failed');
        return report();
      }
      async close() {
        closed = true;
        assert.ok(fs.existsSync(fixture));
      }
    }
    const operation = module.exports.run({ TaskService, getRegistry: () => ({}) });
    if (failure) await assert.rejects(operation, /diagnosis failed/);
    else assert.equal((await operation).actionId, 'environment-action');
    assert.equal(closed, true);
    assert.equal(fs.existsSync(fixture), false);
  });
}
