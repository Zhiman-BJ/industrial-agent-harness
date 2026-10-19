const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RemoteGatewaySessions } = require('../src/remote-gateway-sessions.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-binding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    store: new RemoteGatewaySessions({ directory }),
    input: {
      url: 'https://gateway.example',
      credential: 'private-binding-credential',
      serverId: 'server-1',
      remoteProjectId: 'project-1',
      domain: 'test',
      chatId: 'chat-1',
    },
  };
}

test('stable chat binding survives reconnect and restart without storing credentials', t => {
  const f = fixture(t);
  const first = f.store.binding(f.input);
  assert.equal(f.store.binding(f.input).clientSessionId, first.clientSessionId);
  assert.equal(
    new RemoteGatewaySessions({ directory: f.directory }).binding(f.input).clientSessionId,
    first.clientSessionId,
  );
  const updated = f.store.update(first, { applicationSessionId: 'application-1', status: 'idle' });
  assert.equal(f.store.binding(f.input).applicationSessionId, 'application-1');
  assert.equal(updated.clientSessionId, first.clientSessionId);
  const contents = fs.readFileSync(path.join(f.directory, first.key + '.json'), 'utf8');
  assert.ok(!contents.includes(f.input.credential));
  assert.throws(() => f.store.update(first, { clientSessionId: 'other' }), /Only observed/);
});

test('different chat, project, domain, service identity or credentials isolate application keys', t => {
  const f = fixture(t);
  const original = f.store.binding(f.input);
  const variants = [
    { chatId: 'chat-2' },
    { remoteProjectId: 'project-2' },
    { domain: 'test-other' },
    { url: 'https://other.example' },
    { serverId: 'server-2' },
    { credential: 'another-credential' },
  ];
  const keys = variants.map(change => f.store.binding({ ...f.input, ...change }).clientSessionId);
  assert.equal(new Set([original.clientSessionId, ...keys]).size, 7);
});

test('corrupt or symlink binding files fail closed', t => {
  const f = fixture(t);
  const binding = f.store.binding(f.input);
  const file = path.join(f.directory, binding.key + '.json');
  const target = path.join(f.directory, 'target');
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  assert.throws(() => f.store.binding(f.input), /ELOOP/);
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...binding, remoteProjectId: 'switched' }));
  assert.throws(() => f.store.binding(f.input), /changed/);
});

for (const replacement of [
  'file before open',
  'file after open',
  'symlink before open',
  'removal after open',
]) {
  test(`binding reads reject ${replacement} replacement and close the descriptor`, t => {
    const f = fixture(t);
    const binding = f.store.binding(f.input);
    const file = f.store.file(binding.key);
    const original = path.join(f.directory, 'original');
    const contents = fs.readFileSync(file, 'utf8');
    const open = fs.openSync;
    let swapped = false;
    let descriptor;
    t.mock.method(fs, 'openSync', (candidate, flags, ...args) => {
      if (candidate !== file || swapped) return open(candidate, flags, ...args);
      swapped = true;
      if (replacement.endsWith('after open')) descriptor = open(candidate, flags, ...args);
      fs.renameSync(file, original);
      if (replacement === 'symlink before open') fs.symlinkSync(original, file);
      else if (replacement !== 'removal after open') fs.writeFileSync(file, contents);
      // Exercise Windows open semantics on every host, including a symlink
      // targeting the original inode that a descriptor-only check would miss.
      descriptor ??= open(candidate, flags & ~(fs.constants.O_NOFOLLOW || 0), ...args);
      return descriptor;
    });
    assert.throws(
      () => f.store.binding(f.input),
      replacement === 'symlink before open' ? /ELOOP/ : /changed during read/,
    );
    assert.equal(swapped, true);
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    if (replacement === 'removal after open')
      assert.equal(fs.existsSync(file), false, 'A disappearing binding must not create a session');
  });
}
