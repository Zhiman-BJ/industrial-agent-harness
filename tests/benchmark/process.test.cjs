const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { signalProcess } = require('../../scripts/lib/benchmark-process.cjs');

function darwin(t) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

test('Darwin cleanup tolerates an exited group but checks all descendants before ignoring EPERM', t => {
  darwin(t);
  const denied = Object.assign(Error('kill EPERM'), { code: 'EPERM' });
  t.mock.method(process, 'kill', () => {
    throw denied;
  });
  const scan = t.mock.method(childProcess, 'execFileSync', () => '21 Z\n21 Z+\n22 S\n');
  assert.doesNotThrow(() => signalProcess({ pid: 21 }, 'SIGTERM'));
  assert.deepEqual(scan.mock.calls[0].arguments.slice(0, 2), ['/bin/ps', ['-axo', 'pgid=,stat=']]);
  scan.mock.mockImplementation(() => '22 S\n');
  assert.doesNotThrow(() => signalProcess({ pid: 21 }, 'SIGKILL'));
  scan.mock.mockImplementation(() => '21 Z\n21 S\n');
  assert.throws(
    () => signalProcess({ pid: 21 }, 'SIGKILL'),
    error => error === denied,
  );
  scan.mock.mockImplementation(() => {
    throw Error('Unavailable process observation');
  });
  assert.throws(
    () => signalProcess({ pid: 21 }, 'SIGKILL'),
    error => error === denied,
  );
});

test('missing groups need no process observation and non-Darwin permission failures remain errors', t => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', original));
  const missing = Object.assign(Error('missing group'), { code: 'ESRCH' });
  const denied = Object.assign(Error('permission denied'), { code: 'EPERM' });
  const kill = t.mock.method(process, 'kill', () => {
    throw missing;
  });
  const scan = t.mock.method(childProcess, 'execFileSync', () => {
    throw Error('must not inspect');
  });
  assert.doesNotThrow(() => signalProcess({ pid: 21 }, 'SIGKILL'));
  assert.equal(scan.mock.calls.length, 0);
  kill.mock.mockImplementation(() => {
    throw denied;
  });
  assert.throws(
    () => signalProcess({ pid: 21 }, 'SIGKILL'),
    error => error === denied,
  );
  assert.equal(scan.mock.calls.length, 0);
});
