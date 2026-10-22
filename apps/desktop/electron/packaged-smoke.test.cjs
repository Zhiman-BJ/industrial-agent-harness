const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'scripts/smoke-packaged-desktop.cjs'), 'utf8');

function fixture() {
  const app = '/repo/dist/desktop-release/mac-arm64/Industrial Agent Harness.app';
  const executable = app + '/Contents/MacOS/Industrial Agent Harness';
  const legacyScreenshot = '/tmp/smoke-tests/industrial-harness-first-run-darwin-arm64.png';
  const files = new Map([[legacyScreenshot, 'previous capture']]);
  let runId = 0;
  return {
    files,
    legacyScreenshot,
    run(capture) {
      let screenshot, error;
      const context = vm.createContext({
        __dirname: '/repo/scripts',
        process: {
          platform: 'darwin',
          arch: 'arm64',
          argv: ['node', 'smoke-packaged-desktop.cjs'],
          env: {},
          stdout: { write() {} },
          stderr: { write() {} },
        },
      });
      const dependencies = {
        'node:fs': {
          readdirSync: () => ['mac-arm64'],
          existsSync: file => file === app || file === executable || files.has(file),
          realpathSync: file => file,
          statSync: file => (files.has(file) ? { isFile: () => true } : undefined),
          mkdirSync() {},
          writeFileSync: (file, bytes) => files.set(file, bytes),
        },
        'node:os': { tmpdir: () => '/tmp/smoke-tests' },
        'node:path': path.posix,
        'node:crypto': { randomUUID: () => `capture-${++runId}` },
        'node:assert/strict': assert,
        'node:child_process': {
          spawnSync: (command, args, options) => {
            assert.equal(command, executable);
            assert.deepEqual(Array.from(args), ['--packaged-smoke']);
            screenshot = options.env.HARNESS_PACKAGED_SMOKE_SCREENSHOT;
            if (capture) files.set(screenshot, 'current capture');
            return {
              status: 0,
              stdout: JSON.stringify({ firstRunDomains: [], packagedLocalExecution: {} }) + '\n',
              stderr: '',
            };
          },
        },
        // These independent probes stay fixed while capture freshness varies.
        './smoke-packaged-layout.cjs': { verifyPackagedLayout: () => ({ externalRead: true }) },
        '../apps/desktop/electron/packaged-runtime-selftest.cjs': { verify() {} },
        '@zhiman-bj/industrial-domain-packs': vm.runInContext(
          '({consumerMetadata: () => ({domains: []})})',
          context,
        ),
      };
      context.require = name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
        return dependencies[name];
      };
      try {
        vm.runInContext(source, context, { filename: 'smoke-packaged-desktop.cjs' });
      } catch (caught) {
        error = caught;
      }
      const saved = files.get('/repo/dist/ci-reports/desktop-first-run.json');
      return { error, screenshot, report: saved ? JSON.parse(saved) : null };
    },
  };
}

test('a legacy screenshot cannot satisfy a new packaged smoke run', () => {
  const instance = fixture();
  const result = instance.run(false);
  assert.match(result.error?.message || '', /Packaged Desktop first-run smoke failed/);
  assert.notEqual(result.screenshot, instance.legacyScreenshot);
  assert.equal(instance.files.get(instance.legacyScreenshot), 'previous capture');
  assert.equal(result.report, null);
});

test('an earlier smoke capture cannot hide a later missing screenshot', () => {
  const instance = fixture();
  const first = instance.run(true);
  assert.equal(first.error, undefined);
  const second = instance.run(false);
  assert.notEqual(first.screenshot, second.screenshot);
  assert.match(second.error?.message || '', /Packaged Desktop first-run smoke failed/);
  assert.equal(instance.files.get(first.screenshot), 'current capture');
  assert.equal(instance.files.has(second.screenshot), false);
});

test('each successful smoke report records its own capture without deleting another run', () => {
  const instance = fixture();
  const first = instance.run(true);
  const second = instance.run(true);
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.notEqual(first.screenshot, second.screenshot);
  assert.equal(first.report.screenshot, first.screenshot);
  assert.equal(second.report.screenshot, second.screenshot);
  assert.equal(instance.files.has(first.screenshot), true);
  assert.equal(instance.files.has(second.screenshot), true);
});

function releaseSmoke() {
  const workflow = fs
    .readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8')
    .replace(/\r\n/g, '\n');
  const steps = workflow.split(/(?=^ {6}- name: )/m);
  const step = steps.find(item =>
    item.startsWith('      - name: Verify packaged application first run\n'),
  );
  assert.ok(step, 'The installer release must retain its packaged smoke step.');
  assert.match(step, /^ {8}shell: bash$/m);
  const commands = step
    .slice(step.indexOf('        run: |\n') + '        run: |\n'.length)
    .trim()
    .split('\n')
    .map(line => line.trim());
  assert.deepEqual(commands, [
    'node scripts/smoke-packaged-desktop.cjs',
    'node scripts/smoke-packaged-kimi.cjs',
  ]);
  return commands.join('\n');
}

function bashExecutable() {
  if (process.platform === 'win32') {
    const gitBash = path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Git',
      'bin',
      'bash.exe',
    );
    if (fs.existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

test('release smoke uses Bash and stops before Kimi when the desktop smoke fails', () => {
  const result = spawnSync(
    bashExecutable(),
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `node() { printf '%s\\n' "$1"; if [ "$1" = scripts/smoke-packaged-desktop.cjs ]; then return 23; fi; }\n${releaseSmoke()}`,
    ],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /smoke-packaged-desktop\.cjs/);
  assert.doesNotMatch(result.stdout, /smoke-packaged-kimi\.cjs/);
});

test('release smoke still runs both commands after a successful desktop smoke', () => {
  const result = spawnSync(
    bashExecutable(),
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `node() { printf '%s\\n' "$1"; }\n${releaseSmoke()}`,
    ],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout
      .trim()
      .split('\n')
      .map(line => line.trim()),
    ['scripts/smoke-packaged-desktop.cjs', 'scripts/smoke-packaged-kimi.cjs'],
  );
});
