const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

function localDirectory(input) {
  const resolved = fs.realpathSync(input);
  if (!/^[a-z]:\\/i.test(resolved) || !fs.statSync(resolved).isDirectory())
    throw Error('Windows Agent isolation requires a local NTFS directory.');
  return resolved;
}

function compileRunner(directory) {
  // Node can read this source from app.asar; the system compiler requires a
  // physical host-owned source file outside the Agent's writable roots.
  const source = path.join(directory, 'runner.cs');
  fs.writeFileSync(source, fs.readFileSync(path.join(__dirname, 'windows-sandbox', 'runner.cs')));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map(name => path.join(systemRoot, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler)
    throw Error(
      'Windows Agent isolation requires the Windows .NET Framework 4 compiler. Repair or enable .NET Framework, then retry.',
    );
  const runner = path.join(directory, 'runner.exe');
  const compiled = spawnSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/reference:System.Web.Extensions.dll',
      `/out:${runner}`,
      source,
    ],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  );
  if (compiled.error || compiled.status !== 0 || !fs.existsSync(runner))
    throw Error(
      `Windows Agent isolation helper could not be prepared: ${compiled.error?.message || compiled.stdout || compiled.stderr}`,
    );
  return runner;
}

function createWindowsProcessSandbox({
  executable,
  shareDir,
  projectDir,
  protectedPaths = [],
  environment,
  hostOnlyEnv = [],
  kimiProjectAccess = false,
}) {
  if (process.platform !== 'win32')
    throw Error('The Windows Agent isolation backend must run on Windows.');
  const share = localDirectory(shareDir);
  const project = localDirectory(projectDir);
  const protectedRoots = [
    ...new Set([
      project,
      ...protectedPaths
        .filter(file => fs.existsSync(file))
        .map(file => {
          const resolved = fs.realpathSync(file);
          const archive = /^(.*?\.asar)(?:\\|$)/i.exec(resolved);
          return archive ? archive[1] : resolved;
        }),
    ]),
  ];
  if (protectedRoots.some(root => inside(root, share) || inside(share, root)))
    throw Error('Agent session storage must be disjoint from the protected project and runtime.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-boundary-'));
  const scratch = path.join(directory, 'scratch');
  const workDir = path.join(share, 'workspace');
  const children = new Set();
  let closed = false;
  try {
    fs.mkdirSync(scratch);
    fs.mkdirSync(workDir, { recursive: true });
    const target = fs.realpathSync(executable);
    if (!/\.(?:exe|[cm]?js)$/i.test(target))
      throw Error(
        'Windows Agent isolation requires a native .exe or a Node JavaScript entry point.',
      );
    const script = /\.[cm]?js$/i.test(target);
    const command = script ? fs.realpathSync(process.execPath) : target;
    const runner = compileRunner(directory);
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
    return {
      executable: target,
      env,
      envIsolated: true,
      directory,
      workDir,
      projectAlias: false,
      boundary: {
        platform: 'win32',
        projectWritable: false,
        projectDir: project,
        agentWorkDir: workDir,
        writableRoots: [share, scratch],
        mechanism: 'windows-restricted-token-low-integrity',
        hostRuntimeRequired: true,
      },
      spawn(commandPath, args, options = {}) {
        if (closed) throw Error('Windows Agent isolation has already closed.');
        if (
          fs.realpathSync(commandPath).toLowerCase() !== command.toLowerCase() ||
          (script && path.resolve(args[0]).toLowerCase() !== path.resolve(target).toLowerCase())
        )
          throw Error('Windows Agent launcher does not match the bound executable.');
        if (options.shell || (options.cwd && !inside(workDir, path.resolve(options.cwd))))
          throw Error(
            'Windows Agent launch must use the isolated workspace without a shell wrapper.',
          );
        const nativeArgs = [...args];
        if (kimiProjectAccess) nativeArgs.splice(script ? 1 : 0, 0, '--add-dir', project);
        const policy = path.join(directory, crypto.randomUUID() + '.json');
        const launchEnv = windowsEnvironment({ ...env, ...options.env }, hostOnlyEnv);
        for (const name of ['KIMI_SHARE_DIR', 'KIMI_CODE_HOME', 'TEMP', 'TMP', 'TMPDIR'])
          launchEnv[name] = env[name];
        fs.writeFileSync(
          policy,
          JSON.stringify({
            executable: command,
            args: nativeArgs,
            workingDirectory: workDir,
            writableRoots: [share, scratch],
            protectedRoots,
            environment: launchEnv,
            parentPid: process.pid,
          }),
        );
        const child = spawn(runner, [policy], {
          ...options,
          cwd: workDir,
          env: launchEnv,
          shell: false,
          detached: false,
          windowsHide: true,
        });
        children.add(child);
        child.once('close', () => {
          children.delete(child);
          fs.rmSync(policy, { force: true });
        });
        return child;
      },
      close() {
        if (closed) return;
        closed = true;
        for (const child of children) child.kill();
        const cleanup = () =>
          fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        if (children.size) {
          let pending = children.size;
          for (const child of children)
            child.once('close', () => {
              if (--pending === 0) cleanup();
            });
        } else cleanup();
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createWindowsProcessSandbox, windowsEnvironment, inside };
