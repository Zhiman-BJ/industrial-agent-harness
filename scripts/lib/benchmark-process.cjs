const childProcess = require('node:child_process');
const { spawn } = childProcess;

function exitedDarwinGroup(pid) {
  try {
    // Darwin killpg skips zombies and can return EPERM when none remain
    // signalable. Check every member so a real permission denial on a live
    // descendant is never suppressed. XNU: bsd/kern/kern_sig.c, killpg1.
    const rows = childProcess
      .execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      })
      .trim()
      .split('\n')
      .map(row => row.trim().split(/\s+/))
      .filter(([group]) => Number(group) === pid);
    return rows.every(([, state]) => /^Z/.test(state || ''));
  } catch {
    return false;
  }
}

// Start one process group so cancellation also reaps tool/session descendants.
function startProcess(executable, args, options = {}) {
  return spawn(executable, args, {
    ...options,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function signalProcess(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => child.kill(signal));
      } else child.kill(signal);
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM' && process.platform === 'darwin' && exitedDarwinGroup(child.pid))
      return;
    throw error;
  }
}

module.exports = { startProcess, signalProcess };
