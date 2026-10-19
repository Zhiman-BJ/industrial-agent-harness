const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { linuxCommand } = require('./linux-sandbox.cjs');

const quoteShell = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const seatbeltString = value => JSON.stringify(value);

function executablePath(executable, environment) {
  if (executable.includes(path.sep)) return fs.realpathSync(executable);
  for (const directory of (environment.PATH || process.env.PATH || '').split(path.delimiter)) {
    try {
      const target = fs.realpathSync(path.join(directory, executable));
      fs.accessSync(target, fs.constants.X_OK);
      return target;
    } catch {}
  }
  throw Error('Kimi executable is unavailable.');
}

function createProcessSandbox({
  executable = 'kimi',
  shareDir,
  projectDir,
  protectedPaths = [],
  environment = process.env,
  hostOnlyEnv = [],
  platform = process.platform,
  kimiProjectAccess = false,
}) {
  environment = { ...environment };
  for (const key of hostOnlyEnv) delete environment[key];
  if (
    !['darwin', 'linux'].includes(platform) ||
    (platform === 'darwin' && !fs.existsSync('/usr/bin/sandbox-exec'))
  )
    throw Error(
      `Industrial agent execution is unavailable on ${platform}: a verified process write boundary is required.`,
    );
  let bwrap;
  if (platform === 'linux') {
    if (process.arch !== 'x64')
      throw Error('Protected Linux agent execution is qualified only on x86-64.');
    try {
      bwrap = executablePath('bwrap', environment);
    } catch {
      throw Error(
        'Industrial agent execution on Linux requires bubblewrap (bwrap) and enabled unprivileged user namespaces.',
      );
    }
  }
  const project = fs.realpathSync(projectDir);
  const share = fs.realpathSync(shareDir);
  const protectedRoots = [
    project,
    ...protectedPaths.filter(fs.existsSync).map(file => fs.realpathSync(file)),
  ];
  // The project must stay fully read-only: a nested share would open a
  // writable hole inside it. Equality with a protected root would re-allow
  // that entire root. Nesting strictly below a non-project root (for example
  // chat session storage under the settings directory) is safe: the write
  // allowance below is re-issued after the protected-root denies, so only the
  // exact share subtree becomes writable.
  if (share === project || share.startsWith(project + path.sep))
    throw Error('Agent session storage must be outside the protected project.');
  if (protectedRoots.some(root => share === root))
    throw Error('Agent session storage must not replace a protected root.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-boundary-'));
  fs.chmodSync(directory, 0o700);
  const scratch = path.join(directory, 'scratch');
  fs.mkdirSync(scratch, { mode: 0o700 });
  // Kimi requires a writable workspace at startup. Use a stable
  // session workspace, while the actual engineering project stays read-only.
  const workDir = path.join(share, 'workspace');
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const projectLink = path.join(workDir, 'project');
  if (!fs.existsSync(projectLink)) fs.symlinkSync(project, projectLink);
  const profile = path.join(directory, 'agent.sb');
  // Descendant processes inherit the Seatbelt restriction. Native Shell,
  // WriteFile, Python and project-controlled MCP children cannot write facts.
  // Runtime tools run in the parent host process, with a separate policy check.
  // Seatbelt rules are order-sensitive: the share/scratch allowance is emitted
  // AFTER the protected-root denies so session storage nested inside a
  // protected runtime root (e.g. chats/ under the settings directory) stays
  // writable while the rest of that root remains read-only.
  if (platform === 'darwin')
    fs.writeFileSync(
      profile,
      `(version 1)\n(allow default)\n(deny file-write*)\n${protectedRoots.map(root => `(deny file-write* (subpath ${seatbeltString(root)}))`).join('\n')}\n(allow file-write* (subpath ${seatbeltString(share)}) (subpath ${seatbeltString(fs.realpathSync(scratch))}) (literal "/dev/null"))\n(deny appleevent-send)\n`,
      { mode: 0o400 },
    );
  const wrapper = path.join(directory, 'kimi');
  const target = executablePath(executable, environment);
  const invocation = /\.[cm]?js$/.test(target)
    ? `${quoteShell(process.execPath)} ${quoteShell(target)}`
    : quoteShell(target);
  const command =
    platform === 'linux'
      ? linuxCommand({
          directory,
          bwrap,
          share,
          scratch: fs.realpathSync(scratch),
          workDir,
          protectedRoots,
          quote: quoteShell,
        })
      : `exec /usr/bin/sandbox-exec -f ${quoteShell(profile)}`;
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nset -e\n${command} ${invocation}${kimiProjectAccess ? ` --add-dir ${quoteShell(project)}` : ''} "$@"\n`,
    { mode: 0o500 },
  );
  return {
    executable: wrapper,
    // Pin both generations of the native home setting to session storage.
    env: {
      ...environment,
      KIMI_SHARE_DIR: share,
      KIMI_CODE_HOME: share,
      TMPDIR: scratch + path.sep,
    },
    directory,
    workDir,
    boundary: {
      platform,
      projectWritable: false,
      projectDir: project,
      agentWorkDir: workDir,
      writableRoots: [share, scratch],
      mechanism: platform === 'linux' ? 'bubblewrap-seccomp' : 'seatbelt',
      hostRuntimeRequired: true,
    },
    close() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

module.exports = { createProcessSandbox };
