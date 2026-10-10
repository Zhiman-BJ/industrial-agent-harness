const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const {
  assess,
  allowedSkips,
  nativeFiles,
  nativeInstalledFiles,
  linuxNativeFiles,
  nativeTestCounts,
  testConcurrency,
  portableFiles,
} = require('../../scripts/ci-tests.cjs');

test('CI cannot pass with no tests, failed, cancelled, TODO or unaccounted skipped tests', () => {
  const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, todo: 0, skipped: 0 };
  assert.equal(assess({ success: true, counts }, []).ok, true);
  for (const change of [
    { tests: 0, passed: 0 },
    { failed: 1 },
    { cancelled: 1 },
    { todo: 1 },
    { skipped: 1 },
  ]) {
    assert.equal(assess({ success: true, counts: { ...counts, ...change } }, []).ok, false);
  }
  assert.equal(assess(undefined, []).ok, false);
  assert.equal(assess({ success: false, counts }, []).ok, false);
  assert.deepEqual(allowedSkips('native', 'darwin'), []);
  assert.deepEqual(allowedSkips('native-installed', 'darwin'), []);
  assert.deepEqual(allowedSkips('benchmark', 'linux'), []);
});

test('native lanes retain the complete acceptance catalog without overlap or reduced test counts', () => {
  const expected = [
    'tests/integration/background-tasks-kimi.test.cjs',
    'packages/agent-kimi/tests/code-session-heartbeat.test.cjs',
    'packages/agent-kimi/tests/code-session-profiles.test.cjs',
    'tests/integration/agent-profiles-kimi.test.cjs',
    'tests/integration/workspace-runtime.test.cjs',
    'tests/integration/agent-question-kimi.test.cjs',
    'tests/integration/compaction-compat-kimi.test.cjs',
    'tests/integration/freecad-runtime.test.cjs',
    'tests/integration/freecad-installed.test.cjs',
    'tests/integration/task-results-freecad.test.cjs',
    'tests/integration/task-results-kimi.test.cjs',
    'tests/integration/pcb-godot-runtime.test.cjs',
    'tests/integration/pcb-godot-installed.test.cjs',
    'tests/integration/godot-native.test.cjs',
    'tests/integration/industrial-core-vertical-slice.test.cjs',
    'tests/integration/industrial-core-installed-pack.test.cjs',
    'packages/agent-kimi/tests/process-sandbox.test.cjs',
    'packages/domain-runtime/tests/industrial-recovery.test.cjs',
    'tests/integration/license-materials.test.cjs',
    'tests/integration/domain-mcp-kimi.test.cjs',
    'tests/integration/pcb-mcp-kimi.test.cjs',
    'tests/integration/external-mcp-kimi.test.cjs',
    'packages/agent-kimi/tests/vision-wire.test.cjs',
    'packages/agent-kimi/tests/parallel-wire.test.cjs',
    'packages/agent-kimi/tests/project-skills-wire.test.cjs',
    'tests/integration/session-resources-kimi.test.cjs',
    'tests/integration/session-chaos-kimi.test.cjs',
    'tests/integration/chat-resume.test.cjs',
    'tests/benchmark/model-drivers.test.cjs',
  ];
  const actual = [...nativeFiles, ...nativeInstalledFiles];
  assert.equal(new Set(actual).size, actual.length, 'Each native file belongs to exactly one lane');
  assert.deepEqual(actual.toSorted(), expected.toSorted());
  for (const file of actual)
    assert.ok(fs.statSync(path.resolve(__dirname, '../..', file)).isFile());
  assert.deepEqual(nativeInstalledFiles, [
    'tests/integration/freecad-installed.test.cjs',
    'tests/integration/pcb-godot-installed.test.cjs',
  ]);
  assert.deepEqual(nativeTestCounts, { native: 76, 'native-installed': 3 });
  const portable = portableFiles();
  for (const file of [
    'packages/agent-kimi/tests/code-session-profiles.test.cjs',
    'tests/integration/agent-profiles-kimi.test.cjs',
  ]) {
    assert.ok(linuxNativeFiles.includes(file), `${file} must run on Linux native CI`);
    assert.ok(!portable.includes(file), `${file} requires native runtime and sandbox support`);
  }
  for (const count of Object.values(nativeTestCounts)) {
    const summary = tests => ({
      success: true,
      counts: { tests, passed: tests, failed: 0, cancelled: 0, todo: 0, skipped: 0 },
    });
    assert.equal(assess(summary(count), [], [], count).ok, true);
    assert.equal(assess(summary(count - 1), [], [], count).ok, false);
    assert.equal(assess(summary(count + 1), [], [], count).ok, false);
  }
  assert.equal(testConcurrency('native-installed'), 1);
  assert.equal(testConcurrency('native'), 2);
});

test('both protected native matrices must succeed; a missing, skipped, cancelled or failed lane cannot turn green', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/industrial-core.yml'),
    'utf8',
  );
  for (const name of ['native-vertical-slice', 'native-installed']) {
    const job = workflow.split(`  ${name}:\n`)[1].split(/\n  [a-z][\w-]*:/)[0];
    assert.match(job, /os: \[macos-15, macos-26\]/);
    assert.match(job, /timeout-minutes: 25/);
    assert.doesNotMatch(job, /continue-on-error:/);
    assert.match(
      job,
      new RegExp(`pnpm run test:ci -- ${name === 'native-installed' ? name : 'native'} 2>&1`),
    );
  }
  const aggregate = workflow.split('  native-acceptance:\n')[1];
  assert.match(aggregate, /if: always\(\)/);
  assert.match(aggregate, /needs: \[native-vertical-slice, native-installed\]/);
  const source = aggregate.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  const evaluate = jobs => {
    const process = { env: { REQUIRED_NATIVE_JOBS: JSON.stringify(jobs) }, exitCode: 0 };
    vm.runInNewContext(source, { process, console: { log() {} } });
    return process.exitCode;
  };
  const passing = {
    'native-vertical-slice': { result: 'success' },
    'native-installed': { result: 'success' },
  };
  assert.equal(evaluate(passing), 0);
  for (const lane of Object.keys(passing)) {
    for (const result of ['failure', 'cancelled', 'skipped'])
      assert.equal(evaluate({ ...passing, [lane]: { result } }), 1);
    const missing = { ...passing };
    delete missing[lane];
    assert.equal(evaluate(missing), 1);
  }
});

test('real Node test events fail CI for unexpected skips, TODO and assertion failures', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ci-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = path.resolve(__dirname, '../../scripts/ci-tests.cjs');
  for (const [name, source, expected] of [
    ['passing', "test('executed', () => {});", true],
    [
      'skipped',
      "test('executed', () => {}); test('missing native', {skip:true}, () => {});",
      false,
    ],
    ['todo', "test('unfinished', {todo:true}, () => {});", false],
    ['failing', "test('broken', () => {throw Error('broken');});", false],
    ['leaked-handle', "test('executed', () => {}); setInterval(() => {}, 1000);", false],
  ]) {
    const file = path.join(directory, `${name}.test.cjs`);
    fs.writeFileSync(file, `const test = require('node:test');\n${source}\n`);
    const program = `require(${JSON.stringify(runner)}).runFiles(${JSON.stringify({
      suite: name,
      files: [file],
      reportDirectory: directory,
      ...(name === 'leaked-handle' ? { timeout: 2000 } : {}),
    })}).then(report => {process.exitCode = report.ok ? 0 : 1;})`;
    const launcher = path.join(directory, `${name}-runner.cjs`);
    fs.writeFileSync(launcher, program);
    const result = spawnSync(process.execPath, [launcher], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected ? 0 : 1, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'));
    assert.equal(report.ok, expected);
    if (name === 'skipped') assert.deepEqual(report.unexpectedSkips, ['missing native']);
    if (name === 'leaked-handle') {
      assert.match(result.stdout, /executed/);
      assert.ok(report.summary.counts.failed > 0 || report.summary.counts.cancelled > 0);
    }
  }
});

test('installed lane runs all files serially and reports its complete count', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installed-scheduling-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const active = path.join(directory, 'active');
  const files = [0, 1, 2].map(index => {
    const file = path.join(directory, `${index}.test.cjs`);
    fs.writeFileSync(
      file,
      `const fs = require('node:fs');
      require('node:test')('exclusive slot ${index}', async () => {
        fs.writeFileSync(${JSON.stringify(active)}, '${index}', { flags: 'wx' });
        try { await new Promise(resolve => setTimeout(resolve, 100)); }
        finally { fs.rmSync(${JSON.stringify(active)}); }
      });`,
    );
    return file;
  });
  const runner = path.resolve(__dirname, '../../scripts/ci-tests.cjs');
  const launcher = path.join(directory, 'runner.cjs');
  fs.writeFileSync(
    launcher,
    `require(${JSON.stringify(runner)}).runFiles(${JSON.stringify({
      suite: 'native-installed',
      files,
      reportDirectory: directory,
    })}).then(report => { process.exitCode = report.ok ? 0 : 1; });`,
  );
  const result = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'native-installed.json')));
  assert.equal(report.expectedTests, 3);
  assert.equal(report.summary.counts.passed, 3);
  assert.equal(report.ok, true);
});
