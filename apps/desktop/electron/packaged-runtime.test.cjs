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

function windowsFixture(t, { diagnosisError, closeError, removalError } = {}) {
  let directory,
    closed = false;
  const calls = [];
  const module = { exports: {} };
  const filesystem = {
    ...fs,
    rmSync() {
      assert.fail('Packaged fixture cleanup must use the asynchronous Windows-aware remover.');
    },
    promises: {
      ...fs.promises,
      async rm(file, options) {
        assert.equal(file, directory);
        assert.equal(closed, true, 'Removal must follow the awaited service close.');
        assert.deepEqual(
          { ...options },
          {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          },
        );
        calls.push('remove');
        await Promise.resolve();
        if (removalError) throw removalError;
        await fs.promises.rm(file, options);
        calls.push('removed');
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'packaged-runtime-selftest.cjs'), 'utf8'),
    {
      module,
      process: { platform: 'win32', arch: 'x64', execPath: process.execPath, env: process.env },
      require: name => (name === 'node:fs' ? filesystem : require(name)),
    },
  );
  class TaskService {
    constructor(options) {
      directory = path.dirname(options.resourceDirectory);
      t.after(() =>
        fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      );
    }
    async diagnose() {
      calls.push('diagnose');
      if (diagnosisError) throw diagnosisError;
      // IndustrialRuntime's CAS writes immutable artifacts with mode 0400.
      // Exercise the same physical read-only file during fixture removal.
      const artifacts = path.join(directory, 'state', 'artifacts');
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'readonly-artifact'), 'fixture evidence', {
        mode: 0o400,
      });
      const result = report(
        'unavailable',
        'Protected local task execution is unavailable on this platform.',
      );
      result.report.platform = 'win32';
      result.report.arch = 'x64';
      return result;
    }
    async close() {
      await Promise.resolve();
      closed = true;
      calls.push('close');
      if (closeError) throw closeError;
    }
  }
  return {
    calls,
    run: () => module.exports.run({ TaskService, getRegistry: () => ({}) }),
    exists: () => fs.existsSync(directory),
  };
}

test('Windows fixture cleanup awaits removal of read-only CAS files after service close', async t => {
  const instance = windowsFixture(t);
  assert.equal((await instance.run()).actionId, 'environment-action');
  assert.deepEqual(instance.calls, ['diagnose', 'close', 'remove', 'removed']);
  assert.equal(instance.exists(), false);
});

test('exhausted cleanup EPERM remains a failure after successful diagnosis', async t => {
  const removalError = Object.assign(Error('EPERM after native removal retries'), {
    code: 'EPERM',
  });
  const instance = windowsFixture(t, { removalError });
  await assert.rejects(instance.run(), error => error === removalError);
  assert.deepEqual(instance.calls, ['diagnose', 'close', 'remove']);
  assert.equal(instance.exists(), true);
});

test('cleanup EPERM preserves the original diagnosis error as the first cause', async t => {
  const diagnosisError = Error('original diagnosis failure');
  const removalError = Object.assign(Error('EPERM after native removal retries'), {
    code: 'EPERM',
  });
  const instance = windowsFixture(t, { diagnosisError, removalError });
  await assert.rejects(instance.run(), error => {
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.cause, diagnosisError);
    assert.deepEqual(Array.from(error.errors), [diagnosisError, removalError]);
    return true;
  });
  assert.deepEqual(instance.calls, ['diagnose', 'close', 'remove']);
});

test('diagnosis, service-close and removal failures all remain visible in order', async t => {
  const diagnosisError = Error('original diagnosis failure');
  const closeError = Error('service close failure');
  const removalError = Object.assign(Error('EPERM after native removal retries'), {
    code: 'EPERM',
  });
  const instance = windowsFixture(t, { diagnosisError, closeError, removalError });
  await assert.rejects(instance.run(), error => {
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.cause, diagnosisError);
    assert.deepEqual(Array.from(error.errors), [diagnosisError, closeError, removalError]);
    return true;
  });
  assert.deepEqual(instance.calls, ['diagnose', 'close', 'remove']);
});

test('a service-close failure still removes the fixture and cannot become success', async t => {
  const closeError = Error('service close failure');
  const instance = windowsFixture(t, { closeError });
  await assert.rejects(instance.run(), error => error === closeError);
  assert.deepEqual(instance.calls, ['diagnose', 'close', 'remove', 'removed']);
  assert.equal(instance.exists(), false);
});
