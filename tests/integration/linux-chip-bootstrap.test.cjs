const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '../../scripts/installers/linux-bootstrap.sh');
const run = (args, env = process.env) =>
  spawnSync('bash', [source, ...args], { env, encoding: 'utf8' });

function helperFixture(t, groups = '1000 998', noNewPrivileges = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-helper-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const body = fs.readFileSync(source, 'utf8').split("cat <<'WRAPPER'\n")[1].split('\nWRAPPER')[0];
  const docker = path.join(directory, 'docker-real');
  fs.writeFileSync(docker, '#!/bin/bash\nprintf "%s\\n" "$@"\nexit "${DOCKER_TEST_STATUS:-0}"\n', {
    mode: 0o755,
  });
  const helper = path.join(directory, 'docker');
  fs.writeFileSync(helper, `#!/bin/bash\nset -euo pipefail\ndocker_binary='${docker}'\n${body}\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(directory, 'id'), `#!/bin/bash\nprintf '%s\\n' '${groups}'\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(directory, 'getent'), '#!/bin/bash\nprintf "docker:x:998:user\\n"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(directory, 'sg'),
    '#!/bin/bash\nprintf "unexpected sg\\n" >&2\nexit 91\n',
    { mode: 0o755 },
  );
  if (noNewPrivileges)
    fs.writeFileSync(path.join(directory, 'awk'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  return { helper, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } };
}

test('Docker helper uses effective group credentials, preserves literal arguments and never retries failures with sg', t => {
  const { helper, env } = helperFixture(t);
  const literal = 'apostrophe \' ; $(touch /tmp/never-execute) "quotes"';
  const result = spawnSync(helper, ['info', '--format', literal], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `info\n--format\n${literal}\n`);
  const failed = spawnSync(helper, ['run', 'missing-image'], {
    env: { ...env, DOCKER_TEST_STATUS: '42' },
    encoding: 'utf8',
  });
  assert.equal(failed.status, 42);
  assert.doesNotMatch(failed.stderr, /sg/);
});

test('managed helper upgrades select the real client when an older helper is already in PATH', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-upgrade-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const access = path.join(directory, 'data/industrial-harness/docker-access');
  const bins = path.join(directory, 'bin');
  fs.mkdirSync(access, { recursive: true });
  fs.mkdirSync(bins);
  fs.writeFileSync(
    path.join(access, 'docker'),
    '#!/bin/bash\n# Industrial Harness Docker group helper\nprintf "obsolete helper\\n" >&2\nexit 99\n',
    { mode: 0o755 },
  );
  const programs = {
    uname: 'if [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi',
    bwrap: 'exit 0',
    rg: 'exit 0',
    flock: 'exit 0',
    wget: 'exit 99',
    sha256sum: 'exit 99',
    getent: 'echo docker:x:998:user',
    id: 'echo "1000 998"',
    docker:
      'if [[ "$*" == *Architecture* ]]; then echo amd64; elif [[ "$*" == version* ]]; then echo 29.0.0; fi',
    sg: 'echo "unexpected sg" >&2; exit 91',
  };
  for (const [name, body] of Object.entries(programs))
    fs.writeFileSync(path.join(bins, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const result = run(['--system-only'], {
    ...process.env,
    XDG_DATA_HOME: path.join(directory, 'data'),
    PATH: `${access}:${bins}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr);
  const upgraded = fs.readFileSync(path.join(access, 'docker'), 'utf8');
  assert.ok(upgraded.includes(`docker_binary=${bins}/docker`));
  assert.doesNotMatch(upgraded, /obsolete helper/);
});

test('help is available without downloads or system setup', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /sudo is requested only for missing system dependencies/);
  assert.match(result.stdout, /Agent processes run with current-user permissions/);
  assert.match(result.stdout, /Declared local tasks separately require bubblewrap/);
});

test('current-user Agent system setup succeeds without bubblewrap or Docker when image setup is skipped', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chip-no-bwrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, executable] of Object.entries({
    bash: '/bin/bash',
    mktemp: '/usr/bin/mktemp',
    rm: '/bin/rm',
  }))
    fs.symlinkSync(executable, path.join(directory, name));
  const programs = {
    uname: 'if [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi',
    wget: 'exit 91',
    sha256sum: 'exit 91',
    awk: 'exit 91',
    tar: 'exit 91',
    flock: 'exit 91',
    curl: 'exit 91',
    rg: 'exit 91',
  };
  for (const [name, body] of Object.entries(programs))
    fs.writeFileSync(path.join(directory, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: directory };
  assert.equal(spawnSync('bash', ['-c', 'command -v bwrap'], { env }).status, 1);
  assert.equal(spawnSync('bash', ['-c', 'command -v docker'], { env }).status, 1);
  const result = run(['--system-only', '--skip-image'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /System dependencies ready/);
  assert.doesNotMatch(result.stdout, /Downloading|Preparing missing system dependencies/);
});

test('invalid arguments are rejected before attempting installation', () => {
  for (const args of [['--unknown'], ['--prefix'], ['--prefix', 'relative/path']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option|requires an absolute directory/);
    assert.doesNotMatch(result.stdout, /Downloading|Preparing/);
  }
});

test('a corrupted download never executes or provisions system dependencies', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chip-bootstrap-rejection-'));
  const marker = path.join(directory, 'executed');
  try {
    // Linux preflight requires flock; this rejection must occur before invoking it.
    fs.writeFileSync(path.join(directory, 'flock'), '#!/bin/bash\nexit 99\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(directory, 'uname'),
      '#!/bin/bash\nif [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(directory, 'wget'),
      '#!/bin/bash\nwhile (( $# )); do\n if [[ "$1" == -O ]]; then printf "#!/bin/bash\\ntouch \\"%s\\"\\n" "$BOOTSTRAP_EXECUTION_MARKER" > "$2"; exit; fi\n shift\ndone\nexit 1\n',
      { mode: 0o755 },
    );
    const result = run([], {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      BOOTSTRAP_EXECUTION_MARKER: marker,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Installer checksum mismatch/);
    assert.doesNotMatch(result.stdout, /Preparing missing system dependencies/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
