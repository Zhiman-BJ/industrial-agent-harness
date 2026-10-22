const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');
const {
  buildIsolationPolicy,
  detectIsolation,
  orderedWriteRules,
  seccompUnixSocketFilter,
  seatbeltProfile,
  bubblewrapArgs,
} = require('../src/agent-isolation.cjs');

const darwin = { skip: process.platform !== 'darwin', timeout: 15000 };
// Linux-only functional tests need a working bubblewrap on the host.
const linuxBwrap = {
  skip: process.platform !== 'linux' || !detectIsolation('linux', process.env),
  timeout: 15000,
};

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
  'isolated descendant writes the project, share and scratch but not protected roots or lateral files',
  darwin,
  async t => {
    const f = fixture(t);
    assert.equal(f.launcher.boundary.osIsolation, true);
    assert.equal(f.launcher.boundary.mechanism, 'seatbelt');
    assert.equal(f.launcher.boundary.projectWritable, true);
    assert.deepEqual(f.launcher.boundary.writableRoots, [
      f.project,
      f.share,
      fs.realpathSync(path.join(f.launcher.directory, 'scratch')),
    ]);
    const result = await capture(
      f.launcher.spawn(
        process.execPath,
        [
          '-e',
          PROBE,
          JSON.stringify({
            project: path.join(f.project, 'agent-edit.txt'),
            share: path.join(f.share, 'context.json'),
            scratch: path.join(f.launcher.directory, 'scratch', 'note.txt'),
            settings: path.join(f.settings, 'state.sqlite'),
            lateral: path.join(f.directory, 'lateral.txt'),
            home: path.join(os.homedir(), '.agent-isolation-probe'),
          }),
          '{}',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      project: true,
      share: true,
      scratch: true,
      settings: false,
      lateral: false,
      home: false,
    });
    assert.equal(
      fs.readFileSync(path.join(f.project, 'agent-edit.txt'), 'utf8'),
      'bypass',
      'the project stays writable inside the workspace boundary',
    );
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

test(
  'isolated descendant cannot write a protected root nested inside the writable project',
  darwin,
  async t => {
    // A domain pack can seal directories INSIDE the project
    // (workspaceProtectedPaths): the broad project allowance must not
    // re-open them. Regression coverage for the shallow-to-deep rule order.
    const f = fixture(t);
    const sealed = path.join(f.project, '.eda');
    fs.mkdirSync(sealed);
    const launcher = createProcessSandbox({
      executable: process.execPath,
      projectDir: f.project,
      shareDir: f.share,
      protectedPaths: [f.settings, sealed],
      sensitiveReadPaths: [f.secrets],
    });
    t.after(() => launcher.close());
    const result = await capture(
      launcher.spawn(
        process.execPath,
        [
          '-e',
          PROBE,
          JSON.stringify({
            project: path.join(f.project, 'open.txt'),
            sealed: path.join(sealed, 'golden.txt'),
            settings: path.join(f.settings, 'state.sqlite'),
          }),
          '{}',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      project: true,
      sealed: false,
      settings: false,
    });
  },
);

test(
  'isolated descendant cannot create a declared protected root that did not exist at launch',
  darwin,
  async t => {
    // The pack may declare workspaceProtectedPaths for directories the run
    // creates later. The declaration must hold from session start: the agent
    // must not create and populate such a directory itself.
    const f = fixture(t);
    const sealed = path.join(f.project, '.eda');
    const launcher = createProcessSandbox({
      executable: process.execPath,
      projectDir: f.project,
      shareDir: f.share,
      protectedPaths: [f.settings, sealed],
      sensitiveReadPaths: [f.secrets],
    });
    t.after(() => launcher.close());
    const profile = fs.readFileSync(path.join(launcher.directory, 'agent.sb'), 'utf8');
    assert.ok(
      profile.includes(`(deny file-write* (subpath ${JSON.stringify(sealed)}))`),
      'the Seatbelt profile binds the future protected path',
    );
    const result = await capture(
      launcher.spawn(
        process.execPath,
        [
          '-e',
          `const fs = require('node:fs');
try {
  fs.mkdirSync(process.argv[1], { recursive: true });
  fs.writeFileSync(require('node:path').join(process.argv[1], 'golden.txt'), 'x');
  console.log('created');
} catch { console.log('denied'); }`,
          sealed,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    assert.equal(result.stdout.trim(), 'denied', result.stderr);
    assert.equal(fs.existsSync(sealed), false, 'the agent must not materialize the sealed root');
  },
);

test('emitters order write rules shallow-to-deep so nested denies survive', () => {
  const policy = buildIsolationPolicy({
    project: '/work/project',
    share: '/work/settings/chats/session',
    scratch: '/tmp/scratch',
    protectedRoots: ['/work/settings', '/work/project/.eda'],
    sensitiveReadPaths: [],
  });
  const ordered = orderedWriteRules(policy).map(
    rule => `${rule.allow ? 'allow' : 'deny'}:${rule.file}`,
  );
  assert.deepEqual(ordered, [
    'allow:/work/project',
    'allow:/tmp/scratch',
    'deny:/work/settings',
    'deny:/work/project/.eda',
    'allow:/work/settings/chats/session',
  ]);
  const args = bubblewrapArgs(policy, { workDir: '/work/settings/chats/session' });
  const at = flag => args.indexOf(flag);
  assert.ok(args.indexOf('/work/settings') < args.lastIndexOf('/work/settings/chats/session'));
  assert.ok(args.indexOf('/work/project') < args.lastIndexOf('/work/project/.eda'));
  assert.equal(args[at('--seccomp')], undefined);
  const withFilter = bubblewrapArgs(policy, { workDir: '/w', seccompFd: 3 });
  assert.equal(withFilter[withFilter.indexOf('--seccomp') + 1], '3');
  assert.ok(withFilter.indexOf('--seccomp') < withFilter.indexOf('--chdir'));
  const profile = seatbeltProfile(policy);
  const allowProject = profile.indexOf('(allow file-write* (subpath "/work/project"))');
  const denySealed = profile.indexOf('(deny file-write* (subpath "/work/project/.eda"))');
  const denySettings = profile.indexOf('(deny file-write* (subpath "/work/settings"))');
  const allowShare = profile.indexOf(
    '(allow file-write* (subpath "/work/settings/chats/session"))',
  );
  assert.ok(allowProject !== -1 && denySealed > allowProject, profile);
  assert.ok(denySettings !== -1 && allowShare > denySettings, profile);
});

test('seccomp filter blocks AF_UNIX sockets on x64 and arm64 without width traps', () => {
  const decode = program =>
    Array.from({ length: program.length / 8 }, (_, index) => ({
      code: program.readUInt16LE(index * 8),
      jt: program.readUInt8(index * 8 + 2),
      jf: program.readUInt8(index * 8 + 3),
      k: program.readUInt32LE(index * 8 + 4),
    }));
  for (const [arch, syscalls] of [
    ['x64', { socket: 41, socketpair: 53 }],
    ['arm64', { socket: 198, socketpair: 199 }],
  ]) {
    const program = seccompUnixSocketFilter(arch);
    assert.ok(Buffer.isBuffer(program));
    assert.equal(program.length % 8, 0);
    const instructions = decode(program);
    // The x32 ABI bit is masked off nr before any comparison.
    assert.ok(instructions.some(i => i.code === 0x54 && i.k === 0xbfffffff));
    // socket() and socketpair() are both matched per architecture.
    assert.ok(instructions.some(i => i.code === 0x15 && i.k === syscalls.socket));
    assert.ok(instructions.some(i => i.code === 0x15 && i.k === syscalls.socketpair));
    // AF_UNIX and the SOCK_DGRAM pair type are the denied values.
    assert.ok(instructions.filter(i => i.code === 0x15 && i.k === 1).length >= 2);
    assert.ok(instructions.some(i => i.code === 0x15 && i.k === 2));
    // The family comparison must NOT consult the high 32 bits (offset 20):
    // the kernel truncates the argument to int, so the high word is
    // attacker-controlled noise that used to smuggle AF_UNIX past the check.
    assert.ok(!instructions.some(i => i.code === 0x20 && i.k === 20));
  }
  assert.equal(seccompUnixSocketFilter('ia32'), null);
  assert.equal(seccompUnixSocketFilter('arm'), null);
});

test('isolation detection probes a real launch instead of mere existence', async t => {
  if (process.platform !== 'linux') return t.skip('bubblewrap probing is linux-only');
  // Probe results are cached per command path, so each variant gets its own.
  const brokenBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bwrap-broken-'));
  const workingBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bwrap-working-'));
  t.after(() => {
    fs.rmSync(brokenBin, { recursive: true, force: true });
    fs.rmSync(workingBin, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(brokenBin, 'bwrap'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(workingBin, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(detectIsolation('linux', { PATH: brokenBin }), null);
  const detected = detectIsolation('linux', { PATH: workingBin });
  assert.equal(detected?.mechanism, 'bubblewrap');
});

test(
  'isolated descendant cannot create unix sockets under the seccomp filter',
  linuxBwrap,
  async t => {
    const f = fixture(t);
    assert.equal(f.launcher.boundary.mechanism, 'bubblewrap');
    assert.equal(f.launcher.boundary.unixSocketsFiltered, true);
    const socketPath = path.join(f.directory, 'runtime.sock');
    const server = net.createServer().listen(socketPath);
    await once(server, 'listening');
    t.after(() => server.close());
    const result = await capture(
      f.launcher.spawn(process.execPath, ['-e', PROBE, '{}', '{}', socketPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { unixSocket: false });
  },
);

test('isolation policy is pure data shaped after sandbox-runtime config', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.ssh'));
  const policy = buildIsolationPolicy({
    project: '/work/project',
    share: '/work/share',
    scratch: '/tmp/scratch',
    protectedRoots: ['/work/settings'],
    sensitiveReadPaths: [path.join(home, '.ssh'), path.join(home, '.ssh-missing')],
    home,
  });
  assert.deepEqual(policy.filesystem.writable, ['/work/project', '/work/share', '/tmp/scratch']);
  assert.deepEqual(policy.filesystem.protected, ['/work/settings']);
  // Declared credential paths are kept even when missing: Seatbelt rules must
  // still bind them if the secrets appear mid-session (bubblewrap masks only
  // existing paths, which is sufficient under the read-only home).
  assert.deepEqual(policy.filesystem.denyRead, [
    path.join(home, '.ssh'),
    path.join(home, '.ssh-missing'),
  ]);
  assert.equal(policy.network.tcp, 'allow');
  assert.equal(policy.network.outboundUnixSockets, 'deny');
});
