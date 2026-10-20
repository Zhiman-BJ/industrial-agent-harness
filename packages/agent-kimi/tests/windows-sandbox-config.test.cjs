const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { windowsEnvironment, inside } = require('../src/windows-sandbox.cjs');
const { createSession } = require('../src/code-session.cjs');

test('Windows credential exclusions are case insensitive and environment keys have one effective value', () => {
  assert.deepEqual(
    windowsEnvironment(
      {
        PATH: 'first',
        Path: 'last',
        SERVICE_TOKEN: 'secret',
        service_token: 'another',
        EMPTY: '',
        OMIT: undefined,
      },
      ['Service_Token'],
    ),
    { Path: 'last', EMPTY: '' },
  );
});

test('Windows storage comparisons distinguish sibling prefixes, volumes and path case', () => {
  assert.equal(inside('C:\\Session', 'c:\\session\\workspace'), true);
  assert.equal(inside('C:\\Session', 'C:\\SESSION'), true);
  assert.equal(inside('C:\\Session', 'C:\\Session-other'), false);
  assert.equal(inside('C:\\Session', 'C:\\Session\\..\\project'), false);
  assert.equal(inside('C:\\Session', 'D:\\Session\\workspace'), false);
});

test('native session dispatch uses the supplied launcher and never restores a removed host credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-protected-dispatch-'));
  const name = 'HARNESS_TEST_HOST_ONLY_DISPATCH';
  const previous = process.env[name];
  process.env[name] = 'host-only-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
  let calls = 0;
  const session = createSession({
    workDir: directory,
    shareDir: directory,
    env: { PATH: process.env.PATH },
    envIsolated: true,
    spawn(_executable, _args, options) {
      calls++;
      assert.equal(options.env[name], undefined);
      assert.equal(options.env.KIMI_CODE_HOME, directory);
      throw Error('controlled boundary launch refusal');
    },
  });
  t.after(() => session.close());
  await assert.rejects(session.initialize(), /controlled boundary launch refusal/);
  assert.equal(calls, 1, 'launcher refusal must not fall back to an unprotected spawn');
  assert.equal(session.child, undefined);
});

// Exercise the portable launch contract on every CI OS. Only the separate
// Windows-native suite qualifies Windows stdio, taskkill and real Kimi.
function launcherFixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'windows-launch-config-')),
  );
  const project = path.join(directory, 'project');
  const state = path.join(directory, 'settings');
  const share = path.join(state, 'chats', 'session');
  fs.mkdirSync(project);
  fs.mkdirSync(share, { recursive: true });
  const sandboxModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/windows-sandbox.cjs'), 'utf8'), {
    module: sandboxModule,
    require,
    process: { ...process, platform: 'win32' },
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    project,
    state,
    share,
    create: sandboxModule.exports.createWindowsProcessSandbox,
  };
}

test('Windows current-user launch accepts nested settings storage and reports no OS isolation', async t => {
  const f = launcherFixture(t);
  const launcher = f.create({
    executable: process.execPath,
    projectDir: f.project,
    shareDir: f.share,
    protectedPaths: [f.state],
    environment: { ...process.env, SERVICE_TOKEN: 'secret' },
    hostOnlyEnv: ['service_token'],
  });
  t.after(() => launcher.close());
  assert.equal(launcher.boundary.mechanism, 'current-user');
  assert.equal(launcher.boundary.osIsolation, false);
  assert.equal(launcher.boundary.projectWritable, true);
  assert.equal(launcher.envIsolated, true);
  const projectFile = path.join(f.project, 'source.txt');
  const child = launcher.spawn(
    process.execPath,
    [
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "CURRENT_USER_WRITE"); process.stdout.write(JSON.stringify({ home: process.env.KIMI_CODE_HOME, temp: process.env.TEMP, secret: process.env.service_token ?? process.env.SERVICE_TOKEN ?? null }));',
      projectFile,
    ],
    {
      env: { service_token: 'reintroduced', kimi_code_home: 'wrong', temp: 'wrong' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', value => (output += value));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const report = JSON.parse(output);
  assert.equal(report.secret, null);
  assert.equal(report.home, f.share);
  assert.equal(report.temp, path.join(launcher.directory, 'scratch'));
  assert.equal(fs.readFileSync(projectFile, 'utf8'), 'CURRENT_USER_WRITE');
  launcher.close();
  assert.equal(fs.existsSync(launcher.directory), false);
  assert.equal(fs.existsSync(f.share), true, 'closing preserves persistent conversation storage');
  assert.throws(() => launcher.spawn(process.execPath, []), /closed/);
});

test('Windows current-user launcher preserves literal script argv and refuses shell substitution', async t => {
  const f = launcherFixture(t);
  const script = path.join(f.directory, 'entry with spaces.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const launcher = f.create({
    executable: script,
    projectDir: f.project,
    shareDir: f.share,
    environment: process.env,
  });
  t.after(() => launcher.close());
  const args = ['', 'two words', 'a"quoted"value', '尾部 Unicode', 'trailing\\', '& | < > ^ % !'];
  const child = launcher.spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  assert.equal((await once(child, 'close'))[0], 0);
  assert.deepEqual(JSON.parse(output), args);
  assert.throws(() => launcher.spawn(process.execPath, [script], { shell: true }), /shell/);
  assert.throws(() => launcher.spawn(process.execPath, [script], { cwd: f.project }), /workspace/);
  assert.throws(() => launcher.spawn(script, []), /bound executable/);
});
