const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { SessionStore } = require('../src/store.cjs');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('OS encryption adapter stores ciphertext and atomic replacements with private permissions', async t => {
  const key = crypto.randomBytes(32);
  const store = new SessionStore({
    directory: temp(t),
    encryption: {
      available: () => true,
      encrypt: text => {
        const iv = crypto.randomBytes(12),
          c = crypto.createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([c.update(text), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), data]);
      },
      decrypt: bytes => {
        const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        c.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString();
      },
    },
  });
  await store.transaction(tx => tx.write({ refreshToken: 'secret-refresh' }));
  assert.ok(!fs.readFileSync(store.file).includes(Buffer.from('secret-refresh')));
  assert.equal(store.read().refreshToken, 'secret-refresh');
  await store.transaction(tx => tx.write({ refreshToken: 'rotated-refresh' }));
  assert.equal(store.read().refreshToken, 'rotated-refresh');
  assert.deepEqual(fs.readdirSync(store.directory), ['session.enc']);
});
test('unavailable secure storage keeps credentials in memory and never falls back to plaintext', async t => {
  const directory = temp(t);
  const store = new SessionStore({
    directory,
    encryption: {
      available: () => false,
      encrypt: () => {
        throw Error('must not encrypt');
      },
    },
  });
  await store.transaction(tx => tx.write({ refreshToken: 'secret' }));
  assert.equal(store.read().refreshToken, 'secret');
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(new SessionStore({ directory }).read(), null);
});
test('CLI file store is explicit and rejects unsafe permissions and symlinks', async t => {
  const directory = temp(t),
    store = new SessionStore({ directory, allowPlaintext: true });
  await store.transaction(tx => tx.write({ refreshToken: 'secret' }));
  if (process.platform !== 'win32') {
    fs.chmodSync(store.file, 0o644);
    assert.throws(() => store.read(), /unlock/);
    fs.chmodSync(store.file, 0o600);
  }
  const target = path.join(directory, 'target');
  fs.renameSync(store.file, target);
  fs.symlinkSync(target, store.file);
  assert.throws(() => store.read(), /unlock/);
});
test('credential reads reject replacement between the path check and opening the file', async t => {
  const directory = temp(t),
    store = new SessionStore({ directory, allowPlaintext: true });
  await store.transaction(tx => tx.write({ refreshToken: 'original' }));
  const replacement = path.join(directory, 'replacement');
  fs.writeFileSync(replacement, JSON.stringify({ refreshToken: 'replacement' }), { mode: 0o600 });
  const originalOpen = fs.openSync;
  let replaced = false;
  const open = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === store.file && !replaced) {
      replaced = true;
      fs.renameSync(store.file, path.join(directory, 'previous'));
      fs.renameSync(replacement, store.file);
    }
    return originalOpen(file, ...args);
  });
  try {
    assert.throws(() => store.read(), /unlock/);
    assert.equal(replaced, true);
  } finally {
    open.mock.restore();
  }
  assert.equal(store.read().refreshToken, 'replacement');
});
test('memory-only commands do not delete an opted-in CLI file session', async t => {
  const directory = temp(t);
  const persisted = new SessionStore({ directory, allowPlaintext: true });
  await persisted.transaction(tx => tx.write({ refreshToken: 'kept' }));
  const memory = new SessionStore({ directory });
  await memory.transaction(tx => tx.clear());
  assert.equal(persisted.read().refreshToken, 'kept');
});
