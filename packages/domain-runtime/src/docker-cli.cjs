const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Docker Desktop 4.89+ installs its CLI into ~/.docker/bin and only adds that
// directory to login-shell PATH profiles, so processes launched by the macOS
// Dock or Finder (whose PATH comes from launchd) never see it. PATH stays
// first to match terminal behavior; these locations follow; and as a last
// resort the login-shell PATH is captured like VS Code does for GUI launches.
function wellKnownDockerPaths(environment = process.env) {
  const home = environment.HOME || os.homedir();
  if (process.platform === 'win32') {
    const local = environment.LOCALAPPDATA;
    return [
      environment.ProgramFiles &&
        path.join(environment.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      local && path.join(local, 'Programs', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      local && path.join(local, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
    ].filter(Boolean);
  }
  return process.platform === 'darwin'
    ? [
        path.join(home, '.docker', 'bin', 'docker'),
        '/usr/local/bin/docker',
        '/opt/homebrew/bin/docker',
        '/Applications/Docker.app/Contents/Resources/bin/docker',
      ]
    : ['/usr/bin/docker', '/usr/local/bin/docker', path.join(home, '.docker', 'bin', 'docker')];
}

function dockerExecutableName() {
  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

function pathEntries(environment) {
  return (environment.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(entry => path.join(entry, dockerExecutableName()));
}

// Every location examined, for diagnostics; PATH directories plus the
// well-known installs above.
function dockerSearchLocations(environment = process.env) {
  return [
    ...pathEntries(environment).map(file => path.dirname(file)),
    ...wellKnownDockerPaths(environment).map(file => path.dirname(file)),
  ].filter((dir, index, all) => all.indexOf(dir) === index);
}

function existingExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    if (fs.statSync(file).isFile()) return fs.realpathSync(file);
  } catch {}
  return null;
}

function resolveDockerCliSync(
  environment = process.env,
  { wellKnown = wellKnownDockerPaths } = {},
) {
  for (const file of pathEntries(environment)) {
    const found = existingExecutable(file);
    if (found) return { docker: found, environment, via: 'PATH' };
  }
  for (const file of wellKnown(environment)) {
    const found = existingExecutable(file);
    if (found) return { docker: found, environment, via: 'well-known' };
  }
  return null;
}

const SHELL_ENV_MARK = 'ihc-docker-path-7f21b6';
let loginShellCapture;

// Extracts $PATH printed between two markers; shell profiles may echo noise
// around them, but the first/last marker pair still isolates the value. Fish
// joins list variables with spaces inside quotes, so a fish $PATH cannot
// round-trip this format; the parsed value then names no real directories and
// the probe simply fails like an absent shell.
function parseCapturedPath(stdout) {
  const start = stdout.indexOf(SHELL_ENV_MARK);
  if (start < 0) return null;
  const end = stdout.lastIndexOf(SHELL_ENV_MARK);
  const value = stdout.slice(start + SHELL_ENV_MARK.length, end).trim();
  return value.includes('/') ? value : null;
}

function captureLoginShellPath(environment, { timeoutMs = 10000 } = {}) {
  if (process.platform === 'win32') return Promise.resolve(null);
  const shell = environment.SHELL || '/bin/zsh';
  return new Promise(resolve => {
    let stdout = '',
      settled = false,
      child;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.stdout?.destroy();
      } catch {}
      try {
        child?.kill('SIGKILL');
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawn(
        shell,
        // ${PATH} must be braced: a bare $PATH glues onto the trailing marker
        // characters and parses as a different, empty variable.
        ['-i', '-l', '-c', `printf %s "${SHELL_ENV_MARK}\${PATH}${SHELL_ENV_MARK}"`],
        {
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: environment.HOME || os.homedir(),
            TERM: 'dumb',
            IHC_RESOLVING_LOGIN_SHELL: '1',
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      finish(null);
      return;
    }
    child.on('error', () => finish(null));
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 65536) finish(null);
    });
    child.on('close', () => finish(parseCapturedPath(stdout)));
  });
}

function mergePath(original, captured) {
  const entries = [...captured.split(path.delimiter), ...(original || '').split(path.delimiter)];
  return [...new Set(entries.filter(Boolean))].join(path.delimiter);
}

// Resolution is cached once per process for the real environment; injected
// captures and custom environments (tests, task sandboxes) are never cached.
function resolveDockerCli(environment = process.env, options = {}) {
  const {
    signal,
    timeoutMs,
    capture = captureLoginShellPath,
    noCache = false,
    wellKnown = wellKnownDockerPaths,
  } = options;
  signal?.throwIfAborted();
  const found = resolveDockerCliSync(environment, { wellKnown });
  if (found || process.platform === 'win32') return Promise.resolve(found);
  const run = async () => {
    signal?.throwIfAborted();
    const captured = await capture(environment, timeoutMs == null ? undefined : { timeoutMs });
    if (!captured) return null;
    signal?.throwIfAborted();
    return resolveDockerCliSync(
      { ...environment, PATH: mergePath(environment.PATH, captured) },
      { wellKnown },
    );
  };
  if (
    noCache ||
    capture !== captureLoginShellPath ||
    timeoutMs != null ||
    environment !== process.env
  )
    return run();
  loginShellCapture ??= run();
  return loginShellCapture;
}

module.exports = {
  SHELL_ENV_MARK,
  captureLoginShellPath,
  dockerSearchLocations,
  parseCapturedPath,
  resolveDockerCli,
  resolveDockerCliSync,
  wellKnownDockerPaths,
};
