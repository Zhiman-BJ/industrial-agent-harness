const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SHELL_ENV_MARK,
  captureLoginShellPath,
  dockerSearchLocations,
  parseCapturedPath,
  resolveDockerCli,
  resolveDockerCliSync,
  wellKnownDockerPaths,
} = require('../src/docker-cli.cjs');

function stubDocker(t, root, relative) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return file;
}

function stubScript(t, root, relative, body) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return file;
}

test('PATH resolution precedes the well-known installs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-cli-'));
  const onPath = stubDocker(t, root, 'path-bin/docker');
  stubDocker(t, root, 'home/.docker/bin/docker');
  const resolved = resolveDockerCliSync({
    PATH: path.join(root, 'path-bin'),
    HOME: path.join(root, 'home'),
  });
  assert.equal(resolved.via, 'PATH');
  assert.equal(resolved.docker, fs.realpathSync(onPath));
});

test('a Docker Desktop user install is found when the PATH misses', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-cli-'));
  stubDocker(t, root, 'home/.docker/bin/docker');
  const environment = { PATH: path.join(root, 'absent'), HOME: path.join(root, 'home') };
  const resolved = resolveDockerCliSync(environment);
  // Machines with a system Docker installed ahead of ~/.docker/bin resolve
  // their own copy; what matters is that a well-known install answered.
  assert.equal(resolved?.via, 'well-known');
  assert.ok(
    wellKnownDockerPaths(environment).some(entry => resolved.docker === fs.realpathSync(entry)),
    `resolved ${resolved.docker} is not a well-known install`,
  );
});

test('a complete miss returns null while the search list stays diagnostic', () => {
  const root = path.join(fs.realpathSync(os.tmpdir()), 'harness-docker-absent-' + Date.now());
  const environment = {
    PATH: [path.join(root, 'a'), path.join(root, 'b')].join(path.delimiter),
    HOME: root,
  };
  assert.equal(resolveDockerCliSync(environment, { wellKnown: () => [] }), null);
  const searched = dockerSearchLocations(environment);
  for (const expected of [
    path.join(root, 'a'),
    path.join(root, 'b'),
    path.join(root, '.docker', 'bin'),
  ])
    assert.ok(searched.includes(expected), `${expected} missing from ${searched}`);
});

test('the login-shell PATH capture resolves and merges environments', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-cli-'));
  const login = stubDocker(t, root, 'login-bin/docker');
  const resolved = await resolveDockerCli(
    { PATH: '/nonexistent', HOME: root },
    { capture: async () => path.dirname(login), wellKnown: () => [] },
  );
  assert.equal(resolved?.docker, fs.realpathSync(login));
  assert.ok(resolved.environment.PATH.startsWith(path.dirname(login) + path.delimiter));
  assert.ok(resolved.environment.PATH.includes('/nonexistent'));
});

test('a failed capture keeps the miss null without throwing', async () => {
  const miss = { PATH: '/nonexistent', HOME: os.tmpdir() };
  assert.equal(
    await resolveDockerCli(miss, { capture: async () => null, wellKnown: () => [] }),
    null,
  );
  assert.equal(
    await resolveDockerCli(miss, { capture: async () => '', wellKnown: () => [] }),
    null,
  );
});

test('captured output is parsed between markers despite profile noise', () => {
  const mark = SHELL_ENV_MARK;
  assert.equal(
    parseCapturedPath(`noise ${mark}/opt/bin:/usr/bin${mark} trailing`),
    '/opt/bin:/usr/bin',
  );
  assert.equal(parseCapturedPath('no markers at all'), null);
  assert.equal(parseCapturedPath(`${mark}${mark}`), null);
});

test(
  'a real login shell reports its PATH between the markers',
  { skip: process.platform === 'win32' },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-cli-'));
    // The -i -l -c probe arguments land after the script path, so the stub only
    // has to echo its own PATH between the markers like a login shell would.
    const shell = stubScript(
      t,
      root,
      'shell',
      `#!/bin/sh\nprintf %s "${SHELL_ENV_MARK}\${PATH}${SHELL_ENV_MARK}"\n`,
    );
    const captured = await captureLoginShellPath(
      { SHELL: shell, HOME: root },
      { timeoutMs: 10000 },
    );
    assert.equal(captured, '/usr/bin:/bin:/usr/sbin:/sbin');
  },
);

test(
  'a hanging login shell is abandoned after the timeout',
  { skip: process.platform === 'win32' },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-cli-'));
    const shell = stubScript(t, root, 'shell', '#!/bin/sh\nexec sleep 30\n');
    const startedAt = Date.now();
    assert.equal(
      await captureLoginShellPath({ SHELL: shell, HOME: root }, { timeoutMs: 250 }),
      null,
    );
    assert.ok(Date.now() - startedAt < 10000, 'the capture outlived its timeout');
  },
);

test('an aborted signal stays an abort', async () => {
  const controller = new AbortController();
  controller.abort(Error('cancelled before resolution'));
  await assert.rejects(
    async () =>
      resolveDockerCli(
        { PATH: '/nonexistent', HOME: os.tmpdir() },
        { signal: controller.signal, wellKnown: () => [] },
      ),
    error => error.message === 'cancelled before resolution',
  );
});
