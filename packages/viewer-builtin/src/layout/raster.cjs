const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const STDERR_BYTES = 4096;

function resolveLayoutScript(directory = __dirname) {
  // Python has no Electron ASAR filesystem patch. Even files declared unpacked
  // must be passed to it using their actual on-disk path.
  const unpacked = directory.replace(/(^|[\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
  for (const name of ['layout.py', 'layout_themes.py']) {
    try {
      const file = path.join(unpacked, name);
      if (!fs.statSync(file).isFile()) throw Error('Not a regular file.');
      fs.accessSync(file, fs.constants.R_OK);
    } catch {
      throw Error(
        `KLayout renderer script is missing or unreadable: ${name}. Reinstall the application.`,
      );
    }
  }
  return path.join(unpacked, 'layout.py');
}

class RasterService {
  constructor(python, { scriptDirectory = __dirname } = {}) {
    this.python = python;
    this.scriptDirectory = scriptDirectory;
    this.stderr = Buffer.alloc(0);
    this.pending = new Map();
    this.sequence = 0;
    this.serial = Promise.resolve();
  }
  start() {
    if (this.worker) return;
    // Ignore Python startup overrides and user packages, while retaining this
    // trusted script directory for its adjacent layout_themes module.
    const script = resolveLayoutScript(this.scriptDirectory);
    this.worker = spawn(this.python, ['-B', '-E', '-s', '-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.worker.stderr.on('data', chunk => {
      this.stderr = Buffer.concat([this.stderr, chunk.subarray(-STDERR_BYTES)]).subarray(
        -STDERR_BYTES,
      );
    });
    this.worker.on('error', error =>
      this.fail(`KLayout renderer could not start: ${error.message}`),
    );
    // close follows stdio drain; exit alone can lose the diagnostic we need.
    this.worker.on('close', (code, signal) => {
      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = this.stderr.toString('utf8').trim();
      this.fail(
        `KLayout renderer stopped. Reopen the layout to retry. (${status})` +
          (detail ? `\n${detail}` : ''),
      );
    });
    this.worker.stdin.on('error', error => {
      // An exiting interpreter can close stdin before stderr has drained.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') this.fail(error.message);
    });
    readline.createInterface({ input: this.worker.stdout }).on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.fail('Invalid KLayout response.');
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(Error(message.error)) : pending.resolve(message.result);
    });
  }
  fail(message) {
    if (this.failure) return;
    this.failure = message;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(message));
    }
    this.pending.clear();
  }
  call(request) {
    const result = this.serial.then(
      () =>
        new Promise((resolve, reject) => {
          if (this.failure) return reject(Error(this.failure));
          this.start();
          const id = ++this.sequence;
          const timer = setTimeout(() => {
            this.fail('KLayout render timed out.');
            this.worker?.kill();
          }, 120000);
          this.pending.set(id, { resolve, reject, timer });
          this.worker.stdin.write(JSON.stringify({ ...request, id }) + '\n');
        }),
    );
    this.serial = result.catch(() => {});
    return result;
  }
  close() {
    this.fail('Renderer closed.');
    this.worker?.kill();
  }
}
module.exports = { RasterService, resolveLayoutScript };
