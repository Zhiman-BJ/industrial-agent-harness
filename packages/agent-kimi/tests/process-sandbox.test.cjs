const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');

const posix = { skip: !['darwin', 'linux'].includes(process.platform), timeout: 10000 };
function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-launch-test-')));
  const project = path.join(directory, 'project');
  const settings = path.join(directory, 'settings');
  const share = path.join(settings, 'chats', 'session');
  fs.mkdirSync(project);
  fs.mkdirSync(share, { recursive: true });
  const launcher = createProcessSandbox({
    executable: process.execPath,
    projectDir: project,
    shareDir: share,
    protectedPaths: [settings],
    ...options,
  });
  t.after(() => {
    launcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, project, settings, share, launcher };
}

async function capture(child) {
  let stdout = '',
    stderr = '';
  child.stdout.on('data', bytes => (stdout += bytes));
  child.stderr.on('data', bytes => (stderr += bytes));
  const [code, signal] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

test(
  'current-user descendants can write project and settings while session environment stays pinned',
  posix,
  async t => {
    const f = fixture(t, {
      isolation: 'off',
      environment: {
        PATH: '',
        KIMI_SHARE_DIR: 'foreign',
        SERVICE_TOKEN: 'host-only',
        OMIT: undefined,
      },
      hostOnlyEnv: ['SERVICE_TOKEN'],
    });
    const launcher = f.launcher;
    assert.equal(launcher.boundary.mechanism, 'current-user');
    assert.equal(launcher.boundary.osIsolation, false);
    assert.equal(launcher.boundary.projectWritable, true);
    assert.equal(launcher.envIsolated, true);
    assert.equal(launcher.projectAlias, false);
    assert.deepEqual(fs.readdirSync(launcher.directory), ['scratch']);
    assert.equal(launcher.executable, fs.realpathSync(process.execPath));
    const projectFile = path.join(f.project, 'source.txt');
    const stateFile = path.join(f.settings, 'state.txt');
    const result = await capture(
      launcher.spawn(
        process.execPath,
        [
          '-e',
          `
    const fs = require('node:fs');
    const child = require('node:child_process').spawnSync(process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "descendant-write")', process.argv[1]]);
    fs.writeFileSync(process.argv[2], 'current-user-write');
    fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'scratch.txt'), 'scratch-write');
    process.stdout.write(JSON.stringify({ status: child.status, cwd: process.cwd(),
      uid: process.getuid(), gid: process.getgid(), home: process.env.KIMI_CODE_HOME,
      share: process.env.KIMI_SHARE_DIR, temp: process.env.TMPDIR,
      secret: process.env.SERVICE_TOKEN ?? null, omitted: process.env.OMIT ?? null }));
  `,
          projectFile,
          stateFile,
        ],
        {
          cwd: launcher.workDir,
          env: {
            SERVICE_TOKEN: 'reintroduced',
            KIMI_CODE_HOME: 'wrong',
            KIMI_SHARE_DIR: 'wrong',
            TMPDIR: 'wrong',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 0,
      cwd: launcher.workDir,
      uid: process.getuid(),
      gid: process.getgid(),
      home: f.share,
      share: f.share,
      temp: path.join(launcher.directory, 'scratch') + path.sep,
      secret: null,
      omitted: null,
    });
    assert.equal(fs.readFileSync(projectFile, 'utf8'), 'descendant-write');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), 'current-user-write');
    launcher.close();
    assert.equal(fs.existsSync(launcher.directory), false);
    assert.equal(fs.existsSync(f.share), true);
    assert.throws(() => launcher.spawn(process.execPath, []), /closed/);
  },
);

test(
  'direct Node script launch preserves argv and project access without shell interpolation',
  posix,
  async t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-script-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const script = path.join(directory, 'entry with spaces.cjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const f = fixture(t, { executable: script, kimiProjectAccess: true });
    const argv = [
      '',
      'two words',
      'a"quoted"value',
      '尾部 Unicode',
      'trailing\\',
      '$(touch escaped); & | < >',
    ];
    const result = await capture(
      f.launcher.spawn(process.execPath, [script, ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['--add-dir', f.project, ...argv]);
    assert.equal(fs.existsSync(path.join(f.launcher.workDir, 'escaped')), false);
    assert.throws(() => f.launcher.spawn(process.execPath, [script], { shell: true }), /shell/);
    assert.throws(
      () => f.launcher.spawn(process.execPath, [script], { cwd: f.project }),
      /workspace/,
    );
    assert.throws(() => f.launcher.spawn(script, []), /bound executable/);
    assert.throws(
      () => f.launcher.spawn(process.execPath, [script], { uid: process.getuid() + 1 }),
      /current user/,
    );
  },
);

test(
  'session close stops a live child and descendant process group before removing scratch',
  posix,
  async t => {
    const f = fixture(t);
    const child = f.launcher.spawn(
      process.execPath,
      [
        '-e',
        `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'));
    process.on('SIGTERM', () => {});
    child.once('exit', () => process.exit(0));
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => child.kill('SIGKILL'));
    const [ready] = await once(child.stdout, 'data');
    const descendant = Number(ready.toString().trim());
    assert.ok(descendant > 0);
    const completed = once(child, 'close');
    f.launcher.close();
    await completed;
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(f.launcher.directory), false);
    assert.equal(fs.existsSync(f.share), true);
  },
);

test('session close escalates cancellation when the child ignores SIGTERM', posix, async t => {
  const f = fixture(t);
  const child = f.launcher.spawn(
    process.execPath,
    [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const completed = once(child, 'close');
  f.launcher.close();
  assert.equal((await completed)[1], 'SIGKILL');
  assert.equal(fs.existsSync(f.launcher.directory), false);
});

test(
  'session close kills remaining descendants after their group leader exits first',
  posix,
  async t => {
    const f = fixture(t);
    const pidFile = path.join(f.share, 'descendant.pid');
    const descendantScript = `process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const child = f.launcher.spawn(
      process.execPath,
      [
        '-e',
        `
    require('node:child_process').spawn(process.execPath,
      ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => child.kill('SIGKILL'));
    await once(child.stdout, 'data');
    const descendant = Number(fs.readFileSync(pidFile, 'utf8'));
    const exited = once(child, 'exit'),
      completed = once(child, 'close');
    f.launcher.close();
    assert.equal((await exited)[1], 'SIGTERM');
    assert.doesNotThrow(
      () => process.kill(descendant, 0),
      'descendant survives the leader SIGTERM',
    );
    assert.equal(
      fs.existsSync(f.launcher.directory),
      true,
      'scratch stays until descendant cleanup',
    );
    await completed;
    assert.equal(fs.existsSync(f.launcher.directory), false);
    assert.equal(child.kill('SIGKILL'), false, 'a retired group is never signalled again');
  },
);
