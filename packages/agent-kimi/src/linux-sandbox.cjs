const fs = require('node:fs');
const path = require('node:path');

// Bubblewrap supplies the mount/PID/user boundary. An inherited seccomp filter
// also blocks host Unix sockets (Docker, D-Bus, SSH agent) and namespace changes.
// TCP/UDP remain available for model providers; stdio and socketpair still work.
function seccompFilter(arch = process.arch) {
  const identity = {
    x64: { audit: 0xc000003e, socket: 41, blocked: [101, 155, 165, 166, 272, 308] },
  }[arch];
  if (!identity) throw Error(`Linux process isolation is unavailable on ${arch}.`);
  const instructions = [];
  const add = (code, jt, jf, value) => instructions.push({ code, jt, jf, value });
  const deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
  add(0x20, 0, 0, 4); // seccomp_data.arch
  add(0x15, 1, 0, identity.audit);
  add(0x06, 0, 0, 0x80000000); // kill on an unexpected syscall ABI
  add(0x20, 0, 0, 0); // seccomp_data.nr
  if (arch === 'x64') {
    add(0x45, 0, 1, 0x40000000); // reject the x32 ABI, even on x86-64
    add(0x06, 0, 0, 0x80000000);
  }
  for (const syscall of [...identity.blocked, 428, 429, 430, 431, 432, 433, 442]) {
    add(0x15, 0, 1, syscall);
    add(0x06, 0, 0, deny);
  }
  add(0x15, 0, 4, identity.socket);
  add(0x20, 0, 0, 16); // socket's address-family argument
  add(0x15, 2, 0, 2); // AF_INET
  add(0x15, 1, 0, 10); // AF_INET6
  add(0x06, 0, 0, deny);
  add(0x06, 0, 0, 0x7fff0000); // SECCOMP_RET_ALLOW
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(({ code, jt, jf, value }, index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = jt;
    bytes[index * 8 + 3] = jf;
    bytes.writeUInt32LE(value, index * 8 + 4);
  });
  return bytes;
}

function linuxCommand({ directory, bwrap, share, scratch, workDir, protectedRoots, quote }) {
  const filter = path.join(directory, 'agent.seccomp');
  fs.writeFileSync(filter, seccompFilter(), { mode: 0o400 });
  const args = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    // Mounts stack in order: protected roots are read-only-bound FIRST and the
    // writable share/scratch binds come after, so session storage nested inside
    // a protected root still ends up writable while the root stays read-only.
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    ...protectedRoots.flatMap(root => ['--ro-bind', root, root]),
    '--bind',
    share,
    share,
    '--bind',
    scratch,
    scratch,
    '--chdir',
    workDir,
    '--seccomp',
    '5',
    '--',
  ];
  return `exec 5< ${quote(filter)}\nexec ${quote(bwrap)} ${args.map(quote).join(' ')}`;
}

module.exports = { linuxCommand };
