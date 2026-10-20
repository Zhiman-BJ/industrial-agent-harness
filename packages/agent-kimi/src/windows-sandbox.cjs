const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function windowsEnvironment(environment, hostOnlyEnv = []) {
  const denied = new Set(hostOnlyEnv.map(name => name.toUpperCase()));
  const values = new Map();
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined && !denied.has(name.toUpperCase()))
      values.set(name.toUpperCase(), [name, String(value)]);
  return Object.fromEntries(values.values());
}

function inside(parent, child) {
  const relative = path.win32.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))
  );
}

// Native Agent processes run with the current user's permissions. This adapter
// prepares session storage and supervises launches; it is not an OS sandbox.
function createWindowsProcessSandbox({
  executable,
  shareDir,
  projectDir,
  environment,
  hostOnlyEnv = [],
  kimiProjectAccess = false,
}) {
  if (process.platform !== 'win32') throw Error('The Windows launcher must run on Windows.');
  const share = fs.realpathSync(shareDir);
  const project = fs.realpathSync(projectDir);
  if (inside(project, share) || inside(share, project))
    throw Error('Agent session storage and the engineering project must be separate.');
  const target = fs.realpathSync(executable);
  const script = /\.[cm]?js$/i.test(target);
  const command = script ? fs.realpathSync(process.execPath) : target;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-session-'));
  const scratch = path.join(directory, 'scratch');
  const workDir = path.join(share, 'workspace');
  const children = new Set();
  let closed = false;
  try {
    fs.mkdirSync(scratch);
    fs.mkdirSync(workDir, { recursive: true });
    const env = windowsEnvironment(
      {
        ...windowsEnvironment(environment, hostOnlyEnv),
        KIMI_SHARE_DIR: share,
        KIMI_CODE_HOME: share,
        TEMP: scratch,
        TMP: scratch,
        TMPDIR: scratch + path.sep,
      },
      hostOnlyEnv,
    );
    const cleanup = () =>
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return {
      executable: target,
      env,
      envIsolated: true,
      directory,
      workDir,
      projectAlias: false,
      boundary: {
        platform: 'win32',
        mechanism: 'current-user',
        osIsolation: false,
        projectWritable: true,
        projectDir: project,
        agentWorkDir: workDir,
        hostRuntimeRequired: true,
      },
      spawn(commandPath, args, options = {}) {
        if (closed) throw Error('Windows Agent launcher has already closed.');
        if (
          fs.realpathSync(commandPath).toLowerCase() !== command.toLowerCase() ||
          (script && fs.realpathSync(args[0]).toLowerCase() !== target.toLowerCase())
        )
          throw Error('Windows Agent launcher does not match the bound executable.');
        if (options.shell || (options.cwd && !inside(workDir, path.resolve(options.cwd))))
          throw Error(
            'Windows Agent launch must use its session workspace without a shell wrapper.',
          );
        const nativeArgs = [...args];
        if (kimiProjectAccess) nativeArgs.splice(script ? 1 : 0, 0, '--add-dir', project);
        const launchEnv = windowsEnvironment({ ...env, ...options.env }, hostOnlyEnv);
        for (const name of ['KIMI_SHARE_DIR', 'KIMI_CODE_HOME', 'TEMP', 'TMP', 'TMPDIR']) {
          // Windows resolves environment names without regard to case.
          for (const key of Object.keys(launchEnv))
            if (key.toUpperCase() === name) delete launchEnv[key];
          launchEnv[name] = env[name];
        }
        const child = spawn(command, nativeArgs, {
          ...options,
          cwd: workDir,
          env: launchEnv,
          shell: false,
          detached: false,
          windowsHide: true,
        });
        const kill = child.kill.bind(child);
        child.kill = (signal = 'SIGTERM') => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
          // Best-effort cancellation of the live tree, not a Job/security boundary.
          const taskkill = path.join(
            process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
            'System32',
            'taskkill.exe',
          );
          const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 10000,
          });
          return result.status === 0 || kill(signal);
        };
        children.add(child);
        child.once('close', () => {
          children.delete(child);
          if (closed && children.size === 0) cleanup();
        });
        return child;
      },
      close() {
        if (closed) return;
        closed = true;
        for (const child of children) child.kill();
        if (children.size === 0) cleanup();
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createWindowsProcessSandbox, windowsEnvironment, inside };
