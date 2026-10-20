const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  prepareMacGui,
  openMacGui,
  validateOptions,
  selectMacGuiEnvironment,
} = require('../scripts/mac-gui.cjs');

function fixture(t, { links = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac-gui-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktopRoot = path.join(root, 'desktop');
  const electron = path.join(desktopRoot, 'node_modules/electron');
  const app = path.join(electron, 'dist/Electron.app');
  for (const directory of [
    'electron',
    'dist',
    'node_modules/electron/dist/Electron.app/Contents/MacOS',
    'node_modules/electron/dist/Electron.app/Contents/Resources',
  ])
    fs.mkdirSync(path.join(desktopRoot, directory), { recursive: true });
  fs.writeFileSync(
    path.join(desktopRoot, 'package.json'),
    JSON.stringify({
      name: '@industrial-agent-harness/desktop',
      version: '1.0.1-beta.6',
      devDependencies: { electron: '44.0.0' },
    }),
  );
  fs.writeFileSync(path.join(desktopRoot, 'electron/main.cjs'), '// real source entry fixture\n');
  fs.writeFileSync(path.join(desktopRoot, 'dist/index.html'), '<title>Built desktop</title>');
  fs.writeFileSync(
    path.join(electron, 'package.json'),
    JSON.stringify({ name: 'electron', version: '44.0.0' }),
  );
  fs.writeFileSync(path.join(app, 'Contents/MacOS/Electron'), 'official executable fixture');
  fs.writeFileSync(path.join(app, 'Contents/Resources/LICENSE'), 'upstream license notice');
  const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework');
  fs.mkdirSync(path.join(framework, 'Versions/A'), { recursive: true });
  fs.writeFileSync(
    path.join(framework, 'Versions/A/Electron Framework'),
    'official framework fixture',
  );
  if (links) {
    fs.symlinkSync('A', path.join(framework, 'Versions/Current'));
    fs.symlinkSync(
      'Versions/Current/Electron Framework',
      path.join(framework, 'Electron Framework'),
    );
  }
  fs.writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.electron</string><key>CFBundleExecutable</key><string>Electron</string></dict></plist>',
  );
  const signed = [];
  const dependencies = { platform: 'darwin', signApp: destination => signed.push(destination) };
  return { root, desktopRoot, app, signed, dependencies };
}

test('GUI launcher rejects unsupported platforms, injected flags and unsafe environments before creating output', t => {
  const f = fixture(t);
  assert.throws(
    () => prepareMacGui({ desktopRoot: f.desktopRoot }, { platform: 'linux' }),
    /only on macOS/,
  );
  for (const args of [
    ['--no-sandbox'],
    ['--ui-selftest; touch /tmp/should-not-exist'],
    ['--ui-selftest', '--language-selftest'],
    ['--inspect=9229'],
    ['--packaged-smoke'],
  ])
    assert.throws(() => validateOptions({ args }), /supported selftest flag/);
  assert.throws(() => validateOptions({ args: ['--ui-selftest'], mode: 'dev' }), /does not match/);
  assert.throws(
    () => validateOptions({ env: { OPENAI_API_KEY: 'do-not-copy' } }),
    /Unsupported GUI environment variable: OPENAI_API_KEY/,
  );
  assert.throws(
    () => validateOptions({ env: { INDUSTRIAL_UI_SCREENSHOTS: 'relative/output' } }),
    /must be absolute/,
  );
  assert.throws(
    () => validateOptions({ mode: 'dev', env: { INDUSTRIAL_DEV_URL: 'https://remote.example/' } }),
    /loopback/,
  );
  assert.throws(
    () =>
      validateOptions({ mode: 'dev', env: { INDUSTRIAL_DEV_URL: 'http://token@127.0.0.1:5173/' } }),
    /loopback/,
  );
  assert.throws(
    () =>
      validateOptions({
        mode: 'dev',
        env: { INDUSTRIAL_DEV_URL: 'http://127.0.0.1:5173/?token=secret' },
      }),
    /loopback/,
  );
  assert.throws(
    () => validateOptions({ env: { INDUSTRIAL_UI_SCREENSHOTS: '/tmp/output\ncommand' } }),
    /Invalid GUI environment/,
  );
  assert.deepEqual(fs.readdirSync(f.root), ['desktop']);
  const env = selectMacGuiEnvironment({
    HOME: '/private/home',
    OPENAI_API_KEY: 'secret',
    INDUSTRIAL_DEV_URL: 'http://127.0.0.1:5173/',
    INDUSTRIAL_UI_SCREENSHOTS: '/tmp/shots',
  });
  assert.deepEqual(env, { INDUSTRIAL_UI_SCREENSHOTS: '/tmp/shots' });
});

test(
  'preparation copies the pinned Electron into unique private bundles without changing upstream files',
  { skip: process.platform !== 'darwin' },
  t => {
    const f = fixture(t, { links: true });
    const sourcePlist = fs.readFileSync(path.join(f.app, 'Contents/Info.plist'));
    const sourceExecutable = fs.readFileSync(path.join(f.app, 'Contents/MacOS/Electron'));
    const options = {
      desktopRoot: f.desktopRoot,
      outputRoot: f.root,
      args: ['--ui-selftest'],
      env: { INDUSTRIAL_UI_SCREENSHOTS: '/tmp/explicit-shots' },
    };
    const first = prepareMacGui(options, f.dependencies);
    const second = prepareMacGui(options, f.dependencies);
    assert.notEqual(first.appPath, second.appPath);
    assert.notEqual(first.runId, second.runId);
    assert.deepEqual(f.signed, [first.appPath, second.appPath]);
    assert.equal(fs.statSync(first.runDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(first.configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(first.logPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(path.join(f.app, 'Contents/Info.plist')), sourcePlist);
    assert.deepEqual(
      fs.readFileSync(path.join(f.app, 'Contents/MacOS/Electron')),
      sourceExecutable,
    );
    assert.equal(
      fs.readFileSync(path.join(first.appPath, 'Contents/Resources/LICENSE'), 'utf8'),
      'upstream license notice',
    );
    assert.ok(fs.existsSync(path.join(first.appPath, 'Contents/MacOS/Electron')));
    const copiedLink = path.join(
      first.appPath,
      'Contents/Frameworks/Electron Framework.framework/Versions/Current',
    );
    assert.equal(fs.readlinkSync(copiedLink), 'A', 'relative framework links stay relative');
    assert.ok(
      fs.realpathSync(copiedLink).startsWith(first.appPath + path.sep),
      'the copied app is independent of the upstream dependency',
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(first.appPath, 'Contents/Resources/app/package.json')),
    );
    assert.equal(packageJson.name, '@industrial-agent-harness/desktop');
    assert.equal(packageJson.version, '1.0.1-beta.6');
    const config = JSON.parse(fs.readFileSync(first.configPath));
    assert.equal(config.main, path.join(f.desktopRoot, 'electron/main.cjs'));
    assert.deepEqual(config.env, { INDUSTRIAL_UI_SCREENSHOTS: '/tmp/explicit-shots' });
    assert.equal(
      fs.existsSync(first.resultPath),
      false,
      'preparing an app does not report a completed test',
    );
  },
);

test('missing build, wrong Electron version and signing errors never report a prepared success', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.desktopRoot, 'dist/index.html'));
  assert.throws(
    () => prepareMacGui({ desktopRoot: f.desktopRoot }, f.dependencies),
    /Build the desktop/,
  );
  const dev = prepareMacGui(
    {
      desktopRoot: f.desktopRoot,
      outputRoot: f.root,
      mode: 'dev',
      env: { INDUSTRIAL_DEV_URL: 'http://127.0.0.1:5173/' },
    },
    f.dependencies,
  );
  assert.equal(dev.mode, 'dev');
  fs.writeFileSync(path.join(f.desktopRoot, 'dist/index.html'), 'built');
  fs.writeFileSync(
    path.join(f.desktopRoot, 'node_modules/electron/package.json'),
    JSON.stringify({ version: '43.0.0' }),
  );
  assert.throws(
    () => prepareMacGui({ desktopRoot: f.desktopRoot }, f.dependencies),
    /pinned dependency/,
  );
  fs.writeFileSync(
    path.join(f.desktopRoot, 'node_modules/electron/package.json'),
    JSON.stringify({ version: '44.0.0' }),
  );
  assert.throws(
    () =>
      prepareMacGui(
        { desktopRoot: f.desktopRoot, outputRoot: f.root },
        {
          platform: 'darwin',
          signApp() {
            throw Error('signature verification failed');
          },
        },
      ),
    /preparation failed/,
  );
  const results = fs
    .readdirSync(f.root)
    .filter(name => name.startsWith('harness-mac-gui-'))
    .map(name => path.join(f.root, name, 'result.json'))
    .filter(file => fs.existsSync(file));
  assert.equal(results.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(results[0])).completed, false);
});

test(
  'escaping bundle links are rejected before signing rather than following upstream paths',
  { skip: process.platform !== 'darwin' },
  t => {
    const f = fixture(t);
    fs.symlinkSync(f.root, path.join(f.app, 'Contents/Resources/outside'));
    assert.throws(
      () => prepareMacGui({ desktopRoot: f.desktopRoot, outputRoot: f.root }, f.dependencies),
      /preparation failed/,
    );
    assert.deepEqual(f.signed, [], 'a bundle with an external link is never signed');
  },
);

function runBootstrap(
  t,
  {
    marker,
    code = 0,
    packaged = false,
    ready = false,
    failure,
    args = ['--ui-selftest'],
    reuse,
    onMain,
    mirroredLogFailure = false,
  } = {},
) {
  const f = reuse?.f || fixture(t);
  const prepared =
    reuse?.prepared ||
    prepareMacGui({ desktopRoot: f.desktopRoot, outputRoot: f.root, args }, f.dependencies);
  const config = JSON.parse(fs.readFileSync(prepared.configPath));
  const output = path.join(f.root, 'native-output');
  const outputFd = fs.openSync(output, 'a');
  const fsMock = {
    ...fs,
    writeSync(fd, ...parameters) {
      return fs.writeSync(fd === 1 || fd === 2 ? outputFd : fd, ...parameters);
    },
    appendFileSync(file, data, ...parameters) {
      if (mirroredLogFailure && String(data).includes(' stderr '))
        throw Error('log mirror unavailable');
      return fs.appendFileSync(file, data, ...parameters);
    },
  };
  const app = new EventEmitter();
  app.isPackaged = packaged;
  app.isReady = () => ready;
  let appExit;
  app.exit = value => {
    appExit = value;
  };
  const processMock = new EventEmitter();
  Object.assign(processMock, {
    env: { INDUSTRIAL_DEV_URL: 'http://unapproved.example/', SOME_EXISTING_ENV: 'retained' },
    argv: ['Electron', '--unapproved'],
    execPath: path.join(prepared.appPath, 'Contents/MacOS/Electron'),
    chdir(directory) {
      this.cwd = directory;
    },
  });
  const consoleMock = {};
  const calls = [];
  const bootstrapPath = path.join(prepared.appPath, 'Contents/Resources/app/launcher.cjs');
  vm.runInNewContext(fs.readFileSync(bootstrapPath, 'utf8'), {
    __dirname: path.dirname(bootstrapPath),
    Buffer,
    console: consoleMock,
    process: processMock,
    require(name) {
      if (name === 'electron') return { app };
      if (name === 'node:fs') return fsMock;
      if (name === config.main) {
        calls.push(name);
        onMain?.({ fs: fsMock, config, outputFd });
        if (failure) throw Error(failure);
        if (marker) consoleMock.log(marker);
        return {};
      }
      return require(name);
    },
  });
  processMock.emit('exit', appExit ?? code);
  fs.closeSync(outputFd);
  return { f, prepared, config, calls, processMock, appExit, output };
}

test('GUI bootstrap synchronously loads the exact real main with curated argv and environment', t => {
  const result = runBootstrap(t, { marker: 'UI selftest passed: real assertions finished.' });
  assert.deepEqual(result.calls, [path.join(result.f.desktopRoot, 'electron/main.cjs')]);
  assert.equal(result.processMock.cwd, result.f.desktopRoot);
  assert.deepEqual(result.processMock.argv.slice(1), [result.f.desktopRoot, '--ui-selftest']);
  assert.equal(result.processMock.env.INDUSTRIAL_DEV_URL, undefined);
  assert.equal(result.processMock.env.SOME_EXISTING_ENV, 'retained');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.prepared.resultPath)), {
    runId: result.prepared.runId,
    attemptId: JSON.parse(fs.readFileSync(result.prepared.resultPath)).attemptId,
    mode: 'selftest',
    args: ['--ui-selftest'],
    completed: true,
    exitCode: 0,
    passed: true,
    recordedBy: 'process-exit',
    loggingIncomplete: false,
    finishedAt: JSON.parse(fs.readFileSync(result.prepared.resultPath)).finishedAt,
  });
});

test('zero exit alone and a different selftest marker do not establish UI selftest completion', t => {
  for (const marker of [
    undefined,
    'Message rail selftest passed: nested check only.',
    '{"ok":true}',
  ]) {
    const result = runBootstrap(t, { marker });
    const status = JSON.parse(fs.readFileSync(result.prepared.resultPath));
    assert.equal(status.completed, false);
    assert.equal(status.passed, false);
    assert.equal(status.exitCode, 0);
  }
  const result = runBootstrap(t, { marker: 'UI selftest passed: assertions finished.', code: 1 });
  assert.equal(JSON.parse(fs.readFileSync(result.prepared.resultPath)).passed, false);
  const unknownMarker = runBootstrap(t, { args: ['--kicad-selftest'], marker: '{"ok":true}' });
  assert.equal(
    JSON.parse(fs.readFileSync(unknownMarker.prepared.resultPath)).completed,
    false,
    'a suite without a registered dedicated marker stays unconfirmed',
  );
});

test('a synchronous source main failure is logged and records a failed result', t => {
  const result = runBootstrap(t, { failure: 'source entry failed before app.ready' });
  const status = JSON.parse(fs.readFileSync(result.prepared.resultPath));
  assert.equal(status.exitCode, 1);
  assert.equal(status.completed, false);
  assert.equal(result.appExit, 1);
  assert.match(
    fs.readFileSync(result.prepared.logPath, 'utf8'),
    /source entry failed before app.ready/,
  );
});

test('direct startup fd writes are mirrored with native signatures, byte counts and errors preserved', t => {
  const result = runBootstrap(t, {
    code: 1,
    onMain({ fs: sourceFs, outputFd }) {
      const text = 'UI selftest timed out: .ia-onboarding\n';
      assert.equal(sourceFs.writeSync(2, text), Buffer.byteLength(text));
      assert.equal(sourceFs.writeSync(1, '中文🙂', null, 'utf8'), Buffer.byteLength('中文🙂'));
      assert.equal(sourceFs.writeSync(2, Buffer.from('skip|offset|tail'), 5, 6, null), 6);
      assert.equal(
        sourceFs.writeSync(2, new Uint8Array(Buffer.from('skip|options|tail')), {
          offset: 5,
          length: 7,
        }),
        7,
      );
      const viewBytes = Buffer.from('xviewz');
      assert.equal(
        sourceFs.writeSync(
          2,
          new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.length),
          1,
          4,
        ),
        4,
      );
      assert.throws(() => sourceFs.writeSync(2, Buffer.from('invalid'), -1, 1), {
        code: 'ERR_OUT_OF_RANGE',
      });
      sourceFs.writeSync(outputFd, 'ordinary-file-only');
    },
  });
  const log = fs.readFileSync(result.prepared.logPath, 'utf8');
  assert.match(log, /stderr UI selftest timed out: \.ia-onboarding/);
  assert.match(log, /stdout 中文🙂/);
  assert.match(log, /stderr offset/);
  assert.match(log, /stderr options/);
  assert.match(log, /stderr view/);
  assert.doesNotMatch(log, /ordinary-file-only/);
  const output = fs.readFileSync(result.output, 'utf8');
  assert.match(output, /timed out/);
  assert.match(output, /offsetoptionsviewordinary-file-only/);
  assert.equal(JSON.parse(fs.readFileSync(result.prepared.resultPath)).exitCode, 1);
});

test('a failed log mirror preserves the successful native write and marks evidence incomplete', t => {
  const result = runBootstrap(t, {
    mirroredLogFailure: true,
    onMain({ fs: sourceFs }) {
      assert.equal(sourceFs.writeSync(2, 'real stderr output'), 18);
    },
  });
  assert.equal(fs.readFileSync(result.output, 'utf8'), 'real stderr output');
  assert.equal(JSON.parse(fs.readFileSync(result.prepared.resultPath)).loggingIncomplete, true);
});

test('reopening the same prepared app removes stale results and records a new launch attempt', t => {
  const first = runBootstrap(t, { marker: 'UI selftest passed: first attempt.' });
  const previous = JSON.parse(fs.readFileSync(first.prepared.resultPath));
  assert.equal(previous.passed, true);
  const second = runBootstrap(t, {
    reuse: first,
    code: 1,
    onMain({ config }) {
      assert.equal(
        fs.existsSync(config.resultPath),
        false,
        'old success is removed before loading main',
      );
    },
  });
  const current = JSON.parse(fs.readFileSync(second.prepared.resultPath));
  assert.equal(current.runId, previous.runId);
  assert.notEqual(current.attemptId, previous.attemptId);
  assert.equal(current.passed, false);
  assert.match(fs.readFileSync(second.prepared.logPath, 'utf8'), new RegExp(current.attemptId));
});

test('packaged or late bootstrap refuses the source entry and records failure', t => {
  for (const options of [{ packaged: true }, { ready: true }]) {
    const result = runBootstrap(t, options);
    assert.deepEqual(result.calls, []);
    assert.equal(result.appExit, 1);
    const status = JSON.parse(fs.readFileSync(result.prepared.resultPath));
    assert.equal(status.completed, false);
    assert.equal(status.exitCode, 1);
    assert.match(fs.readFileSync(result.prepared.logPath, 'utf8'), /before app.ready/);
  }
});

test('normal open invokes LaunchServices once with literal arguments and never retries failure', () => {
  const calls = [];
  const prepared = { appPath: '/tmp/private run/Harness-GUI.app' };
  assert.throws(
    () =>
      openMacGui(prepared, (...args) => {
        calls.push(args);
        return { status: 1, stderr: 'LaunchServices unavailable' };
      }),
    /could not open.*LaunchServices unavailable/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    '/usr/bin/open',
    ['-n', '-a', prepared.appPath],
    { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 1024 * 1024 },
  ]);
});
