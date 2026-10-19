const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');

function writePrivate(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const parent = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// All read/refresh/write/logout transactions share this inter-process lock.
// Desktop injects OS-backed encryption; CLI file storage is explicit opt-in.
class SessionStore {
  constructor({ directory, encryption, allowPlaintext = false }) {
    this.directory = directory;
    this.encryption = encryption;
    this.allowPlaintext = allowPlaintext;
    this.file = path.join(directory, encryption ? 'session.enc' : 'session.json');
    this.memory = null;
    this.queue = Promise.resolve();
  }
  persistent() {
    return Boolean(this.encryption?.available() || this.allowPlaintext);
  }
  async transaction(operation) {
    const previous = this.queue;
    let done;
    this.queue = new Promise(resolve => {
      done = resolve;
    });
    await previous;
    let release;
    let compromised = false;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(this.directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid()))
      )
        throw Error('Account storage requires a private directory owned by the current user.');
      release = await lockfile.lock(this.directory, {
        realpath: false,
        stale: 120000,
        update: 10000,
        retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 },
        onCompromised: () => {
          compromised = true;
        },
      });
      const guard = () => {
        if (compromised) throw Error('Account storage lock was lost. Sign in again.');
      };
      const result = await operation({
        read: () => {
          guard();
          return this.read();
        },
        write: value => {
          guard();
          return this.write(value);
        },
        clear: () => {
          guard();
          return this.clear();
        },
      });
      guard();
      return result;
    } finally {
      try {
        await release?.();
      } finally {
        done();
      }
    }
  }
  read() {
    if (!this.persistent()) return this.memory;
    try {
      // O_NOFOLLOW is unavailable on Windows. Reject links before opening and
      // compare file identities afterwards so a replacement cannot change the target.
      const entry = fs.lstatSync(this.file);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw Error('Account credential file must be a regular file.');
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.dev !== entry.dev ||
          stat.ino !== entry.ino ||
          stat.size > 65536 ||
          (process.platform !== 'win32' && stat.mode & 0o077)
        )
          throw Error('Account credential file permissions are unsafe.');
        const bytes = fs.readFileSync(fd);
        return JSON.parse(
          this.encryption ? this.encryption.decrypt(bytes) : bytes.toString('utf8'),
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('Cannot unlock saved account credentials.');
    }
  }
  write(value) {
    if (!this.persistent()) {
      this.memory = value;
      return;
    }
    const json = JSON.stringify(value);
    writePrivate(this.file, this.encryption ? this.encryption.encrypt(json) : json);
  }
  clear() {
    this.memory = null;
    if (this.encryption || this.allowPlaintext) {
      fs.rmSync(this.file, { force: true });
      if (process.platform !== 'win32') {
        const parent = fs.openSync(this.directory, 'r');
        try {
          fs.fsyncSync(parent);
        } finally {
          fs.closeSync(parent);
        }
      }
    }
  }
}
module.exports = { SessionStore, writePrivate };
