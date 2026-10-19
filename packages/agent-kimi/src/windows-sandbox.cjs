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

function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || value.includes('\0'))
    throw Error('Windows command arguments must be strings without NUL.');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
}

function absoluteWindowsPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !/^[a-z]:\\/i.test(value))
    throw Error('MXC requires absolute local Windows paths.');
  return value;
}

function buildMxcPolicy({
  executable,
  args,
  workingDirectory,
  writableRoots,
  readonlyRoots,
  environment,
}) {
  absoluteWindowsPath(executable);
  absoluteWindowsPath(workingDirectory);
  if (!Array.isArray(writableRoots) || writableRoots.length !== 2)
    throw Error('MXC requires exactly two writable roots.');
  for (const root of [...writableRoots, ...readonlyRoots]) absoluteWindowsPath(root);
  if (
    inside(writableRoots[0], writableRoots[1]) ||
    inside(writableRoots[1], writableRoots[0]) ||
    !inside(writableRoots[0], workingDirectory)
  )
    throw Error('MXC writable roots must be disjoint and contain the workspace.');
  const commandLine = [executable, ...args].map(quoteWindowsArgument).join(' ');
  if (commandLine.length >= 32767)
    throw Error('MXC command arguments exceed the Windows command-line limit.');
  const env = Object.entries(environment).map(([key, value]) => {
    if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))
      throw Error('MXC requires valid environment strings without NUL.');
    return key + '=' + value;
  });
  return {
    version: '1.0.0',
    containment: 'processcontainer',
    fallback: { allowDaclMutation: false },
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    filesystem: { readwritePaths: [...writableRoots], readonlyPaths: [...readonlyRoots] },
    process: { commandLine, cwd: workingDirectory, env, inheritDefaultEnv: false },
    network: { egress: { default: 'allow' }, ingress: { default: 'deny', hostLoopback: 'allow' } },
    ui: { disable: false, clipboard: 'none', injection: false },
    processContainer: {
      capabilities: ['registryRead'],
      leastPrivilege: false,
      ui: { isolation: 'desktop', desktopSystemControl: false, systemSettings: 'none', ime: false },
    },
    telemetry: { enabled: false },
  };
}

function assertMxcProbe(probe) {
  if (
    !probe ||
    probe.tier !== 'base-container' ||
    probe.needsDaclAugmentation !== false ||
    probe.error ||
    probe.probes?.baseContainerApiPresent !== true ||
    probe.probes?.baseContainerSupportsIngressHostLoopbackAllow !== true
  )
    throw Error(
      'Windows Agent requires native MXC BaseContainer/PSEC with host-loopback support; ACL fallback is disabled. Detected: ' +
        JSON.stringify({
          tier: probe?.tier,
          needsDaclAugmentation: probe?.needsDaclAugmentation,
          psec: probe?.probes?.baseContainerApiPresent,
          hostLoopback: probe?.probes?.baseContainerSupportsIngressHostLoopbackAllow,
        }),
    );
}

const mxcExecutorDigests = {
  x64: '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a',
  arm64: '91aa4171e8809f33f19622c381116188eab7d8c8cffad231230a31b58146ee77',
};

function materializeMxc(directory) {
  // Consume only the pinned standalone executable. Loading the ESM SDK's FFI
  // would require newer Node stdio APIs than the packaged Electron provides.
  const expected = mxcExecutorDigests[process.arch];
  if (!expected) throw Error('Windows MXC requires x64 or arm64.');
  const root = path.dirname(require.resolve('@microsoft/mxc-sdk/package.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '1.0.1') throw Error('Windows MXC requires the pinned SDK 1.0.1.');
  const bytes = fs.readFileSync(path.join(root, 'bin', process.arch, 'wxc-exec.exe'));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
    throw Error('Windows MXC executor integrity check failed. Repair the installation.');
  const executable = path.join(directory, 'wxc-exec.exe');
  fs.writeFileSync(executable, bytes, { flag: 'wx' });
  fs.copyFileSync(path.join(root, 'LICENSE.md'), path.join(directory, 'MXC-LICENSE.md'));
  return executable;
}

function hostReadRoots(paths) {
  // A native volume-root grant is not recursive. Expand its immediate children
  // so existing host reads remain available while writes stay separately scoped.
  const volumes = new Set(
    paths
      .filter(Boolean)
      .filter(value => /^[a-z]:\\/i.test(value))
      .map(value => path.win32.parse(value).root.toUpperCase()),
  );
  const roots = new Set(paths.filter(Boolean));
  for (const volume of volumes) {
    roots.add(volume);
    for (const entry of fs.readdirSync(volume, { withFileTypes: true })) {
      const child = path.join(volume, entry.name);
      try {
        fs.realpathSync(child);
        roots.add(child);
      } catch (error) {
        if (!['EACCES', 'EPERM', 'ENOENT', 'EBUSY'].includes(error.code)) throw error;
      }
    }
  }
  return [...roots];
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
    const executor = materializeMxc(directory);
    const runner = compileRunner(directory);
    // MXC's CLI checks orphaned DACL journals before probing. Give this launch
    // a fresh, private journal directory so it cannot repair another consumer's
    // state. This override belongs only to the trusted executor, never the Agent.
    const mxcState = path.join(directory, 'mxc-dacl-state');
    fs.mkdirSync(mxcState);
    const readonlyRoots = hostReadRoots([
      project,
      ...protectedRoots,
      command,
      target,
      directory,
      process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
    ]);
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
        mechanism: 'windows-mxc-base-container',
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
        const request = path.join(directory, crypto.randomUUID() + '.request.json');
        fs.writeFileSync(
          request,
          JSON.stringify(
            buildMxcPolicy({
              executable: command,
              args: nativeArgs,
              workingDirectory: workDir,
              writableRoots: [share, scratch],
              readonlyRoots,
              environment: launchEnv,
            }),
          ),
        );
        const executorEnv = Object.fromEntries(
          Object.entries(launchEnv).filter(([name]) => !name.toUpperCase().startsWith('MXC_')),
        );
        executorEnv.MXC_DACL_STATE_DIR = mxcState;
        // This request requires native host-loopback support and disallows host
        // DACL mutation. The executor also enforces this at launch, so a failed
        // native launch can never retry through AppContainer or an unwrapped Kimi.
        const probe = spawnSync(executor, ['--config', request, '--probe'], {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
          env: executorEnv,
        });
        try {
          if (probe.error || probe.status !== 0)
            throw Error(
              'Windows MXC native policy probe failed (' +
                (probe.error?.code || probe.status || probe.signal) +
                '); no alternate backend was started.',
            );
          assertMxcProbe(JSON.parse(probe.stdout));
        } catch (error) {
          fs.rmSync(request, { force: true });
          throw error;
        }
        fs.writeFileSync(
          policy,
          JSON.stringify({
            executable: executor,
            args: [request],
            workingDirectory: workDir,
            writableRoots: [share, scratch],
            protectedRoots,
            environment: executorEnv,
            parentPid: process.pid,
          }),
        );
        const child = spawn(runner, [policy], {
          ...options,
          cwd: workDir,
          env: executorEnv,
          shell: false,
          detached: false,
          windowsHide: true,
        });
        children.add(child);
        child.once('close', () => {
          children.delete(child);
          fs.rmSync(policy, { force: true });
          fs.rmSync(request, { force: true });
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

module.exports = {
  createWindowsProcessSandbox,
  windowsEnvironment,
  inside,
  quoteWindowsArgument,
  buildMxcPolicy,
  assertMxcProbe,
};
