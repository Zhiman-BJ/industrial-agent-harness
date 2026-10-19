const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { hash } = require('./workspace-files.cjs');
const { resolveDockerCli } = require('./docker-cli.cjs');
const os = require('node:os');

function executable(command, environment, preservePath = false) {
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : (environment.PATH || process.env.PATH || '')
        .split(path.delimiter)
        .map(dir => path.join(dir, command));
  for (const file of candidates)
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile())
        return preservePath ? path.resolve(file) : fs.realpathSync(file);
    } catch {}
  throw Error('Task executable is unavailable: ' + command);
}
function taskEnvironment(environment, input, work) {
  const names = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot'];
  return {
    ...Object.fromEntries(
      names.filter(name => environment[name]).map(name => [name, environment[name]]),
    ),
    HOME: path.join(work, 'home'),
    TMPDIR: path.join(work, 'tmp'),
    HARNESS_INPUT_DIR: input,
    HARNESS_OUTPUT_DIR: work,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    CMAKE_BUILD_PARALLEL_LEVEL: '1',
  };
}
// Resolve the Docker endpoint the same way a user would expect the CLI to:
// explicit DOCKER_HOST wins; otherwise ask the CLI for the active context's
// endpoint (covers Docker Desktop / colima / lima / Rancher), then probe
// well-known socket locations. Task envs get a sandboxed HOME, so the CLI
// cannot find the user's context config on its own — without this, macOS
// Docker Desktop users hit "dial unix /var/run/docker.sock" even though
// preflight (which sees the real HOME) reports Docker as ready.
function resolveDockerHost(docker, environment) {
  if (environment.DOCKER_HOST) return environment.DOCKER_HOST;
  const home = environment.HOME || os.homedir();
  try {
    const probe = spawnSync(
      docker,
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        env: {
          PATH: environment.PATH || process.env.PATH || '',
          HOME: home,
          ...(environment.SystemRoot ? { SystemRoot: environment.SystemRoot } : {}),
          ...(environment.DOCKER_CONTEXT ? { DOCKER_CONTEXT: environment.DOCKER_CONTEXT } : {}),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    const host = (probe.stdout || '').trim();
    if (/^[a-z][a-z0-9+.-]*:\/\/.+/i.test(host)) return host;
  } catch {}
  for (const socket of [
    '/var/run/docker.sock',
    path.join(home, '.docker/run/docker.sock'),
    path.join(home, '.docker/desktop/docker.sock'),
    path.join(home, '.colima/default/docker.sock'),
  ])
    if (fs.existsSync(socket)) return 'unix://' + socket;
  return null;
}
function filter() {
  if (process.arch !== 'x64')
    throw Error('Protected local tasks on Linux are qualified only on x86-64.');
  const instructions = [],
    add = (code, jt, jf, k) => instructions.push([code, jt, jf, k]);
  add(0x20, 0, 0, 4);
  add(0x15, 1, 0, 0xc000003e);
  add(0x06, 0, 0, 0x80000000);
  add(0x20, 0, 0, 0);
  add(0x45, 0, 1, 0x40000000);
  add(0x06, 0, 0, 0x80000000);
  // Offline tasks cannot open host service sockets, ptrace or create new mounts.
  for (const number of [41, 101, 155, 165, 166, 272, 308, 428, 429, 430, 431, 432, 433, 442]) {
    add(0x15, 0, 1, number);
    add(0x06, 0, 0, 0x00050001);
  }
  add(0x06, 0, 0, 0x7fff0000);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], i) => {
    bytes.writeUInt16LE(code, i * 8);
    bytes[i * 8 + 2] = jt;
    bytes[i * 8 + 3] = jf;
    bytes.writeUInt32LE(k, i * 8 + 4);
  });
  return bytes;
}
function localCommand(argv, directory, input, work, environment, task) {
  const target = executable(argv[0], environment);
  const launchPath = executable(argv[0], environment, true);
  const systemRoots =
    process.platform === 'darwin'
      ? [
          '/System',
          '/usr',
          '/bin',
          '/sbin',
          '/Library/Developer/CommandLineTools',
          '/Library/Frameworks',
          '/opt/homebrew/Cellar',
          '/opt/homebrew/opt',
          '/usr/local/Cellar',
          '/usr/local/opt',
          '/opt/homebrew/etc/openssl@3/openssl.cnf',
          '/usr/local/etc/openssl@3/openssl.cnf',
        ]
      : [
          '/usr',
          '/bin',
          '/sbin',
          '/lib',
          '/lib64',
          '/etc/ld.so.cache',
          '/etc/alternatives',
          '/etc/passwd',
          '/etc/group',
          '/etc/nsswitch.conf',
          '/etc/localtime',
          '/etc/fonts',
          '/etc/ssl/openssl.cnf',
          '/etc/ssl/certs',
        ];
  const roots = new Set(systemRoots.filter(file => fs.existsSync(file)));
  // Preserve virtual-environment launch paths, and expose that installation's
  // libraries without granting the enclosing user home or arbitrary host data.
  for (const file of [target, launchPath]) {
    const parent = path.dirname(file),
      prefix = path.dirname(parent);
    if (
      ['bin', 'sbin'].includes(path.basename(parent)) &&
      ![
        '/',
        '/Users',
        '/home',
        '/opt',
        '/usr/local',
        '/opt/homebrew',
        os.homedir(),
        path.join(os.homedir(), '.local'),
      ].includes(prefix) &&
      !['/Users', '/home'].includes(path.dirname(prefix)) &&
      // A launcher in the original project must not expose unselected sources.
      prefix !== path.resolve(directory, '..', '..')
    )
      roots.add(prefix);
    else roots.add(file);
  }
  for (const dependency of task.runtime.readOnlyDirs || []) {
    const root = fs.realpathSync(dependency);
    if (!fs.statSync(root).isDirectory()) throw Error('Task dependency is not a directory.');
    roots.add(root);
  }
  roots.add(fs.realpathSync(input));
  const identity = {
    executable: target,
    launchPath,
    sha256: hash(fs.readFileSync(target)),
    readOnlyRoots: [...roots],
  };
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    const profile = path.join(directory, 'task.sb');
    fs.writeFileSync(
      profile,
      `(version 1)\n(allow default)\n(deny file-read-data)\n(allow file-read-data (literal "/"))\n(allow file-read-data ${[...roots, fs.realpathSync(work), '/dev'].map(file => `(${fs.statSync(file).isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(file)})`).join(' ')})\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(work)}) (literal "/dev/null"))\n(deny network*)\n(deny appleevent-send)\n`,
    );
    return {
      argv: ['/usr/bin/sandbox-exec', '-f', profile, launchPath, ...argv.slice(1)],
      identity,
    };
  }
  if (process.platform === 'linux') {
    const bwrap = executable('bwrap', environment);
    const seccomp = path.join(directory, 'task.seccomp');
    fs.writeFileSync(seccomp, filter());
    return {
      argv: [
        bwrap,
        '--unshare-all',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--tmpfs',
        '/',
        ...[...roots].flatMap(root => ['--ro-bind', root, root]),
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--bind',
        work,
        work,
        '--chdir',
        work,
        '--seccomp',
        '3',
        '--',
        launchPath,
        ...argv.slice(1),
      ],
      identity,
      seccomp,
    };
  }
  throw Error('Protected local task execution is unavailable on this platform.');
}
function runProcess(argv, { cwd, env, timeoutMs, signal, seccomp }) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    let child,
      timer,
      fd,
      log = '',
      status = null,
      resolved = false;
    const stop = reason => {
      status ||= reason;
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const finish = (exitCode, processSignal, error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (fd !== undefined) fs.closeSync(fd);
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        signal: processSignal,
        status: status || (error ? 'START_FAILED' : exitCode === 0 ? 'COMPLETED' : 'FAILED'),
        log: log + (error ? '\n' + error.message : ''),
      });
    };
    const cancel = () => stop('CANCELLED');
    try {
      if (signal?.aborted) {
        status = 'CANCELLED';
        return finish(null, null);
      }
      if (seccomp) fd = fs.openSync(seccomp, 'r');
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: seccomp ? ['ignore', 'pipe', 'pipe', fd] : ['ignore', 'pipe', 'pipe'],
      });
      const append = bytes => {
        log += bytes.toString('utf8');
        if (Buffer.byteLength(log) > 1024 * 1024) {
          log = log.slice(0, 524288);
          stop('OUTPUT_LIMIT');
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', error => finish(null, null, error));
      // Reap descendants even when a script exits while its child keeps pipes open.
      child.on('exit', () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      });
      child.on('close', (code, sig) => finish(code, sig));
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    } catch (error) {
      finish(null, null, error);
    }
  });
}
async function executeTask(task, { directory, input, work, actionId, environment, signal }) {
  const container = task.runtime.kind === 'docker';
  const inputRoot = container ? '/inputs' : input,
    outputRoot = container ? '/work' : work;
  const argv = task.command.map(arg =>
    arg.replaceAll('{input}', inputRoot).replaceAll('{output}', outputRoot),
  );
  const env = taskEnvironment(environment, input, work);
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  let command, identity, cleanup, seccomp;
  if (container) {
    if ([input, work].some(file => file.includes(',')))
      throw Error('Docker bind paths cannot contain commas.');
    const resolved = await resolveDockerCli(environment);
    if (!resolved) throw Error('Task executable is unavailable: docker');
    const docker = resolved.docker;
    const dockerHost = resolveDockerHost(docker, resolved.environment);
    const dockerEnv = {
      ...env,
      ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
      ...(dockerHost || !environment.DOCKER_CONTEXT
        ? {}
        : { DOCKER_CONTEXT: environment.DOCKER_CONTEXT }),
    };
    const inspection = spawnSync(
      docker,
      ['image', 'inspect', '--format', '{{.Id}}', task.runtime.image],
      {
        env: dockerEnv,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    if (inspection.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspection.stdout.trim()))
      throw Error(
        'Docker image is unavailable to the trusted host runtime: ' +
          String(inspection.stderr || inspection.error || '').slice(0, 4096),
      );
    identity = { image: task.runtime.image, imageId: inspection.stdout.trim() };
    const name = 'industrial-task-' + actionId;
    command = [
      docker,
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      String(task.runtime.cpus),
      '--memory',
      task.runtime.memoryMb + 'm',
      '--pids-limit',
      String(task.runtime.pids),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=128m',
      ...(typeof process.getuid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []),
      '--mount',
      `type=bind,src=${input},dst=/inputs,readonly`,
      '--mount',
      `type=bind,src=${work},dst=/work`,
      '--workdir',
      '/work',
      '--env',
      'HOME=/work/home',
      '--env',
      'HARNESS_INPUT_DIR=/inputs',
      '--env',
      'HARNESS_OUTPUT_DIR=/work',
      '--env',
      'PYTHONDONTWRITEBYTECODE=1',
      '--entrypoint',
      argv[0],
      identity.imageId,
      ...argv.slice(1),
    ];
    if (dockerHost) env.DOCKER_HOST = dockerHost;
    cleanup = () =>
      spawnSync(docker, ['rm', '--force', name], { env, timeout: 10000, stdio: 'ignore' });
  } else {
    const local = localCommand(argv, directory, input, work, environment, task);
    command = local.argv;
    identity = local.identity;
    seccomp = local.seccomp;
  }
  try {
    const result = await runProcess(command, {
      cwd: work,
      env,
      timeoutMs: task.timeoutMs,
      signal,
      seccomp,
    });
    return { ...result, argv, runtime: task.runtime, identity };
  } finally {
    cleanup?.();
  }
}
module.exports = { executeTask, resolveDockerHost };
