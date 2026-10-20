const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');
const { buildIsolationPolicy } = require('../src/agent-isolation.cjs');

const darwin = { skip: process.platform !== 'darwin', timeout: 15000 };

function fixture(t, options = {}) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-isolation-test-')),
  );
  const project = path.join(directory, 'project');
  const settings = path.join(directory, 'settings');
  const share = path.join(settings, 'chats', 'session');
  const secrets = path.join(directory, 'secrets');
  fs.mkdirSync(project);
  fs.mkdirSync(share, { recursive: true });
  fs.mkdirSync(secrets);
  fs.writeFileSync(path.join(project, 'spec.md'), 'engineering source');
  fs.writeFileSync(path.join(secrets, 'id_rsa'), 'private key');
  const launcher = createProcessSandbox({
    executable: process.execPath,
    projectDir: project,
    shareDir: share,
    protectedPaths: [settings],
    sensitiveReadPaths: [secrets],
    ...options,
  });
  t.after(() => {
    launcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, project, settings, share, secrets, launcher };
}

async function capture(child) {
  let stdout = '',
    stderr = '';
  child.stdout.on('data', bytes => (stdout += bytes));
  child.stderr.on('data', bytes => (stderr += bytes));
  const [code, signal] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

// Probe contract: writes report true only when they landed; reads likewise.
const PROBE = `
const fs = require('node:fs'), net = require('node:net');
const out = {};
for (const [name, file] of Object.entries(JSON.parse(process.argv[1]))) {
  try { fs.writeFileSync(file, 'bypass'); out[name] = true; }
  catch (error) { out[name] = false; }
}
for (const [name, file] of Object.entries(JSON.parse(process.argv[2]))) {
  try { fs.readFileSync(file); out[name] = true; }
  catch (error) { out[name] = false; }
}
const socketPath = process.argv[3];
if (socketPath) {
  const socket = net.connect(socketPath);
  socket.once('connect', () => { out.unixSocket = true; console.log(JSON.stringify(out)); process.exit(0); });
  socket.once('error', () => { out.unixSocket = false; console.log(JSON.stringify(out)); process.exit(0); });
} else console.log(JSON.stringify(out));
`;

test(
  'isolated descendant cannot write the project, protected roots or lateral files, but writes share and scratch',
  darwin,
  async t => {
    const f = fixture(t);
    assert.equal(f.launcher.boundary.osIsolation, true);
    assert.equal(f.launcher.boundary.mechanism, 'seatbelt');
    assert.equal(f.launcher.boundary.projectWritable, false);
    const result = await capture(
      f.launcher.spawn(
        process.execPath,
        [
          '-e',
          PROBE,
          JSON.stringify({
            project: path.join(f.project, 'evil.txt'),
            settings: path.join(f.settings, 'state.sqlite'),
            lateral: path.join(f.directory, 'lateral.txt'),
            share: path.join(f.share, 'context.json'),
            scratch: path.join(f.launcher.directory, 'scratch', 'note.txt'),
          }),
          '{}',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      project: false,
      settings: false,
      lateral: false,
      share: true,
      scratch: true,
    });
    assert.equal(fs.readFileSync(path.join(f.project, 'spec.md'), 'utf8'), 'engineering source');
  },
);

test(
  'isolated descendant reads the project but cannot read credential paths or connect host unix sockets',
  darwin,
  async t => {
    const f = fixture(t);
    const socketPath = path.join(f.directory, 'runtime.sock');
    const server = net.createServer().listen(socketPath);
    await once(server, 'listening');
    t.after(() => server.close());
    // Structural: the Seatbelt profile carries the hardening rules.
    const profile = fs.readFileSync(path.join(f.launcher.directory, 'agent.sb'), 'utf8');
    assert.ok(profile.includes('(deny network-outbound (remote unix-socket))'), profile);
    assert.ok(
      profile.includes(`(deny file-read* (subpath ${JSON.stringify(f.secrets)}))`),
      profile,
    );
    // DNS must survive the unix-socket deny: the profile re-allows the
    // mDNSResponder system socket after the blanket deny.
    const denyAt = profile.indexOf('(deny network-outbound (remote unix-socket))');
    const allowAt = profile.indexOf('mDNSResponder');
    assert.ok(denyAt !== -1 && allowAt > denyAt, profile);
    const result = await capture(
      f.launcher.spawn(
        process.execPath,
        [
          '-e',
          PROBE,
          '{}',
          JSON.stringify({
            projectRead: path.join(f.project, 'spec.md'),
            secretRead: path.join(f.secrets, 'id_rsa'),
          }),
          socketPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      projectRead: true,
      secretRead: false,
      unixSocket: false,
    });
  },
);

test(
  'isolation off keeps the plain current-user launcher even when primitives exist',
  darwin,
  t => {
    const f = fixture(t, { isolation: 'off' });
    assert.equal(f.launcher.boundary.osIsolation, false);
    assert.equal(f.launcher.boundary.mechanism, 'current-user');
    assert.equal(f.launcher.boundary.projectWritable, true);
    assert.deepEqual(fs.readdirSync(f.launcher.directory), ['scratch']);
  },
);

test('isolation policy is pure data shaped after sandbox-runtime config', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.netrc'), 'machine example');
  const policy = buildIsolationPolicy({
    project: '/work/project',
    share: '/work/share',
    scratch: '/tmp/scratch',
    protectedRoots: ['/work/settings'],
    home,
  });
  assert.deepEqual(policy.filesystem.writable, ['/work/share', '/tmp/scratch']);
  assert.deepEqual(policy.filesystem.readOnly, ['/work/project', '/work/settings']);
  assert.deepEqual(policy.filesystem.denyRead, [
    path.join(home, '.ssh'),
    path.join(home, '.netrc'),
  ]);
  assert.equal(policy.network.tcp, 'allow');
  assert.equal(policy.network.outboundUnixSockets, 'deny');
});
