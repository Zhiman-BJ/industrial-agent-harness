const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { serviceUrl, hash, writePrivateJson } = require('./remote-client.cjs');

function boundedIdentity(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw Error(`Invalid remote ${name}.`);
  return value;
}

// Credentials participate in isolation, but their plaintext never enters the store.
function gatewayIdentity({ url, credential, serverId = null }) {
  if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential))
    throw Error('Remote credentials are not configured.');
  return hash(JSON.stringify([serviceUrl(url), serverId, hash(credential)]));
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
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384)
        throw Error('Invalid remote session binding file.');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (
        value.schemaVersion !== 1 ||
        value.key !== key ||
        !/^[a-f0-9-]{36}$/.test(value.clientSessionId || '')
      )
        throw Error('Invalid remote session binding.');
      return value;
    } finally {
      fs.closeSync(fd);
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
