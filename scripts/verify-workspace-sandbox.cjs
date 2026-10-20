#!/usr/bin/env node
// Focused real local-task acceptance. Does not replace the full native CI lane.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const { assess } = require('./ci-tests.cjs');

const root = path.resolve(__dirname, '..');
const testFile = 'tests/integration/workspace-runtime.test.cjs';
const cases = [
  'real protected local task: empty project → create → pass → edit → stale → fail → repair → pass; historical artifacts survive',
  'real task cannot write source, runtime evidence, input snapshots or contact host sockets; no inherited credentials',
  'real local task reads only its snapshot, runtime libraries and explicitly granted dependency directories',
  'exit zero, stale reports and malformed reports do not become acceptance; timeout retains execution evidence',
  'real Runtime deadline, cancellation and normal parent exit clean up the owned task process group',
];
function accepted(summary, outcomes) {
  return (
    summary?.counts?.passed === cases.length &&
    assess(
      summary,
      outcomes.filter(item => item.skip).map(item => item.name),
      [],
      cases.length,
    ).ok &&
    outcomes.length === cases.length &&
    cases.every(
      name => outcomes.filter(item => item.name === name && item.status === 'passed').length === 1,
    )
  );
}
function sources() {
  return Object.fromEntries(
    [
      'scripts/verify-workspace-sandbox.cjs',
      'scripts/ci-tests.cjs',
      testFile,
      'tests/integration/fixtures/workspace-scenario.cjs',
      'packages/domain-runtime/src/task-process.cjs',
      'packages/domain-runtime/src/workspace.cjs',
      'packages/domain-runtime/src/workspace-files.cjs',
      'packages/domain-runtime/src/industrial.cjs',
      'packages/domain-runtime/src/evidence-inputs.cjs',
      'packages/contracts/src/index.cjs',
      'packages/contracts/src/workspace.cjs',
      'pnpm-lock.yaml',
    ].map(file => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  );
}
async function probe() {
  const { executeTask } = require('../packages/domain-runtime/src/task-process.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-sandbox-probe-'));
  const input = path.join(directory, 'input'),
    work = path.join(directory, 'work');
  fs.mkdirSync(input);
  fs.mkdirSync(work);
  const marker = crypto.randomUUID();
  fs.writeFileSync(
    path.join(input, 'probe.cjs'),
    "require('node:fs').writeFileSync(require('node:path').join(process.env.HARNESS_OUTPUT_DIR,'ran')," +
      JSON.stringify(marker) +
      ');',
    { mode: 0o400 },
  );
  try {
    const execution = await executeTask(
      {
        command: [process.execPath, '{input}/probe.cjs'],
        runtime: { kind: 'local' },
        timeoutMs: 5000,
      },
      { directory, input, work, actionId: crypto.randomUUID(), environment: process.env },
    );
    const ran =
      fs.existsSync(path.join(work, 'ran')) &&
      fs.readFileSync(path.join(work, 'ran'), 'utf8') === marker;
    return {
      ...execution,
      ok: execution.status === 'COMPLETED' && execution.exitCode === 0 && ran,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function main() {
  process.chdir(root);
  const outputRoot = path.join(root, 'dist/qa/workspace-sandbox');
  const directory = path.join(
    outputRoot,
    new Date().toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID().slice(0, 8),
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const report = {
    schemaVersion: '1',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    nodeExecutable: fs.realpathSync(process.execPath),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    sources: sources(),
    cases,
    directory,
    outcomes: [],
  };
  const save = () => {
    const json = JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(path.join(directory, 'report.json'), json);
    fs.writeFileSync(path.join(outputRoot, 'latest.json'), json);
  };
  save();
  console.log('Real workspace sandbox acceptance: ' + directory);
  const previousEvidence = process.env.HARNESS_WORKSPACE_ACCEPTANCE_EVIDENCE;
  try {
    if (
      !(process.platform === 'darwin' && process.arch === 'arm64') &&
      !(process.platform === 'linux' && process.arch === 'x64')
    ) {
      report.status = 'BLOCKED';
      report.reason = 'This focused lane covers macOS arm64 and Linux x64 only.';
      return;
    }
    report.probe = await probe();
    if (!report.probe.ok) {
      const detail = report.probe.log || report.probe.error || '';
      const blocked =
        /sandbox_apply: Operation not permitted|bwrap:.*(?:not permitted|No permissions)|Task executable is unavailable: bwrap/i.test(
          detail,
        );
      report.status = blocked ? 'BLOCKED' : 'FAIL';
      report.reason = blocked
        ? 'OS permissions or isolation prerequisites blocked the production task backend.'
        : 'The production backend failed to execute the isolated marker program.';
      console.error(report.probe.log || report.probe.error || report.reason);
      return;
    }
    process.env.HARNESS_WORKSPACE_ACCEPTANCE_EVIDENCE = path.join(directory, 'evidence');
    const stream = run({
      files: [path.join(root, testFile)],
      concurrency: 1,
      execArgv: [],
      testNamePatterns: cases.map(
        name => new RegExp('^' + name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '$'),
      ),
      signal: AbortSignal.timeout(90000),
    });
    for (const [event, status] of [
      ['test:pass', 'passed'],
      ['test:fail', 'failed'],
    ])
      stream.on(event, data =>
        report.outcomes.push({
          name: data.name,
          status,
          skip: Boolean(data.skip),
          durationMs: data.details?.duration_ms,
        }),
      );
    stream.on('test:summary', summary => {
      if (!summary.file) report.summary = summary;
    });
    for await (const line of stream.compose(spec)) {
      fs.appendFileSync(path.join(directory, 'tests.log'), line);
      process.stdout.write(line);
    }
    report.sourcesAfter = sources();
    report.sourcesUnchanged =
      JSON.stringify(report.sourcesAfter) === JSON.stringify(report.sources);
    report.status =
      accepted(report.summary, report.outcomes) && report.sourcesUnchanged ? 'PASS' : 'FAIL';
  } catch (error) {
    report.status = 'FAIL';
    report.error = String(error.stack || error);
  } finally {
    if (previousEvidence === undefined) delete process.env.HARNESS_WORKSPACE_ACCEPTANCE_EVIDENCE;
    else process.env.HARNESS_WORKSPACE_ACCEPTANCE_EVIDENCE = previousEvidence;
    report.endedAt = new Date().toISOString();
    save();
    console.log(report.status + ': ' + path.join(directory, 'report.json'));
    process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 2 : 1;
  }
}
module.exports = { accepted, cases };
if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
