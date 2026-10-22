const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;
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
const STALE = 'Layout request superseded by a newer viewport.';
const NO_MONITOR =
  'Layout tile rendering unsupported: resource monitoring is unavailable on this platform.';
function processRss(pid) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') return resolve(null);
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1500 }, (error, stdout) => {
      if (error) return reject(error);
      const kib = Number(stdout.trim());
      resolve(Number.isFinite(kib) ? kib * 1024 : null);
    });
  });
}

/** Bounded display worker. The host supplies an immutable, checked input snapshot. */
class RasterService {
  constructor(python, options = {}) {
    this.python = python;
    this.options = {
      spawn,
      readRss: processRss,
      maxQueue: 32,
      maxCacheBytes: 64 * MIB,
      maxInputBytes: 128 * MIB,
      maxRssBytes: 768 * MIB,
      maxTileResponseBytes: 16 * MIB,
      maxResponseBytes: 64 * MIB,
      rssIntervalMs: 500,
      scriptDirectory: __dirname,
      tileTimeoutMs: 8000,
      geometryTimeoutMs: 15000,
      loadTimeoutMs: 120000,
      renderTimeoutMs: 120000,
      ...options,
    };
    this.memoryStats = {
      peakRssBytes: null,
      samples: 0,
      source: 'unavailable',
      monitor: 'unavailable',
    };
    this.externalMonitorStatus = 'pending';
    this.sequence = 0;
    this.queue = [];
    this.generations = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
    this.loaded = null;
    this.active = null;
    this.worker = null;
    this.closed = false;
  }

  setGeneration(token, generation) {
    if (typeof token !== 'string' || !Number.isSafeInteger(generation) || generation < 0)
      throw Error('Invalid layout generation.');
    if (token !== this.currentToken) throw Error('Layout selection changed; reopen this artifact.');
    const previous = this.generations.get(token);
    if (previous !== undefined && generation < previous) throw Error(STALE);
    this.generations.set(token, generation);
    const obsolete = task =>
      task.request.op === 'tile' &&
      task.request.token === token &&
      task.request.generation < generation;
    this.queue = this.queue.filter(task => {
      if (!obsolete(task)) return true;
      this.settle(task, Error(STALE));
      return false;
    });
    if (this.active && obsolete(this.active)) this.settle(this.active, Error(STALE));
  }

  settle(task, error, result) {
    if (task.settled) return;
    task.settled = true;
    error ? task.reject(error) : task.resolve(result);
  }

  cacheKey(request) {
    return JSON.stringify([
      'layout-tile-v1',
      request.token,
      this.loadedMetadata?.cell,
      this.loadedMetadata?.dbu,
      this.loadedMetadata?.klayout,
      request.layer,
      request.box,
      request.mode || 'auto',
      request.pixels || 256,
    ]);
  }

  cacheResult(key, result) {
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(result));
    if (bytes > this.options.maxCacheBytes) return;
    const previous = this.cache.get(key);
    if (previous) {
      this.cacheBytes -= previous.bytes;
      this.cache.delete(key);
    }
    while (this.cacheBytes + bytes > this.options.maxCacheBytes && this.cache.size) {
      const oldest = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(oldest).bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { result: structuredClone(result), bytes });
    this.cacheBytes += bytes;
  }

  call(request) {
    if (this.closed) return Promise.reject(Error('Renderer closed.'));
    try {
      request = structuredClone(request);
      if (request.op === 'tile') {
        this.setGeneration(request.token, request.generation);
      }
      if (request.op === 'load') {
        this.currentToken = request.token;
        this.loaded = null;
        this.loadedMetadata = null;
        this.generations.clear();
        this.cache.clear();
        this.cacheBytes = 0;
        for (const task of this.queue) this.settle(task, Error('Layout selection changed.'));
        this.queue = [];
        if (this.active) this.settle(this.active, Error('Layout selection changed.'));
        this.stopWorker(this.worker, Error('Layout selection changed.'));
      }
      if (this.queue.length >= this.options.maxQueue)
        throw Error('Layout request queue is full. Retry the current viewport.');
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject, settled: false });
      this.pump();
    });
  }

  async pump() {
    if (this.active || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    try {
      const request = task.request;
      if (request.op === 'load') {
        const stat = await fs.promises.stat(request.path);
        if (!stat.isFile() || stat.size > this.options.maxInputBytes)
          throw Error('Layout input exceeds the supported 128 MiB limit.');
      }
      if (task.settled || this.closed) return;
      if (request.op !== 'load' && request.token !== this.loaded?.token)
        throw Error('Layout selection changed; reopen this artifact.');
      const key = request.op === 'tile' ? this.cacheKey(request) : null;
      const cached = key && this.cache.get(key);
      if (cached) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        this.settle(task, null, {
          ...structuredClone(cached.result),
          generation: request.generation,
          cacheHit: true,
        });
        return;
      }
      const worker = this.start();
      if (!worker.loaded && request.op !== 'load') {
        await this.send(worker, this.loaded);
        worker.loaded = true;
      }
      if (task.settled || this.closed) return;
      const result = await this.send(worker, request);
      if (task.settled) return;
      if (request.op === 'load') {
        this.loaded = request;
        this.loadedMetadata = result;
        worker.loaded = true;
      }
      if (key && result.reason !== 'worker-timeout') this.cacheResult(key, result);
      this.settle(task, null, result);
    } catch (error) {
      this.settle(task, error);
    } finally {
      this.active = null;
      this.pump();
    }
  }

  start() {
    if (this.worker) return this.worker;
    this.externalMonitorStatus = 'pending';
    // Ignore Python startup overrides and user packages, while retaining this
    // trusted script directory for its adjacent layout_themes module.
    const script = resolveLayoutScript(this.options.scriptDirectory);
    const child = this.options.spawn(
      this.python,
      ['-B', '-E', '-s', '-u', script, '--max-rss-bytes', String(this.options.maxRssBytes)],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const worker = {
      child,
      loaded: false,
      pending: null,
      buffer: '',
      bytes: 0,
      closed: false,
      stderr: Buffer.alloc(0),
    };
    this.worker = worker;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.receive(worker, chunk));
    child.stderr.on('data', chunk => {
      worker.stderr = Buffer.concat([worker.stderr, chunk.subarray(-STDERR_BYTES)]).subarray(
        -STDERR_BYTES,
      );
    });
    child.on('error', error =>
      this.stopWorker(worker, Error(`KLayout renderer could not start: ${error.message}`)),
    );
    // close follows stdio drain; exit alone can lose the diagnostic we need.
    child.on('close', (code, signal) => {
      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = worker.stderr.toString('utf8').trim();
      this.stopWorker(
        worker,
        Error(
          `KLayout renderer stopped. Retry the viewport. (${status})` +
            (detail ? `\n${detail}` : ''),
        ),
      );
    });
    child.stdin.on('error', error => {
      // An exiting interpreter can close stdin before stderr has drained.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED')
        this.stopWorker(worker, error);
    });
    if (this.options.rssIntervalMs > 0) {
      worker.rssTimer = setInterval(async () => {
        if (worker.closed || worker.readingRss || !child.pid) return;
        worker.readingRss = true;
        try {
          const rss = await this.options.readRss(child.pid);
          if (!Number.isFinite(rss) || rss <= 0) throw Error('No valid RSS measurement.');
          if (worker.closed) return;
          this.externalMonitorStatus = 'available';
          this.observeMemory(rss, 'os-process');
          if (!worker.closed && rss > this.options.maxRssBytes)
            this.stopWorker(
              worker,
              Error('KLayout worker exceeded its memory budget. Retry a smaller viewport.'),
            );
        } catch (error) {
          if (!worker.closed) {
            clearInterval(worker.rssTimer);
            this.externalMonitorStatus = 'unavailable';
            this.externalMonitorReason = error.message;
            if (worker.resource?.monitor === 'self-rss') {
              this.memoryStats.source = 'self-rss';
              this.memoryStats.monitor = 'self-rss';
            } else if (
              worker.pending?.request.op === 'tile' &&
              worker.resource?.monitor === 'unavailable'
            ) {
              this.stopWorker(worker, Error(NO_MONITOR));
            }
          }
        } finally {
          worker.readingRss = false;
        }
      }, this.options.rssIntervalMs);
      worker.rssTimer.unref?.();
    }
    return worker;
  }

  observeMemory(bytes, source) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.memoryStats.peakRssBytes = Math.max(this.memoryStats.peakRssBytes ?? 0, bytes);
    this.memoryStats.samples += 1;
    this.memoryStats.source = source;
    this.memoryStats.monitor = source;
  }

  receive(worker, chunk) {
    if (worker.closed || this.worker !== worker) return;
    worker.buffer += chunk;
    worker.bytes += Buffer.byteLength(chunk);
    const limit =
      worker.pending?.request.op === 'tile'
        ? this.options.maxTileResponseBytes
        : this.options.maxResponseBytes;
    while (worker.buffer.includes('\n')) {
      const end = worker.buffer.indexOf('\n');
      const line = worker.buffer.slice(0, end);
      worker.buffer = worker.buffer.slice(end + 1);
      worker.bytes = Buffer.byteLength(worker.buffer);
      if (Buffer.byteLength(line) + (worker.pending?.previewBytes || 0) > limit)
        return this.stopWorker(worker, Error('KLayout response exceeded the display budget.'));
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.stopWorker(worker, Error('Invalid KLayout response.'));
      }
      const pending = worker.pending;
      if (!pending || message.id !== pending.id) continue;
      if (message.error && message.fatal) return this.stopWorker(worker, Error(message.error));
      const resource = (message.preview || message.result)?.resource || message.resource;
      if (resource) {
        worker.resource = resource;
        if (resource.monitor === 'self-rss')
          this.observeMemory(
            resource.peakRssBytes,
            this.externalMonitorStatus === 'available' ? 'os-process' : 'self-rss',
          );
      }
      if (message.preview) {
        if (pending.request.op !== 'tile' || message.preview.mode !== 'overview')
          return this.stopWorker(worker, Error('Invalid KLayout tile preview.'));
        pending.preview = message.preview;
        pending.previewBytes = Buffer.byteLength(JSON.stringify(message.preview));
        continue;
      }
      clearTimeout(pending.timer);
      worker.pending = null;
      message.error ? pending.reject(Error(message.error)) : pending.resolve(message.result);
    }
    if (worker.bytes + (worker.pending?.previewBytes || 0) > limit)
      this.stopWorker(worker, Error('KLayout response exceeded the display budget.'));
  }

  send(worker, request) {
    return new Promise((resolve, reject) => {
      if (worker.closed || this.worker !== worker) return reject(Error('KLayout worker changed.'));
      if (
        request.op === 'tile' &&
        worker.resource?.monitor === 'unavailable' &&
        this.externalMonitorStatus !== 'available'
      )
        return reject(Error(NO_MONITOR));
      const id = ++this.sequence;
      const timeout =
        request.op === 'tile'
          ? this.options.tileTimeoutMs
          : request.op === 'geometry'
            ? this.options.geometryTimeoutMs
            : request.op === 'load'
              ? this.options.loadTimeoutMs
              : this.options.renderTimeoutMs;
      const pending = { id, request, resolve, reject };
      pending.timer = setTimeout(() => {
        const preview = pending.preview;
        if (preview) {
          worker.pending = null;
          resolve({ ...preview, mode: 'overview', reason: 'worker-timeout' });
        }
        this.stopWorker(worker, Error('KLayout render timed out. Retry the viewport.'));
      }, timeout);
      worker.pending = pending;
      try {
        worker.child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
      } catch (error) {
        this.stopWorker(worker, error);
      }
    });
  }

  stopWorker(worker, error) {
    if (!worker || worker.closed) return;
    worker.closed = true;
    clearInterval(worker.rssTimer);
    if (worker.pending) {
      clearTimeout(worker.pending.timer);
      worker.pending.reject(error);
      worker.pending = null;
    }
    worker.buffer = '';
    worker.bytes = 0;
    if (this.worker === worker) this.worker = null;
    this.lastError = error.message;
    worker.child.kill('SIGKILL');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failure = 'Renderer closed.';
    const error = Error(this.failure);
    for (const task of this.queue) this.settle(task, error);
    this.queue = [];
    if (this.active) this.settle(this.active, error);
    this.stopWorker(this.worker, error);
    this.loaded = null;
    this.loadedMetadata = null;
    this.currentToken = null;
    this.cache.clear();
    this.cacheBytes = 0;
    this.generations.clear();
  }
}
module.exports = { RasterService, resolveLayoutScript };
