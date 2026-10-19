const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function writePrivateJson(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = exclusive ? file : file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (!exclusive) fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const parent = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
  } finally {
    if (!exclusive) fs.rmSync(temporary, { force: true });
  }
}
const uuid = value => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw Error('Invalid remote identity.');
  return value;
};
function serviceUrl(value) {
  const url = new URL(value);
  if (
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error(
      'Remote service requires a clean HTTPS origin (loopback HTTP is allowed for development).',
    );
  return url.origin;
}

// Shared identity and private persistence helpers for the session gateway.
module.exports = { serviceUrl, hash, uuid, writePrivateJson };
