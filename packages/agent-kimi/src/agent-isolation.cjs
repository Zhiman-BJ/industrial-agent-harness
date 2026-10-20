// OS isolation for native Agent processes, layered inside the launcher.
//
// The design follows Anthropic's sandbox-runtime model: a single pure-data
// policy describes the boundary, and thin per-platform emitters translate it
// into OS primitives (macOS Seatbelt profile / Linux bubblewrap mounts). All
// rules live in one table so a future migration to a maintained sandbox
// library is a config translation, not a rewrite. No hand-rolled seccomp:
// with `/` read-only-bound, the container-runtime socket is read-only and
// Unix-socket connects (which require write permission) already fail.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Credential and container-runtime paths a sandboxed agent must never read.
// Reads are otherwise unrestricted so engineering context stays visible, but
// these locations hold secrets (or the Docker socket) whose exposure would
// defeat the write boundary: the public escape chain connects to the host
// Docker socket and mounts the user home into a privileged container.
const SENSITIVE_READ_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.orbstack',
  '.colima',
  '.kube',
  path.join('.config', 'gh'),
];
const SENSITIVE_READ_FILES = ['.netrc', '.git-credentials'];

// macOS resolves DNS and logs through these system Unix sockets. They are
// re-allowed after the blanket outbound deny (later Seatbelt rules win):
// without mDNSResponder every HTTPS call inside the sandbox fails.
const SYSTEM_SOCKETS = ['/var/run/mDNSResponder', '/var/run/syslog'];

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function which(executable, environment) {
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      const target = fs.realpathSync(path.join(directory, executable));
      fs.accessSync(target, fs.constants.X_OK);
      return target;
    } catch {}
  }
  return null;
}

function defaultSensitiveReads(home = os.homedir()) {
  if (!home) return [];
  return [...SENSITIVE_READ_DIRS, ...SENSITIVE_READ_FILES].map(name => path.join(home, name));
}

// Pure-data boundary description. writable is allow-only (everything else is
// read-only); denyRead carves secrets out of the otherwise open read side;
// network stays open over TCP/UDP for model APIs and the host loopback tool
// server, while outbound Unix-socket connects are denied to close the
// container-socket escape.
function buildIsolationPolicy({
  project,
  share,
  scratch,
  protectedRoots = [],
  sensitiveReadPaths,
  home,
}) {
  return {
    filesystem: {
      writable: [share, scratch],
      readOnly: [project, ...protectedRoots],
      denyRead: (sensitiveReadPaths || defaultSensitiveReads(home))
        .filter(fs.existsSync)
        .map(realpath),
    },
    network: {
      tcp: 'allow',
      outboundUnixSockets: 'deny',
      allowUnixSockets: SYSTEM_SOCKETS.filter(fs.existsSync).map(realpath),
    },
    ipc: { appleEvents: 'deny' },
  };
}

// Isolation only engages for the host platform: a foreign platform's
// primitives cannot be probed or validated from here.
function detectIsolation(platform, environment) {
  if (platform !== process.platform) return null;
  if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec'))
    return { mechanism: 'seatbelt', command: '/usr/bin/sandbox-exec' };
  if (platform === 'linux') {
    const bwrap = which('bwrap', environment);
    if (bwrap) return { mechanism: 'bubblewrap', command: bwrap };
  }
  return null;
}

// Seatbelt rules are order-sensitive: later rules override earlier ones. The
// writable allowance comes AFTER the global write deny, and the system-socket
// allows come AFTER the Unix-socket deny, so only those exact exceptions open.
function seatbeltProfile(policy) {
  const quote = value => JSON.stringify(value);
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
  for (const root of policy.filesystem.readOnly)
    lines.push(`(deny file-write* (subpath ${quote(root)}))`);
  lines.push(
    `(allow file-write* ${policy.filesystem.writable
      .map(file => `(subpath ${quote(file)})`)
      .join(' ')} (literal "/dev/null"))`,
  );
  if (policy.ipc.appleEvents === 'deny') lines.push('(deny appleevent-send)');
  if (policy.filesystem.denyRead.length)
    lines.push(
      `(deny file-read* ${policy.filesystem.denyRead
        .map(file => `(subpath ${quote(file)})`)
        .join(' ')})`,
    );
  if (policy.network.outboundUnixSockets === 'deny') {
    lines.push('(deny network-outbound (remote unix-socket))');
    for (const socket of policy.network.allowUnixSockets)
      lines.push(`(allow network-outbound (remote unix-socket (path ${quote(socket)})))`);
  }
  return lines.join('\n') + '\n';
}

// Mount-order matters like Seatbelt rule order: protected roots are
// read-only-bound first and the writable binds come after, so session storage
// nested inside a protected root stays writable while the root itself remains
// read-only. Credential paths are masked over the read-only root: directories
// get an empty tmpfs, files get /dev/null.
function bubblewrapArgs(policy, { workDir }) {
  const args = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ];
  for (const root of policy.filesystem.readOnly) args.push('--ro-bind', root, root);
  for (const file of policy.filesystem.writable) args.push('--bind', file, file);
  for (const file of policy.filesystem.denyRead) {
    try {
      if (fs.statSync(file).isDirectory()) args.push('--tmpfs', file);
      else args.push('--ro-bind', '/dev/null', file);
    } catch {}
  }
  args.push('--chdir', workDir, '--');
  return args;
}

module.exports = {
  buildIsolationPolicy,
  detectIsolation,
  seatbeltProfile,
  bubblewrapArgs,
  defaultSensitiveReads,
};
