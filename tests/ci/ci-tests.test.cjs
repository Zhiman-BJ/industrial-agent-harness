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
  nativeTestCounts,
  layoutNativeFiles,
  layoutNativeTestNames,
  layoutNativeTestCount,
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
  assert.deepEqual(allowedSkips('layout-native', 'darwin'), []);
  assert.deepEqual(allowedSkips('benchmark', 'linux'), []);
});

test('native launcher skips are limited to portable runners of the other operating system', () => {
  const windowsOnly = [
    'Windows current-user launch supports null-device I/O and headless subprocess primitives',
    'Windows current-user descendants preserve argv and pipes and retain normal user file permissions',
    'Windows current-user cancellation stops the live process tree',
    'Windows current-user execution runs pinned Kimi tools and resumes the same real conversation',
    'Windows shared Agent starts a chat with nested settings storage and reports current-user permissions',
  ];
  const posixOnly = 'POSIX platform selection has no bubblewrap or Seatbelt prerequisite';
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(
      allowedSkips('portable', platform).filter(name => windowsOnly.includes(name)),
      windowsOnly,
    );
    assert.equal(allowedSkips('portable', platform).includes(posixOnly), false);
    assert.deepEqual(allowedSkips('native', platform), []);
    assert.deepEqual(allowedSkips('native-linux', platform), []);
  }
  assert.equal(allowedSkips('portable', 'win32').includes(posixOnly), true);
  assert.equal(
    allowedSkips('portable', 'win32').some(name => windowsOnly.includes(name)),
    false,
  );
});

test('layout native catalog covers every dependency-gated assertion without removing portable coverage', () => {
  assert.deepEqual(layoutNativeFiles, [
    'packages/viewer-builtin/tests/layout-geometry.test.cjs',
    'packages/viewer-builtin/tests/layout-tiles.test.cjs',
  ]);
  const portable = portableFiles();
  const sources = layoutNativeFiles.map(file => {
    assert.ok(portable.includes(file), `${file} retains its portable assertions`);
    return fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
  });
  const nativeNames = sources.flatMap(source =>
    [...source.matchAll(/test\(\s*'([^']+)'\s*,\s*(?:available|native)\s*,/g)].map(
      match => match[1],
    ),
  );
  assert.equal(nativeNames.length, 12);
  assert.equal(new Set(layoutNativeTestNames).size, 12);
  assert.deepEqual(layoutNativeTestNames.toSorted(), nativeNames.toSorted());
  assert.equal(layoutNativeTestCount, 23);
  assert.equal(
    sources.reduce((count, source) => count + [...source.matchAll(/^test\(/gm)].length, 0),
    layoutNativeTestCount,
  );
  assert.equal(testConcurrency('layout-native'), 1);
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const name of nativeNames) assert.ok(allowedSkips('portable', platform).includes(name));
    assert.deepEqual(allowedSkips('layout-native', platform), []);
  }
});

test('missing KLayout passes only the portable gate; the native lane rejects skips and missing runtimes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-layout-ci-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = path.resolve(__dirname, '../../scripts/ci-tests.cjs');
  const launcher = path.join(directory, 'runner.cjs');
  fs.writeFileSync(
    launcher,
    `require(${JSON.stringify(runner)}).runFiles(${JSON.stringify({
      suite: 'layout-native',
      files: layoutNativeFiles.map(file => path.resolve(__dirname, '../..', file)),
      reportDirectory: directory,
    })}).then(report => { process.exitCode = report.ok ? 0 : 1; });`,
  );
  const env = { ...process.env, KLAYOUT_PYTHON: '', NODE_TEST_CONTEXT: undefined };
  const result = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'layout-native.json')));
  assert.equal(report.expectedTests, 23);
  assert.equal(report.summary.counts.tests, 23);
  assert.equal(report.summary.counts.passed, 11);
  assert.deepEqual(report.skipped.toSorted(), layoutNativeTestNames.toSorted());
  assert.equal(report.ok, false);
  assert.equal(assess(report.summary, report.skipped, allowedSkips('portable')).ok, true);
  assert.equal(
    assess(
      { ...report.summary, counts: { ...report.summary.counts, skipped: 13 } },
      [...report.skipped, 'an unreviewed native dependency'],
      allowedSkips('portable'),
    ).ok,
    false,
  );
  const complete = {
    success: true,
    counts: { tests: 23, passed: 23, failed: 0, cancelled: 0, todo: 0, skipped: 0 },
  };
  assert.equal(assess(complete, [], [], layoutNativeTestCount).ok, true);
  assert.equal(
    assess(
      { ...complete, counts: { ...complete.counts, tests: 22 } },
      [],
      [],
      layoutNativeTestCount,
    ).ok,
    false,
  );
  for (const python of ['', path.join(directory, 'missing-python')]) {
    const rejected = spawnSync(process.execPath, [runner, 'layout-native'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...env, KLAYOUT_PYTHON: python },
    });
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stderr, /layout-native requires/);
  }
});

test('every core PR runs the KLayout native gate in the required Desktop lane and retains its report', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/desktop-package.yml'),
    'utf8',
  );
  const step = workflow
    .split('      - name: Verify native layout geometry and tile recovery\n')[1]
    ?.split('\n      - ')[0];
  assert.ok(step, 'The Desktop native layout step must exist');
  assert.match(step, /if: matrix\.platform == 'mac'/);
  assert.doesNotMatch(step, /inputs\.full|continue-on-error/);
  assert.match(step, /shell: bash/);
  assert.match(step, /pnpm --filter @industrial-agent-harness\/desktop setup:layout/);
  assert.match(
    step,
    /export KLAYOUT_PYTHON="\$\(sed -n 's\/\^Managed layout Viewer Python is ready: \/\/p' dist\/ci-reports\/layout-setup\.log \| tail -1\)"/,
  );
  assert.match(step, /pnpm run test:ci -- layout-native 2>&1/);
  assert.match(workflow, /dist\/ci-reports\/layout-native\.json/);
  const ci = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const desktop = ci.split('  desktop:\n')[1].split(/\n {2}[a-z][\w-]*:/)[0];
  assert.match(desktop, /if: needs\.changes\.outputs\.core == 'true'/);
  assert.match(desktop, /uses: \.\/\.github\/workflows\/desktop-package\.yml/);
  assert.match(ci.split('  all-checks-passed:\n')[1], /needs: \[[^\]]*\bdesktop\b/);
});

test('native lanes retain the complete acceptance catalog without overlap or reduced test counts', () => {
  const expected = [
    'tests/integration/background-tasks-kimi.test.cjs',
    'packages/agent-kimi/tests/code-session-heartbeat.test.cjs',
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
  assert.deepEqual(nativeTestCounts, { native: 72, 'native-installed': 3 });
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

test('both native matrices must succeed; a missing, skipped, cancelled or failed lane cannot turn green', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/industrial-core.yml'),
    'utf8',
  );
  for (const name of ['native-vertical-slice', 'native-installed']) {
    const job = workflow.split(`  ${name}:\n`)[1].split(/\n {2}[a-z][\w-]*:/)[0];
    // macos-15 always runs; the macos-26 forward-compatibility lane only
    // joins when the caller requests the extended (nightly/manual) matrix.
    assert.match(
      job,
      /os: \$\{\{ inputs\.extended && fromJSON\('\["macos-15", "macos-26"\]'\) \|\| fromJSON\('\["macos-15"\]'\) \}\}/,
    );
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
