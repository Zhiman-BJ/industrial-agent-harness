const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  services,
  interpretProbe,
  probeGuiStartup,
  requireGuiStartup,
} = require('../scripts/gui-startup.cjs');
const { launchElectron } = require('../scripts/launch-electron.cjs');

const report = codes => ({ services: services.map((name, i) => ({ name, code: codes[i] })) });

test('GUI lookup distinguishes an explicit denial, unknown service and successful lookup', () => {
  assert.equal(interpretProbe(report([1100, 1100])).status, 'denied');
  assert.equal(interpretProbe(report([0, 1100])).status, 'denied');
  assert.equal(interpretProbe(report([0, 0])).status, 'available');
  assert.equal(interpretProbe(report([1102, 0])).status, 'unknown');
  assert.equal(interpretProbe({ services: [{ name: 'other', code: 1100 }] }).status, 'unknown');
  assert.equal(interpretProbe(report(['1100', 0])).status, 'unknown');
});

test('probe executes without AppKit, uses a private fresh directory and cleans up on success/failure', () => {
  let binary;
  const run = (file, args, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 15000);
    assert.equal(options.stdio, 'pipe');
    if (file === '/usr/bin/xcrun') {
      assert.equal(args[0], 'clang');
      assert.match(fs.readFileSync(args[1], 'utf8'), /bootstrap_look_up/);
      assert.doesNotMatch(fs.readFileSync(args[1], 'utf8'), /#include.*AppKit|NSApplication/);
      binary = args.at(-1);
      if (process.platform !== 'win32')
        assert.equal(fs.statSync(path.dirname(binary)).mode & 0o777, 0o700);
      return '';
    }
    assert.equal(file, binary);
    assert.deepEqual(args, []);
    return JSON.stringify(report([1100, 1100]));
  };
  assert.equal(probeGuiStartup({ platform: 'darwin', run }).status, 'denied');
  assert.equal(fs.existsSync(path.dirname(binary)), false);
  assert.equal(
    probeGuiStartup({
      platform: 'darwin',
      run() {
        throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
      },
    }).status,
    'unknown',
  );
  assert.equal(
    probeGuiStartup({
      platform: 'linux',
      run() {
        throw Error('must not compile');
      },
    }).status,
    'not-applicable',
  );
});

test('a denied preflight stops before Electron resolution or spawn and gives the desktop entry', () => {
  const preflight = () =>
    requireGuiStartup({
      platform: 'darwin',
      run: file => (file === '/usr/bin/xcrun' ? '' : JSON.stringify(report([1100, 1100]))),
    });
  assert.throws(
    () =>
      launchElectron(['--ui-selftest'], {
        preflight,
        resolveElectron() {
          throw Error('Electron must not be resolved');
        },
        spawnProcess() {
          throw Error('Electron must not be spawned');
        },
      }),
    error => error.code === 'MACOS_GUI_SERVICE_DENIED' && /gui:prepare/.test(error.message),
  );
});

test('normal launches preserve argument boundaries, environment and process lifecycle', () => {
  const env = { TEST_ONLY: 'present' };
  const child = new EventEmitter();
  assert.equal(
    launchElectron(['--ui-selftest'], {
      preflight: () => ({ status: 'available' }),
      env,
      resolveElectron: () => '/tmp/Electron app/Contents/MacOS/Electron',
      spawnProcess(binary, args, options) {
        assert.equal(binary, '/tmp/Electron app/Contents/MacOS/Electron');
        assert.equal(args[0], path.resolve(__dirname, '..'));
        assert.equal(args[1], '--ui-selftest');
        assert.equal(options.env, env);
        assert.equal(options.cwd, args[0]);
        assert.equal(options.shell, undefined);
        return child;
      },
    }),
    child,
  );
});

test('an inconclusive diagnostic stops safely without claiming a permission denial', () => {
  assert.throws(
    () =>
      launchElectron([], {
        preflight: () =>
          requireGuiStartup({
            platform: 'darwin',
            run() {
              throw Error('compiler unavailable');
            },
          }),
        resolveElectron() {
          throw Error('must not resolve Electron after an unknown preflight');
        },
        spawnProcess() {
          throw Error('must not spawn Electron after an unknown preflight');
        },
      }),
    error =>
      error.code === 'MACOS_GUI_DIAGNOSTIC_UNKNOWN' &&
      /could not be verified/.test(error.message) &&
      error.diagnostic.phase === 'compile' &&
      !/bootstrap code 1100/.test(error.message),
  );
});
