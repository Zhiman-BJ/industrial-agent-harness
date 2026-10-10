#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const nativeFiles = [
  'tests/integration/background-tasks-kimi.test.cjs',
  'packages/agent-kimi/tests/code-session-heartbeat.test.cjs',
  'tests/integration/workspace-runtime.test.cjs',
  'tests/integration/agent-question-kimi.test.cjs',
  'tests/integration/compaction-compat-kimi.test.cjs',
  'tests/integration/freecad-runtime.test.cjs',
  'tests/integration/task-results-freecad.test.cjs',
  'tests/integration/task-results-kimi.test.cjs',
  'tests/integration/pcb-godot-runtime.test.cjs',
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
// Full native installation stays on its own runner: archive verification, DMG
// copying and first launch must not compete with bounded engineering actions.
const nativeInstalledFiles = [
  'tests/integration/freecad-installed.test.cjs',
  'tests/integration/pcb-godot-installed.test.cjs',
];
const nativeTestCounts = { native: 68, 'native-installed': 3 };
function testConcurrency(suite) {
  return suite === 'native-installed' ? 1 : suite.startsWith('native') ? 2 : 4;
}
const transportFiles = [
  'tests/integration/external-mcp.test.cjs',
  'tests/integration/domain-mcp-scope.test.cjs',
  'tests/integration/pcb-mcp-transport.test.cjs',
  'tests/integration/pcb-mcp-policy.test.cjs',
  'tests/integration/godot-mcp-policy.test.cjs',
  'tests/integration/chip-runtime-reliability.test.cjs',
];
const linuxNativeFiles = [
  'tests/integration/background-tasks-kimi.test.cjs',
  'packages/agent-kimi/tests/code-session-heartbeat.test.cjs',
  'tests/integration/workspace-runtime.test.cjs',
  'tests/integration/domain-mcp-kimi.test.cjs',
  'tests/integration/pcb-mcp-kimi.test.cjs',
  'tests/integration/external-mcp-kimi.test.cjs',
  'tests/integration/agent-question-kimi.test.cjs',
  'tests/integration/compaction-compat-kimi.test.cjs',
  'packages/agent-kimi/tests/process-sandbox.test.cjs',
  'packages/agent-kimi/tests/linux-process-sandbox.test.cjs',
  'packages/agent-kimi/tests/project-skills-wire.test.cjs',
  'tests/integration/industrial-core-vertical-slice.test.cjs',
  'tests/integration/industrial-core-installed-pack.test.cjs',
  'tests/integration/chat-resume.test.cjs',
];

function portableFiles() {
  // Discover the same suites as pnpm test, including future tests in these packages.
  const packages = [
    ...fs.globSync('packages/*/package.json', { cwd: root }),
    'apps/cli/package.json',
    'apps/desktop/package.json',
  ];
  const files = packages.flatMap(manifest => {
    const command = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8')).scripts?.test;
    if (!command) return [];
    if (!command.startsWith('node --test ')) {
      throw Error(`CI needs an explicit test catalog for ${manifest}: ${command}`);
    }
    const directory = path.dirname(manifest);
    const patterns = command.slice('node --test '.length).split(/\s+/);
    const matches = patterns.flatMap(pattern => {
      const matched = fs.globSync(pattern, { cwd: path.join(root, directory) });
      if (!matched.length) throw Error(`No tests matched ${pattern} in ${manifest}.`);
      return matched;
    });
    return matches.map(file => path.join(directory, file).split(path.sep).join('/'));
  });
  return [
    ...new Set([
      ...files,
      'tests/ci/ci-tests.test.cjs',
      'tests/ci/ci-areas.test.cjs',
      'tests/ci/native-evidence.test.cjs',
      'tests/ci/runtime-archives.test.cjs',
      'tests/ci/qa-cleanup.test.cjs',
    ]),
  ]
    .filter(
      file =>
        ![...nativeFiles, ...nativeInstalledFiles, ...linuxNativeFiles].includes(file) ||
        file.includes('industrial-recovery'),
    )
    .sort();
}

function allowedSkips(suite, platform = process.platform) {
  if (suite === 'transport') {
    return [
      'fixed real PCB-bench source supplies all 89 schemas and complete Skill resources, while host execution remains refused',
    ];
  }
  if (suite !== 'portable') return [];
  const skips = ['KLayout LayoutView renders a bounded GDS viewport when available'];
  if (platform === 'win32') {
    skips.push(
      'timeout and cancellation kill descendants and close the result promise',
      'natural parent exit also cleans up orphaned tools before close',
    );
  }
  return skips;
}

function assess(summary, skipped, allowed = [], expectedTests) {
  const unexpectedSkips = skipped.filter(name => !allowed.includes(name));
  const counts = summary?.counts;
  const ok = Boolean(
    summary?.success &&
      counts?.tests > 0 &&
      counts?.passed > 0 &&
      (expectedTests === undefined || counts.tests === expectedTests) &&
      counts.failed === 0 &&
      counts.cancelled === 0 &&
      counts.todo === 0 &&
      counts.skipped === skipped.length &&
      unexpectedSkips.length === 0,
  );
  return { ok, unexpectedSkips };
}

async function runFiles({
  suite,
  files,
  reportDirectory,
  allowed = [],
  timeout = suite === 'portable' ? 180000 : undefined,
  expectedTests = nativeTestCounts[suite],
}) {
  if (files.length === 0) throw Error('CI test catalog is empty.');
  for (const file of files) {
    if (!fs.statSync(file).isFile()) throw Error(`Missing CI test: ${file}`);
  }
  const skipped = [];
  let summary;
  // Abort a stalled portable suite, including leaked handles after tests pass.
  // A timeout still fails the gate; it must never become a platform skip.
  const stream = run({
    files,
    execArgv: [],
    concurrency: testConcurrency(suite),
    ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
  });
  stream.on('test:pass', data => {
    if (data.skip) skipped.push(data.name);
  });
  stream.on('test:summary', data => {
    if (!data.file) summary = data;
  });
  for await (const line of stream.compose(spec)) process.stdout.write(line);
  const report = {
    suite,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    files,
    summary,
    skipped,
    allowedSkips: allowed,
    expectedTests,
    ...assess(summary, skipped, allowed, expectedTests),
  };
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reportDirectory, `${suite}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (!report.ok) {
    console.error(
      'CI requires executed, passing tests with no unexpected skip, cancellation or TODO.',
    );
    if (report.unexpectedSkips.length) console.error(report.unexpectedSkips.join('\n'));
  }
  return report;
}

async function main(suite) {
  // pnpm forwards an optional separator to scripts.
  if (
    !['portable', 'native', 'native-installed', 'native-linux', 'benchmark', 'transport'].includes(
      suite,
    )
  )
    throw Error(`Unknown CI suite: ${suite}`);
  process.chdir(root);
  for (const [variable, actual] of [
    ['HARNESS_CI_PLATFORM', process.platform],
    ['HARNESS_CI_ARCH', process.arch],
  ]) {
    if (process.env[variable] && process.env[variable] !== actual) {
      throw Error(`${variable}: expected ${process.env[variable]}, got ${actual}`);
    }
  }
  if (suite.startsWith('native')) {
    const supported =
      suite !== 'native-linux'
        ? process.platform === 'darwin' && process.arch === 'arm64'
        : process.platform === 'linux' && process.arch === 'x64';
    if (!supported) {
      throw Error('Protected native CI requires its declared native OS/architecture.');
    }
    for (const file of [
      process.env.KIMI_EXECUTABLE,
      ...(suite === 'native' ? [process.env.INDUSTRIAL_HARNESS_FREECAD_CMD] : []),
      ...(suite !== 'native-installed'
        ? [
            path.join(
              require('../packages/domain-skills/src/index.cjs').packSourceDirectory('chip-pack'),
              'eda-harness/.venv/bin/python',
            ),
          ]
        : []),
    ]) {
      if (!file || !fs.existsSync(file)) throw Error(`Missing required native runtime: ${file}`);
    }
    process.env.HARNESS_REQUIRE_CORE_NATIVE = '1';
  }
  for (const tool of suite === 'benchmark'
    ? ['iverilog', 'vvp']
    : suite.startsWith('native')
      ? suite === 'native-installed'
        ? ['rg']
        : ['verilator', 'rg']
      : []) {
    const result = spawnSync(tool, [tool === 'verilator' || tool === 'rg' ? '--version' : '-V'], {
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) throw Error(`Missing required verifier: ${tool}`);
  }
  const files =
    suite === 'portable'
      ? portableFiles()
      : suite === 'native'
        ? nativeFiles
        : suite === 'native-installed'
          ? nativeInstalledFiles
          : suite === 'native-linux'
            ? linuxNativeFiles
            : suite === 'transport'
              ? transportFiles
              : ['tests/benchmark/paired.test.cjs'];
  const report = await runFiles({
    suite,
    files: files.map(file => path.join(root, file)),
    reportDirectory: path.join(root, 'dist/ci-reports'),
    allowed: allowedSkips(suite),
  });
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = {
  assess,
  allowedSkips,
  runFiles,
  nativeFiles,
  nativeInstalledFiles,
  nativeTestCounts,
  testConcurrency,
  portableFiles,
};
if (require.main === module) {
  const suite = process.argv.slice(2).filter(argument => argument !== '--')[0];
  main(suite).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
