const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');

test(
  'Linux current-user descendants retain user permissions without bubblewrap and preserve session environment filtering',
  { skip: process.platform !== 'linux', timeout: 15000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-current-user-'));
    const project = path.join(directory, 'project');
    const share = path.join(directory, 'share');
    const state = path.join(directory, 'state');
    for (const item of [project, share, state]) fs.mkdirSync(item);
    const socket = path.join(directory, 'host.sock');
    let connected = false;
    const server = net.createServer(client => {
      connected = true;
      client.end('HOST_SOCKET_OK');
    });
    let launcher;
    t.after(async () => {
      try {
        if (server.listening) await new Promise(resolve => server.close(resolve));
      } finally {
        launcher?.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    const originalHostOnly = process.env.HARNESS_LINUX_HOST_ONLY;
    process.env.HARNESS_LINUX_HOST_ONLY = 'host-only-fixture';
    t.after(() => {
      if (originalHostOnly === undefined) delete process.env.HARNESS_LINUX_HOST_ONLY;
      else process.env.HARNESS_LINUX_HOST_ONLY = originalHostOnly;
    });
    launcher = createProcessSandbox({
      executable: process.execPath,
      projectDir: project,
      shareDir: share,
      protectedPaths: [state],
      // Absolute Node execution must not require a sandbox helper on PATH.
      environment: { ...process.env, PATH: '', HARNESS_LINUX_CHILD_VALUE: 'CHILD_ENV_OK' },
      hostOnlyEnv: ['HARNESS_LINUX_HOST_ONLY'],
    });
    assert.equal(launcher.envIsolated, true);
    assert.equal(launcher.boundary.platform, 'linux');
    assert.equal(launcher.boundary.mechanism, 'current-user');
    assert.equal(launcher.boundary.osIsolation, false);
    assert.equal(launcher.boundary.projectWritable, true);
    assert.equal(launcher.env.HARNESS_LINUX_HOST_ONLY, undefined);
    assert.equal(launcher.env.KIMI_SHARE_DIR, fs.realpathSync(share));
    assert.equal(launcher.env.KIMI_CODE_HOME, fs.realpathSync(share));
    assert.equal(launcher.workDir, path.join(fs.realpathSync(share), 'workspace'));
    assert.equal(fs.statSync(launcher.env.TMPDIR).isDirectory(), true);

    const probe = `
      const fs = require('node:fs');
      const path = require('node:path');
      const net = require('node:net');
      const { spawnSync } = require('node:child_process');
      const [project, state, socket] = process.argv.slice(1);
      fs.writeFileSync(path.join(project, 'native.txt'), 'PROJECT_WRITE_OK');
      fs.writeFileSync(path.join(state, 'native.txt'), 'STATE_WRITE_OK');
      fs.writeFileSync(path.join(process.cwd(), 'workspace.txt'), 'WORKSPACE_WRITE_OK');
      fs.writeFileSync(path.join(process.env.TMPDIR, 'scratch.txt'), 'SCRATCH_WRITE_OK');
      const descendant = spawnSync(process.execPath, ['-e',
        'require("node:fs").writeFileSync(process.argv[1], "DESCENDANT_WRITE_OK"); process.stdout.write(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), hostOnly: process.env.HARNESS_LINUX_HOST_ONLY ?? null }));',
        path.join(project, 'descendant.txt')], { encoding: 'utf8', timeout: 5000 });
      if (descendant.error) throw descendant.error;
      if (descendant.status !== 0) throw Error(descendant.stderr);
      const client = net.connect(socket);
      let response = '';
      client.setEncoding('utf8');
      client.on('data', chunk => response += chunk);
      client.on('error', error => { throw error; });
      client.on('end', () => process.stdout.write(JSON.stringify({
        uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(),
        hostOnly: process.env.HARNESS_LINUX_HOST_ONLY ?? null,
        childValue: process.env.HARNESS_LINUX_CHILD_VALUE, path: process.env.PATH,
        share: process.env.KIMI_SHARE_DIR, home: process.env.KIMI_CODE_HOME,
        scratch: process.env.TMPDIR, socket: response,
        descendant: JSON.parse(descendant.stdout),
      })));
    `;
    const child = (launcher.spawn || spawn)(
      launcher.executable,
      ['-e', probe, project, state, socket],
      {
        cwd: launcher.workDir,
        env: launcher.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      },
    );
    const result = await new Promise((resolve, reject) => {
      let stdout = '',
        stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr || String(result.signal));
    const report = JSON.parse(result.stdout);
    assert.equal(report.uid, process.getuid());
    assert.equal(report.gid, process.getgid());
    assert.equal(report.cwd, launcher.workDir);
    assert.equal(report.hostOnly, null);
    assert.equal(report.childValue, 'CHILD_ENV_OK');
    assert.equal(report.path, '');
    assert.equal(report.share, launcher.env.KIMI_SHARE_DIR);
    assert.equal(report.home, launcher.env.KIMI_CODE_HOME);
    assert.equal(report.scratch, launcher.env.TMPDIR);
    assert.equal(report.socket, 'HOST_SOCKET_OK');
    assert.equal(connected, true);
    assert.deepEqual(report.descendant, {
      uid: process.getuid(),
      gid: process.getgid(),
      hostOnly: null,
    });
    for (const [file, content] of [
      [path.join(project, 'native.txt'), 'PROJECT_WRITE_OK'],
      [path.join(state, 'native.txt'), 'STATE_WRITE_OK'],
      [path.join(project, 'descendant.txt'), 'DESCENDANT_WRITE_OK'],
      [path.join(launcher.workDir, 'workspace.txt'), 'WORKSPACE_WRITE_OK'],
      [path.join(launcher.env.TMPDIR, 'scratch.txt'), 'SCRATCH_WRITE_OK'],
    ])
      assert.equal(fs.readFileSync(file, 'utf8'), content);
  },
);
