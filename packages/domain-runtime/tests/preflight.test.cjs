const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/preflight.cjs'), 'utf8');
const marker = 'HARNESS_PROTECTED_TASK_READY';

function fixture(t, { executeTask, tasks, execPath = process.execPath } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const module = { exports: {} };
  const dependencies = {
    'node:fs': fs,
    'node:path': path,
    'node:child_process': {
      spawnSync: () => assert.fail('No Docker subprocess should start without a Docker CLI.'),
    },
    './task-process.cjs': {
      executeTask: async (task, context) => {
        assert.equal(context.projectDir, directory);
        calls.push({ task, context });
        return executeTask(task, context);
      },
    },
    './workspace-files.cjs': {
      manifest: () => ({
        tasks: tasks ?? { sample: { command: [process.execPath], runtime: { kind: 'local' } } },
      }),
      runDirectory: () => directory,
    },
    './docker-cli.cjs': {
      resolveDockerCli: async () => null,
      dockerSearchLocations: () => [],
    },
  };
  vm.runInNewContext(source, {
    module,
    process: { execPath, platform: 'darwin', arch: 'arm64', version: process.version },
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return {
    calls,
    async run(signal) {
      const environment = { PATH: '', ELECTRON_RUN_AS_NODE: '0' };
      const result = await module.exports.preflight(
        { projectDir: directory, action: { id: 'probe' }, signal },
        environment,
        [],
      );
      assert.equal(result.executionSucceeded, true);
      const report = JSON.parse(fs.readFileSync(result.artifacts[0].file, 'utf8'));
      return {
        report,
        check: report.checks.find(item => item.name === 'protected local execution'),
      };
    },
  };
}

for (const [host, execPath] of [
  ['Node', process.execPath],
  ['packaged Electron', '/Applications/Industrial Agent Harness.app/Contents/MacOS/Harness'],
]) {
  test(`${host} preflight uses a native probe independent of execPath and PATH`, async t => {
    const instance = fixture(t, {
      execPath,
      executeTask: async task => {
        assert.equal(task.command[0], '/bin/sh');
        assert.deepEqual(Array.from(task.command).slice(1), [
          '-c',
          'printf "%s\\n" HARNESS_PROTECTED_TASK_READY',
        ]);
        return { status: 'COMPLETED', log: marker + '\n' };
      },
    });
    const { report, check } = await instance.run();
    assert.equal(check.status, 'ready');
    assert.equal(check.required, true);
    assert.equal(check.detail, marker + '\n');
    assert.equal(report.ready, true);
    assert.equal(instance.calls[0].task.command[0], '/bin/sh');
    assert.equal(instance.calls[0].task.runtime.kind, 'local');
  });
}

test('the native probe executes without Node or reports an unsupported backend', async t => {
  const instance = fixture(t, {
    executeTask: async (task, context) => {
      if (process.platform === 'win32')
        return require('../src/task-process.cjs').executeTask(task, context);
      const result = spawnSync(task.command[0], Array.from(task.command).slice(1), {
        encoding: 'utf8',
        env: { PATH: '', ELECTRON_RUN_AS_NODE: '0' },
      });
      assert.equal(result.status, 0, result.stderr);
      return { status: 'COMPLETED', log: result.stdout };
    },
  });
  const { report, check } = await instance.run();
  if (process.platform === 'win32') {
    assert.equal(check.status, 'unavailable');
    assert.match(
      check.detail,
      /Task executable is unavailable: \/bin\/sh|Protected local task execution is unavailable on this platform/,
    );
    assert.equal(report.ready, false);
  } else {
    assert.equal(check.status, 'ready');
    assert.equal(check.detail, marker + '\n');
  }
});

test('preflight rejects a completed subprocess without the readiness marker', async t => {
  const instance = fixture(t, {
    executeTask: async () => ({ status: 'COMPLETED', log: 'some other process started' }),
  });
  const { report, check } = await instance.run();
  assert.equal(check.status, 'failed');
  assert.equal(report.ready, false);
});

for (const status of ['FAILED', 'TIMEOUT', 'CANCELLED']) {
  test(`preflight does not accept a ${status.toLowerCase()} probe with a marker`, async t => {
    const controller = new AbortController();
    if (status === 'CANCELLED') controller.abort();
    const instance = fixture(t, {
      executeTask: async (task, context) => {
        assert.equal(context.signal, controller.signal);
        return { status, log: marker };
      },
    });
    const { report, check } = await instance.run(controller.signal);
    assert.equal(check.status, 'failed');
    assert.equal(report.ready, false);
  });
}

test('preflight reports an unavailable native execution backend', async t => {
  const instance = fixture(t, {
    executeTask: async () => {
      throw Error('Protected local task execution is unavailable on this platform.');
    },
  });
  const { report, check } = await instance.run();
  assert.equal(check.status, 'unavailable');
  assert.match(check.detail, /unavailable on this platform/);
  assert.equal(report.ready, false);
});

test('an optional unavailable local probe does not reject a project without local tasks', async t => {
  const instance = fixture(t, {
    tasks: {},
    executeTask: async () => {
      throw Error('Task executable is unavailable: /bin/sh');
    },
  });
  const { report, check } = await instance.run();
  assert.equal(instance.calls.length, 1);
  assert.equal(check.status, 'unavailable');
  assert.equal(check.required, false);
  assert.equal(report.ready, true);
});
