const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createConnectionSecretStore } = require('./connection-secret-store.cjs');

test('connection store never falls back to plaintext when OS encryption is unavailable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-store-'));
  try {
    for (const safeStorage of [
      { isEncryptionAvailable: () => false },
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' },
    ]) {
      const store = createConnectionSecretStore({ directory, safeStorage, platform: 'linux' });
      assert.equal(store.available(), false);
      assert.throws(
        () => store.write('fixture/remote', { token: 'private-token' }),
        /Secure credential storage is unavailable/,
      );
      assert.deepEqual(fs.readdirSync(directory), []);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('connection store saves only encrypted opaque records and reports decrypt failures without values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-store-'));
  const key = crypto.randomBytes(32),
    iv = crypto.randomBytes(16);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([cipher.update(value), cipher.final()]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([cipher.update(value), cipher.final()]).toString();
    },
  };
  try {
    const store = createConnectionSecretStore({ directory, safeStorage, platform: 'darwin' });
    store.write('fixture/remote', { token: 'private-token', endpoint: 'https://service.example' });
    const file = path.join(
      directory,
      'runtime-connections',
      fs.readdirSync(path.join(directory, 'runtime-connections'))[0],
    );
    assert.equal(fs.readFileSync(file).includes(Buffer.from('private-token')), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.read('fixture/remote'), {
      token: 'private-token',
      endpoint: 'https://service.example',
    });
    fs.writeFileSync(file, Buffer.from('corrupted'));
    assert.throws(
      () => store.read('fixture/remote'),
      /^Error: Cannot decrypt secure connection settings\.$/,
    );
    safeStorage.isEncryptionAvailable = () => false;
    store.remove('fixture/remote');
    assert.equal(fs.existsSync(file), false);
    assert.equal(store.read('fixture/remote'), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
