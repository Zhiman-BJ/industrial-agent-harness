const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildIsolationPolicy,
  detectIsolation,
  seccompUnixSocketFilter,
  seatbeltProfile,
  bubblewrapArgs,
  canonicalPath,
} = require('./agent-isolation.cjs');

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

// The historical API name is retained for callers. The launcher always
// supervises the process (bound executable, session workspace, process-group
// lifecycle); when the host platform offers a verified OS primitive, an
// isolation layer from agent-isolation.cjs additionally confines the whole
// process tree — descendants inherit Seatbelt/bubblewrap restrictions, so
// native Shell, WriteFile, Python and project-controlled MCP children cannot
// modify the project or reach host credentials. Domain Runtime task execution
// keeps its own independent policy. `isolation: 'off'` forces the plain
// current-user launcher (used by tests and as the documented fallback).
function createProcessSandbox({
  executable = 'kimi',
  shareDir,
  projectDir,
  protectedPaths = [],
  environment = process.env,
  hostOnlyEnv = [],
  platform = process.platform,
  kimiProjectAccess = false,
  sensitiveReadPaths,
  isolation = 'auto',
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
  // bubblewrap mountpoints materialized for not-yet-existing protected roots
  // (shallowest first per root); session teardown removes them again so the
  // host project keeps no empty directories the agent never populated.
  const createdMountPoints = [];
  const cleanupSession = () => {
    fs.rmSync(directory, { recursive: true, force: true });
    // rmdir only removes empty directories: a mountpoint the host runtime
    // populated meanwhile stays, and the declaration still binds next launch.
    for (const mountPoint of [...createdMountPoints].reverse())
      try {
        fs.rmdirSync(mountPoint);
      } catch {}
  };
  let closed = false;
  try {
    fs.mkdirSync(scratch, { mode: 0o700 });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    // Build the isolation wrap before any launch. The boundary follows the
    // workspace-write model of mature agent sandboxes: the project, session
    // storage and scratch stay writable (the installer startup probe relies on
    // a writable project), while protected host state, all other writes,
    // credential reads and unix-socket egress are confined. When the platform
    // offers no verified primitive the launcher still works —
    // boundary.osIsolation then reports false so the product surface can show
    // the session is unisolated. Declared protected roots are kept even when
    // they do not exist yet — a pack's workspaceProtectedPaths may describe
    // directories the run itself creates later, and the agent must not get to
    // create and populate them first.
    const protectedRoots = protectedPaths.map(canonicalPath);
    // `isolation: 'off'` forces the plain launcher; the same escape hatch is
    // available to deployments through INDUSTRIAL_AGENT_ISOLATION=off for
    // hosts whose kernel policy blocks the primitives outright.
    const requested =
      isolation === 'auto' && process.env.INDUSTRIAL_AGENT_ISOLATION === 'off' ? 'off' : isolation;
    const layer = requested === 'off' ? null : detectIsolation(platform, environment);
    let wrap = null;
    let writableRoots = null;
    let socketFilter = false;
    if (layer) {
      const scratchReal = fs.realpathSync(scratch);
      const policy = buildIsolationPolicy({
        project,
        share,
        scratch: scratchReal,
        protectedRoots,
        sensitiveReadPaths,
      });
      writableRoots = policy.filesystem.writable;
      if (layer.mechanism === 'seatbelt') {
        const profile = path.join(directory, 'agent.sb');
        fs.writeFileSync(profile, seatbeltProfile(policy), { mode: 0o400 });
        wrap = { command: layer.command, args: ['-f', profile] };
        socketFilter = true; // the profile denies outbound unix-socket connects
      } else {
        // bubblewrap mounts need a real mountpoint, so declared protected
        // roots that do not exist yet are materialized as empty directories
        // at session setup — otherwise the agent could create and populate
        // them inside the writable project before the host runtime does.
        // A failure aborts the launch (fail closed) instead of starting
        // unprotected. Seatbelt needs no mountpoint: its subpath rules bind
        // future paths directly.
        for (const root of protectedRoots)
          if (!fs.existsSync(root)) {
            const created = [];
            for (let cursor = root; !fs.existsSync(cursor); cursor = path.dirname(cursor))
              created.unshift(cursor);
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            createdMountPoints.push(...created);
          }
        // The AF_UNIX seccomp filter reaches bwrap through an inherited fd
        // (spawn stdio slot 3); on architectures without a compiled filter
        // the sandbox still runs and the boundary reports it honestly.
        const program = seccompUnixSocketFilter();
        let filterFile = null;
        if (program) {
          filterFile = path.join(directory, 'agent-seccomp.bpf');
          fs.writeFileSync(filterFile, program, { mode: 0o400 });
        }
        wrap = {
          command: layer.command,
          args: bubblewrapArgs(policy, { workDir, seccompFd: program ? 3 : null }),
          seccompFile: filterFile,
        };
        socketFilter = Boolean(program);
      }
    }
    const pinned = {
      KIMI_SHARE_DIR: share,
      KIMI_CODE_HOME: share,
      TEMP: scratch,
      TMP: scratch,
      TMPDIR: scratch + path.sep,
    };
    const env = cleanEnvironment({ ...environment, ...pinned }, hostOnlyEnv);
    const cleanup = cleanupSession;
    return {
      executable: target,
      env,
      envIsolated: true,
      directory,
      workDir,
      projectAlias: false,
      boundary: {
        platform,
        mechanism: wrap ? layer.mechanism : 'current-user',
        osIsolation: Boolean(wrap),
        unixSocketsFiltered: socketFilter,
        projectWritable: true,
        projectDir: project,
        agentWorkDir: workDir,
        writableRoots: writableRoots || [project],
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
        // With an isolation wrap the sandbox command becomes the direct child;
        // the whole confined tree shares its process group, so the group
        // lifecycle below (TERM → KILL escalation, retire-once) still applies.
        // The bubblewrap wrap additionally expects its seccomp BPF program on
        // inherited fd 3 (--seccomp 3): open the filter file, place the fd at
        // stdio slot 3 and close the parent copy right after spawn.
        let filterFd = null;
        const spawnOptions = {
          ...options,
          cwd: workDir,
          env: cleanEnvironment({ ...env, ...options.env, ...pinned }, hostOnlyEnv),
          shell: false,
          detached: true,
        };
        if (wrap?.seccompFile) {
          filterFd = fs.openSync(wrap.seccompFile, 'r');
          const stdio = Array.isArray(options.stdio)
            ? [...options.stdio]
            : [options.stdio || 'ignore', 'inherit', 'inherit'];
          if (stdio.length > 3)
            throw Error('Agent launch cannot reserve fd 3 for the isolation filter.');
          while (stdio.length < 3) stdio.push('ignore');
          stdio.push(filterFd);
          spawnOptions.stdio = stdio;
        }
        let child;
        try {
          child = spawn(
            wrap ? wrap.command : command,
            wrap ? [...wrap.args, command, ...nativeArgs] : nativeArgs,
            spawnOptions,
          );
        } finally {
          if (filterFd !== null) fs.closeSync(filterFd);
        }
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
    cleanupSession();
    throw error;
  }
}

module.exports = { createProcessSandbox };
