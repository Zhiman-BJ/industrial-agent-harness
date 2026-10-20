// OS isolation for native Agent processes, layered inside the launcher.
//
// The design follows Anthropic's sandbox-runtime model: a single pure-data
// policy describes the boundary, and thin per-platform emitters translate it
// into OS primitives (macOS Seatbelt profile / Linux bubblewrap mounts). All
// rules live in one table so a future migration to a maintained sandbox
// library is a config translation, not a rewrite.
//
// Linux socket egress needs an explicit syscall filter: read-only bind
// mounts do NOT stop connect() to host unix sockets — inode permission
// checks for sockets ignore mount read-only state (only REG/DIR/LNK honor
// it). Like sandbox-runtime's apply-seccomp, the bubblewrap emitter attaches
// a small seccomp BPF program that fails socket(AF_UNIX, ...) with EPERM and
// blocks io_uring (IORING_OP_SOCKET would bypass the socket() rule).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

// Pure-data boundary description, modeled on the workspace-write semantics of
// mature agent sandboxes (Claude Code / Codex): the engineering project,
// session storage and scratch are writable; every other write is denied.
// denyRead carves secrets out of the otherwise open read side; network stays
// open over TCP/UDP for model APIs and the host loopback tool server, while
// outbound Unix-socket connects are denied to close the container-socket
// escape. protectedRoots names host state (settings, runtime stores) that
// stays read-only even though the project itself is writable.
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
      writable: [project, share, scratch],
      protected: protectedRoots,
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
// primitives cannot be probed or validated from here. Detection is a real
// launch probe, not an existence check — a bubblewrap that cannot create
// user namespaces (Ubuntu 24.04+ AppArmor policy, hardened kernels) must
// fall back to the current-user launcher instead of failing the session.
// Probes are cached per command path; they cost a few milliseconds once.
const probeCache = new Map();
function probePrimitive(command, args) {
  if (!probeCache.has(command)) {
    let ok = false;
    try {
      ok = spawnSync(command, args, { stdio: 'ignore', timeout: 10000 }).status === 0;
    } catch {}
    probeCache.set(command, ok);
  }
  return probeCache.get(command);
}

function detectIsolation(platform, environment) {
  if (platform !== process.platform) return null;
  if (
    platform === 'darwin' &&
    fs.existsSync('/usr/bin/sandbox-exec') &&
    probePrimitive('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
  )
    return { mechanism: 'seatbelt', command: '/usr/bin/sandbox-exec' };
  if (platform === 'linux') {
    const bwrap = which('bwrap', environment);
    if (
      bwrap &&
      probePrimitive(bwrap, [
        '--unshare-user',
        '--unshare-pid',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--',
        '/bin/true',
      ])
    )
      return { mechanism: 'bubblewrap', command: bwrap };
  }
  return null;
}

// Seatbelt rules and bubblewrap mounts are both last-one-wins within a
// nesting chain, so write rules must be emitted shallow-to-deep across the
// UNION of protected and writable roots: a protected root nested inside the
// project (a domain pack's workspaceProtectedPaths, e.g. sealed reference
// data) is re-affirmed AFTER the project allowance, while session storage
// nested inside a protected root is re-allowed after that root's deny. At
// equal depth an allow sorts before a deny so a contradictory same-path
// entry resolves to deny.
function orderedWriteRules(policy) {
  // Count both separators so the ordering is testable with POSIX fixture
  // paths on any host and correct for native paths on Windows alike.
  const depth = file => file.split(/[\\/]/).length;
  return [
    ...policy.filesystem.writable.map(file => ({ file, allow: true })),
    ...policy.filesystem.protected.map(file => ({ file, allow: false })),
  ].sort((a, b) => depth(a.file) - depth(b.file) || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
}

// Minimal seccomp BPF program for the bubblewrap wrap, modeled on Anthropic
// sandbox-runtime's apply-seccomp: socket(AF_UNIX, ...) fails with EPERM and
// the io_uring syscalls fail with EPERM (IORING_OP_SOCKET on Linux 5.19+
// would bypass the socket() rule). socketpair(AF_UNIX) stays allowed so
// language runtimes keep their internal pipes; every other syscall is
// untouched. x86_64 and aarch64 only — other architectures get no filter and
// the boundary reports unixSocketsFiltered:false. The program is a raw
// struct sock_filter array, the format bwrap's --seccomp fd expects.
const BPF_LD_ABS_W = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_KILL = 0x80000000;
const RET_ERRNO_EPERM = 0x00050000 + 1;
const AF_UNIX = 1;
const IO_URING_SYSCALLS = [425, 426, 427]; // setup, enter, register (x86_64 & aarch64)
const SECCOMP_ARCHES = {
  x64: { audit: 0xc000003e, socket: 41 },
  arm64: { audit: 0xc00000b7, socket: 198 },
};

function seccompUnixSocketFilter(arch = process.arch) {
  const target = SECCOMP_ARCHES[arch];
  if (!target) return null;
  // seccomp_data layout: nr@0 (u32), arch@4 (u32), args@16 (u64 each).
  // All jumps are forward; the return blocks sit at the end:
  //   11: ERRNO(EPERM)  12: ALLOW  13: KILL_PROCESS
  const instructions = [
    [BPF_LD_ABS_W, 0, 0, 4], // A = arch
    [BPF_JEQ_K, 0, 11, target.audit], // != native arch -> KILL (blocks 32-bit bypass)
    [BPF_LD_ABS_W, 0, 0, 0], // A = syscall nr
    [BPF_JEQ_K, 3, 0, target.socket], // socket() -> arg check at 7
    [BPF_JEQ_K, 6, 0, IO_URING_SYSCALLS[0]], // io_uring_setup -> ERRNO
    [BPF_JEQ_K, 5, 0, IO_URING_SYSCALLS[1]], // io_uring_enter -> ERRNO
    [BPF_JEQ_K, 4, 5, IO_URING_SYSCALLS[2]], // io_uring_register -> ERRNO, else ALLOW
    [BPF_LD_ABS_W, 0, 0, 20], // A = arg0 high u32
    [BPF_JEQ_K, 0, 3, 0], // high != 0 -> ALLOW (cannot be AF_UNIX)
    [BPF_LD_ABS_W, 0, 0, 16], // A = arg0 low u32 (domain)
    [BPF_JEQ_K, 0, 1, AF_UNIX], // == AF_UNIX -> ERRNO, else ALLOW
    [BPF_RET_K, 0, 0, RET_ERRNO_EPERM],
    [BPF_RET_K, 0, 0, RET_ALLOW],
    [BPF_RET_K, 0, 0, RET_KILL],
  ];
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    program.writeUInt16LE(code, index * 8);
    program.writeUInt8(jt, index * 8 + 2);
    program.writeUInt8(jf, index * 8 + 3);
    program.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return program;
}

// Seatbelt rules are order-sensitive: later rules override earlier ones.
// Write rules come from orderedWriteRules (shallow-to-deep across protected
// and writable roots) so nested protections survive a broader allowance and
// nested writable storage survives a broader deny. The system-socket allows
// likewise come after the Unix-socket deny, so only those exact exceptions
// open.
function seatbeltProfile(policy) {
  const quote = value => JSON.stringify(value);
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
  for (const rule of orderedWriteRules(policy))
    lines.push(`(${rule.allow ? 'allow' : 'deny'} file-write* (subpath ${quote(rule.file)}))`);
  lines.push('(allow file-write* (literal "/dev/null"))');
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

// Mount order mirrors the Seatbelt rule order: `/` is read-only-bound, then
// write rules mount shallow-to-deep across protected and writable roots —
// a later mount shadows earlier mounts beneath it, so a protected root
// inside the project must be re-bound AFTER the project bind, exactly like
// the Seatbelt deny ordering. Credential paths are masked over the read-only
// root: directories get an empty tmpfs, files get /dev/null. Unix-socket
// egress is NOT covered by the read-only root (connect() ignores mount
// read-only state for sockets) — when seccompFd is given, bwrap loads the
// AF_UNIX-blocking filter from that fd (see seccompUnixSocketFilter).
function bubblewrapArgs(policy, { workDir, seccompFd = null }) {
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
  for (const rule of orderedWriteRules(policy))
    args.push(rule.allow ? '--bind' : '--ro-bind', rule.file, rule.file);
  for (const file of policy.filesystem.denyRead) {
    try {
      if (fs.statSync(file).isDirectory()) args.push('--tmpfs', file);
      else args.push('--ro-bind', '/dev/null', file);
    } catch {}
  }
  if (seccompFd !== null) args.push('--seccomp', String(seccompFd));
  args.push('--chdir', workDir, '--');
  return args;
}

module.exports = {
  buildIsolationPolicy,
  detectIsolation,
  orderedWriteRules,
  seccompUnixSocketFilter,
  seatbeltProfile,
  bubblewrapArgs,
  defaultSensitiveReads,
};
