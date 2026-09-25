const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultLogDirectory() {return path.join(os.homedir(), '.industrial-agent-harness', 'logs');}

function createDiagnosticLog(projectDir, {directory = defaultLogDirectory(), apiKey = ''} = {}) {
  const projectKey = crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 16);
  const projectDirectory = path.join(directory, projectKey);
  fs.mkdirSync(projectDirectory, {recursive: true, mode: 0o700});
  fs.chmodSync(projectDirectory, 0o700);
  const traceId = crypto.randomUUID();
  const file = path.join(projectDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${traceId}.jsonl`);
  const fd = fs.openSync(file, 'wx', 0o600);
  let sequence = 0;
  let closed = false;
  const sensitiveKeys = /^(api_?key|authorization|access_?token|password|secret)$/i;
  return {
    traceId,
    file,
    record(type, payload) {
      if (closed) throw Error('Diagnostic log is closed.');
      const row = {schemaVersion: 1, traceId, sequence: ++sequence, at: new Date().toISOString(), type, payload};
      const json = JSON.stringify(row, (key, value) => {
        if (sensitiveKeys.test(key)) return '[REDACTED]';
        return apiKey && typeof value === 'string' ? value.replaceAll(apiKey, '[REDACTED_API_KEY]') : value;
      });
      const bytes = Buffer.from(`${json}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw Error('Diagnostic log write made no progress.');
        offset += written;
      }
    },
    close() {if (!closed) {closed = true; try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}},
  };
}

module.exports = {createDiagnosticLog, defaultLogDirectory};
