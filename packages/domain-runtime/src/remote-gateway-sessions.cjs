const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { serviceUrl, hash, writePrivateJson } = require('./remote-client.cjs');

function boundedIdentity(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw Error(`Invalid remote ${name}.`);
  return value;
}

function bindingFileStat(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink())
    throw Object.assign(Error('ELOOP: Remote session binding cannot be a symlink.'), {
      code: 'ELOOP',
    });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > 16384n)
    throw Error('Invalid remote session binding file.');
  return stat;
}

// Credentials participate in isolation, but their plaintext never enters the store.
// Account-bound clients pass a stable credentialKey because their token rotates;
// a static credential is hashed directly. Either way only digests are persisted.
function gatewayIdentity({ url, credential, credentialKey, serverId = null }) {
  const material =
    typeof credential === 'string' && credential && !/[\r\n]/.test(credential)
      ? hash(credential)
      : credentialKey;
  if (typeof material !== 'string' || !/^[a-f0-9]{64}$/.test(material))
    throw Error('Remote credentials are not configured.');
  return hash(JSON.stringify([serviceUrl(url), serverId, material]));
}

class RemoteGatewaySessions {
  constructor({ directory }) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Session store cannot be a symlink.');
    this.directory = fs.realpathSync(directory);
  }
  binding(input) {
    const serviceIdentity = gatewayIdentity(input);
    const remoteProjectId = boundedIdentity(input.remoteProjectId, 'project identity');
    const domain = boundedIdentity(input.domain, 'domain');
    const chatId = boundedIdentity(input.chatId, 'chat identity');
    const key = hash(JSON.stringify([serviceIdentity, remoteProjectId, domain, chatId]));
    const file = this.file(key);
    let value;
    try {
      value = this.read(key);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      value = {
        schemaVersion: 1,
        key,
        serviceIdentity,
        remoteProjectId,
        domain,
        chatId,
        clientSessionId: crypto.randomUUID(),
        applicationSessionId: null,
        createdAt: new Date().toISOString(),
      };
      try {
        writePrivateJson(file, value, true);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        value = this.read(key);
      }
    }
    if (
      value.key !== key ||
      value.serviceIdentity !== serviceIdentity ||
      value.remoteProjectId !== remoteProjectId ||
      value.domain !== domain ||
      value.chatId !== chatId
    )
      throw Error('Remote session binding changed.');
    return Object.freeze({ ...value });
  }
  file(key) {
    if (!/^[a-f0-9]{64}$/.test(key || '')) throw Error('Invalid session store key.');
    return path.join(this.directory, key + '.json');
  }
  read(key) {
    const file = this.file(key);
    // Windows does not expose O_NOFOLLOW. Check the path explicitly and bind
    // the opened descriptor to the same file before reading any session data.
    const before = bindingFileStat(file);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd, { bigint: true });
      const after = bindingFileStat(file);
      if (
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.dev !== after.dev ||
        stat.ino !== after.ino
      )
        throw Error('Remote session binding file changed during read.');
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > 16384n)
        throw Error('Invalid remote session binding file.');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (
        value.schemaVersion !== 1 ||
        value.key !== key ||
        !/^[a-f0-9-]{36}$/.test(value.clientSessionId || '')
      )
        throw Error('Invalid remote session binding.');
      return value;
    } catch (error) {
      // Once observed, a disappearing binding is a race, not a new session.
      if (error.code === 'ENOENT')
        throw Error('Remote session binding file changed during read.', { cause: error });
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  update(binding, changes) {
    const current = this.read(binding.key);
    if (current.clientSessionId !== binding.clientSessionId)
      throw Error('Remote session binding changed.');
    if (Object.keys(changes).some(key => !['applicationSessionId', 'status'].includes(key)))
      throw Error('Only observed remote session status may be updated.');
    if (changes.applicationSessionId !== undefined && changes.applicationSessionId !== null)
      boundedIdentity(changes.applicationSessionId, 'application session identity');
    if (changes.status !== undefined) boundedIdentity(changes.status, 'session status');
    const value = { ...current, ...changes, updatedAt: new Date().toISOString() };
    writePrivateJson(this.file(binding.key), value);
    return Object.freeze(value);
  }
}

module.exports = { RemoteGatewaySessions, gatewayIdentity, boundedIdentity };
