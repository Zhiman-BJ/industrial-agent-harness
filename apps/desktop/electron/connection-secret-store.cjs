const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The shared connection layer owns validation and field policy. This adapter
// stores opaque records encrypted by the OS-backed Electron credential service.
function createConnectionSecretStore({ directory, safeStorage, platform = process.platform }) {
  const root = path.join(directory, 'runtime-connections');
  const available = () => {
    try {
      return (
        safeStorage.isEncryptionAvailable() &&
        (platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
      );
    } catch {
      return false;
    }
  };
  function filename(key) {
    if (typeof key !== 'string' || !key || key.length > 256)
      throw Error('Invalid connection storage key.');
    return path.join(root, crypto.createHash('sha256').update(key).digest('hex') + '.bin');
  }
  function requireSecureStorage() {
    if (!available())
      throw Error(
        'Secure credential storage is unavailable. Configure the trusted host environment instead.',
      );
  }
  return {
    available,
    remove(key) {
      const file = filename(key);
      if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink())
        throw Error('Secure connection directory must not be a symlink.');
      fs.rmSync(file, { force: true });
    },
    read(key) {
      const file = filename(key);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) return null;
      requireSecureStorage();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024)
        throw Error('Cannot read secure connection settings.');
      try {
        return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      } catch {
        throw Error('Cannot decrypt secure connection settings.');
      }
    },
    write(key, value) {
      requireSecureStorage();
      const file = filename(key);
      const plaintext = JSON.stringify(value);
      if (plaintext.length > 64 * 1024)
        throw Error('Connection settings exceed the supported size.');
      const encrypted = safeStorage.encryptString(plaintext);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(root).isSymbolicLink())
        throw Error('Secure connection directory must not be a symlink.');
      const temporary = file + '.' + crypto.randomUUID();
      fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}
module.exports = { createConnectionSecretStore };
