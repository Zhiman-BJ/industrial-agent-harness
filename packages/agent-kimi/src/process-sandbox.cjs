const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function executablePath(executable, environment) {
  if (executable.includes(path.sep)) return fs.realpathSync(executable);
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      const target = fs.realpathSync(path.join(directory, executable));
      fs.accessSync(target, fs.constants.X_OK);
      return target;
    } catch {}
  }
  throw Error('Kimi executable is unavailable.');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function cleanEnvironment(environment, hostOnlyEnv) {
  const denied = new Set(hostOnlyEnv);
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([name, value]) => value !== undefined && !denied.has(name))
      .map(([name, value]) => [name, String(value)]),
  );
}

// The historical API name is retained for callers. Native Agent processes run
// as the current user on all platforms; this is a supervised launcher, not an
// OS sandbox. Domain Runtime task execution has its own independent policy.
function createProcessSandbox({
  executable = 'kimi',
  shareDir,
  projectDir,
  environment = process.env,
  hostOnlyEnv = [],
  platform = process.platform,
  kimiProjectAccess = false,
}) {
  if (platform === 'win32')
    return require('./windows-sandbox.cjs').createWindowsProcessSandbox({
      executable,
      shareDir,
      projectDir,
      environment,
      hostOnlyEnv,
      kimiProjectAccess,
    });
  if (!['darwin', 'linux'].includes(platform))
    throw Error(`Native Agent execution is unsupported on ${platform}.`);
  environment = cleanEnvironment(environment, hostOnlyEnv);
  const project = fs.realpathSync(projectDir);
  const share = fs.realpathSync(shareDir);
  if (inside(project, share) || inside(share, project))
    throw Error('Agent session storage and the engineering project must be separate.');
  const target = executablePath(executable, environment);
  const script = /\.[cm]?js$/i.test(target);
  const command = script ? fs.realpathSync(process.execPath) : target;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-session-'));
  fs.chmodSync(directory, 0o700);
  const scratch = path.join(directory, 'scratch');
  const workDir = path.join(share, 'workspace');
  const children = new Map();
  let closed = false;
  try {
    fs.mkdirSync(scratch, { mode: 0o700 });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const pinned = {
      KIMI_SHARE_DIR: share,
      KIMI_CODE_HOME: share,
      TEMP: scratch,
      TMP: scratch,
      TMPDIR: scratch + path.sep,
    };
    const env = cleanEnvironment({ ...environment, ...pinned }, hostOnlyEnv);
    const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
    return {
      executable: target,
      env,
      envIsolated: true,
      directory,
      workDir,
      projectAlias: false,
      boundary: {
        platform,
        mechanism: 'current-user',
        osIsolation: false,
        projectWritable: true,
        projectDir: project,
        agentWorkDir: workDir,
        hostRuntimeRequired: true,
      },
      spawn(commandPath, args, options = {}) {
        if (closed) throw Error('Agent launcher has already closed.');
        if (
          fs.realpathSync(commandPath) !== command ||
          (script && fs.realpathSync(args[0]) !== target)
        )
          throw Error('Agent launcher does not match the bound executable.');
        if (options.shell || (options.cwd && !inside(workDir, path.resolve(options.cwd))))
          throw Error('Agent launch must use its session workspace without a shell wrapper.');
        if (
          (options.uid !== undefined && options.uid !== process.getuid()) ||
          (options.gid !== undefined && options.gid !== process.getgid())
        )
          throw Error('Agent launch must retain the current user and group.');
        const nativeArgs = [...args];
        if (kimiProjectAccess) nativeArgs.splice(script ? 1 : 0, 0, '--add-dir', project);
        const child = spawn(command, nativeArgs, {
          ...options,
          cwd: workDir,
          env: cleanEnvironment({ ...env, ...options.env, ...pinned }, hostOnlyEnv),
          shell: false,
          detached: true,
        });
        let childClosed = false,
          groupGone = false,
          forceSent = false,
          retired = false,
          timer;
        const signalGroup = signal => {
          if (!child.pid || groupGone || retired) return false;
          try {
            process.kill(-child.pid, signal);
            return true;
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            // Once this owned group disappears, never signal this numeric ID
            // again: the operating system may reuse it for unrelated work.
            groupGone = true;
            return false;
          }
        };
        const finish = () => {
          if (!childClosed || (!groupGone && !forceSent && signalGroup(0))) return;
          retired = true;
          clearTimeout(timer);
          children.delete(child);
          if (closed && children.size === 0) cleanup();
        };
        const stop = () => {
          const sent = signalGroup('SIGTERM');
          if (sent && !timer) {
            timer = setTimeout(() => {
              // A departed group leader does not mean its descendants exited.
              forceSent = signalGroup('SIGKILL');
              finish();
            }, 1000);
            timer.unref();
          }
          finish();
          return sent;
        };
        child.kill = (signal = 'SIGTERM') => {
          if (signal === 'SIGTERM') return stop();
          const sent = signalGroup(signal);
          if (signal === 'SIGKILL') forceSent = sent;
          finish();
          return sent;
        };
        children.set(child, stop);
        child.once('close', () => {
          childClosed = true;
          if (signalGroup(0) && !forceSent) stop();
          finish();
        });
        return child;
      },
      close() {
        if (closed) return;
        closed = true;
        for (const stop of children.values()) stop();
        if (children.size === 0) cleanup();
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createProcessSandbox };
