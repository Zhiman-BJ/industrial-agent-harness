const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { availableSpace, footprint, checkSpace } = require('./install-space.cjs');

const DEFAULT_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  timeoutMs: 120000,
  stallMs: 60000,
});
const CATALOG_FILES = 10000;
const CATALOG_FILE_BYTES = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function hasControl(value, includeSpace = false) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= (includeSpace ? 32 : 31) || code === 127) return true;
  }
  return false;
}

function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    /[\\:%?#]/.test(value) ||
    hasControl(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..') ||
    path.posix.normalize(value) !== value
  )
    throw Error('Unsafe data library path.');
  return value;
}

function httpsUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !value.startsWith('https://') ||
    /[\\?#]/.test(value) ||
    hasControl(value, true)
  )
    throw Error('Data library downloads require a plain HTTPS URL.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Invalid data library URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw Error('Data library URLs cannot contain credentials, query strings, or fragments.');
  return url;
}

function selectedLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid data library limits.');
  const result = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(input)) {
    if (
      !Object.hasOwn(DEFAULT_LIMITS, name) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_LIMITS[name]
    )
      throw Error('Data library limits may only reduce the default budget.');
    result[name] = value;
  }
  return result;
}

function validateDataLibrary(library) {
  if (!library || !ID.test(library.id || '') || !VERSION.test(library.version || ''))
    throw Error('Invalid data library declaration.');
  const base = httpsUrl(library.baseUrl);
  if (!base.pathname.endsWith('/') || library.baseUrl.includes('%'))
    throw Error('Data library base URL must be a plain HTTPS directory.');
  return library;
}

function planDataLibrary(library, catalog, requestedPaths, options = {}) {
  validateDataLibrary(library);
  if (
    !library ||
    !ID.test(library.id || '') ||
    !VERSION.test(library.version || '') ||
    catalog?.schemaVersion !== 1 ||
    catalog.id !== library.id ||
    catalog.version !== library.version ||
    !Array.isArray(catalog.files) ||
    catalog.files.length > CATALOG_FILES
  )
    throw Error('Invalid or mismatching data library catalog.');
  const base = httpsUrl(library.baseUrl);
  const source = httpsUrl(catalog.baseUrl);
  if (base.href !== source.href || !base.pathname.endsWith('/') || base.pathname.includes('%'))
    throw Error('Data library catalog does not match its declared base URL.');
  const byPath = new Map();
  const byHash = new Map();
  for (const entry of catalog.files) {
    safeRelative(entry?.path);
    if (
      !SHA.test(entry.sha256 || '') ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > CATALOG_FILE_BYTES ||
      byPath.has(entry.path) ||
      (byHash.has(entry.sha256) && byHash.get(entry.sha256) !== entry.size)
    )
      throw Error('Invalid or duplicate data library file declaration.');
    byHash.set(entry.sha256, entry.size);
    byPath.set(entry.path, { path: entry.path, size: entry.size, sha256: entry.sha256 });
  }
  if (!Array.isArray(requestedPaths) || requestedPaths.length > CATALOG_FILES)
    throw Error('Invalid data library resource selection.');
  const limits = selectedLimits(options.limits);
  const paths = [...new Set(requestedPaths.map(safeRelative))];
  if (paths.length > limits.files)
    throw Error('Data library request exceeds the file count limit.');
  const files = [];
  const hashes = new Set();
  let totalBytes = 0;
  for (const relative of paths) {
    const entry = byPath.get(relative);
    if (!entry) throw Error('Requested resource is not in the installed data library catalog.');
    if (entry.size > limits.fileBytes)
      throw Error('Data library request exceeds the per-file size limit.');
    if (!hashes.has(entry.sha256)) {
      hashes.add(entry.sha256);
      totalBytes += entry.size;
    }
    if (totalBytes > limits.totalBytes)
      throw Error('Data library request exceeds the total size limit.');
    files.push(entry);
  }
  return {
    libraryId: library.id,
    version: library.version,
    baseUrl: base.href,
    files,
    stats: { requestedFiles: files.length, uniqueFiles: hashes.size, totalBytes },
  };
}

function validateDataCatalog(catalog, library) {
  planDataLibrary(library, catalog, []);
  return catalog;
}

function abortable(promise, signal, late) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          late?.(value);
          reject(signal.reason);
        } else resolve(value);
      },
      error => {
        signal?.removeEventListener('abort', abort);
        reject(signal?.aborted ? signal.reason : error);
      },
    );
  });
}

function discard(body) {
  try {
    Promise.resolve(body?.cancel()).catch(() => {});
  } catch {}
}

// Resolve the existing parent once without creating missing cache directories.
// Normal platform aliases such as /tmp -> /private/tmp remain usable, while a
// supplied cache directory itself may never be a link.
function canonicalDestination(directory) {
  let existing = directory;
  const suffix = [];
  for (;;) {
    try {
      const stat = fs.lstatSync(existing);
      if (existing === directory && stat.isSymbolicLink())
        throw Error('Data library cache cannot be a symbolic link.');
      if (!fs.statSync(existing).isDirectory())
        throw Error('Invalid data library cache directory.');
      return path.join(fs.realpathSync(existing), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

class DataLibraryManager {
  constructor({ directory, fetch: request = globalThis.fetch, space = availableSpace } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory))
      throw Error('Data library cache requires an absolute directory.');
    if (typeof request !== 'function' || typeof space !== 'function')
      throw Error('Invalid data library transfer dependencies.');
    this.directory = canonicalDestination(path.resolve(directory));
    this.fetch = request;
    this.space = space;
    // Serial admission also deduplicates simultaneous requests on this manager:
    // a later request validates the completed content-addressed cache afresh.
    this.queue = Promise.resolve();
    this.assertRoot(true);
  }
  assertRoot(allowMissing = false) {
    let existing = this.directory;
    for (;;) {
      try {
        const stat = fs.lstatSync(existing);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(existing) !== existing)
          throw Error('Data library cache directory changed or is unsafe.');
        if (existing !== this.directory && !allowMissing)
          throw Error('Data library cache directory is unavailable.');
        return existing === this.directory;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
  }
  createRoot() {
    if (this.assertRoot(true)) return;
    const missing = [];
    let existing = this.directory;
    while (!fs.existsSync(existing)) {
      missing.unshift(existing);
      existing = path.dirname(existing);
    }
    for (const directory of missing) {
      if (
        fs.lstatSync(path.dirname(directory)).isSymbolicLink() ||
        fs.realpathSync(path.dirname(directory)) !== path.dirname(directory)
      )
        throw Error('Data library cache parent directory is unsafe.');
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
        throw Error('Data library cache directory changed or is unsafe.');
    }
    this.assertRoot();
  }
  plan(library, catalog, requestedPaths, options) {
    return planDataLibrary(library, catalog, requestedPaths, options);
  }
  cached(entry) {
    if (!this.assertRoot(true)) return { reason: 'missing' };
    const file = path.join(this.directory, entry.sha256);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { reason: 'missing' };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file)
      throw Error('Unsafe data library cache entry.');
    if (stat.size !== entry.size) return { reason: 'integrity' };
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== entry.size || before.ino !== stat.ino)
        return { reason: 'integrity' };
      const digest = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(65536, entry.size));
      let offset = 0;
      while (offset < entry.size) {
        const read = fs.readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, entry.size - offset),
          offset,
        );
        if (!read) return { reason: 'integrity' };
        digest.update(buffer.subarray(0, read));
        offset += read;
      }
      const after = fs.fstatSync(fd);
      this.assertRoot();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        fs.lstatSync(file).isSymbolicLink() ||
        fs.realpathSync(file) !== file ||
        digest.digest('hex') !== entry.sha256
      )
        return { reason: 'integrity' };
      return { file };
    } finally {
      fs.closeSync(fd);
    }
  }
  resolve(library, catalog, requestedPaths, options = {}) {
    const plan = this.plan(library, catalog, requestedPaths, options);
    const files = [];
    const missing = [];
    const checked = new Map();
    const needed = new Map();
    for (const entry of plan.files) {
      if (!checked.has(entry.sha256)) checked.set(entry.sha256, this.cached(entry));
      const current = checked.get(entry.sha256);
      if (current.file) files.push({ ...entry, file: current.file, cached: true });
      else {
        missing.push({ path: entry.path, reason: current.reason });
        needed.set(entry.sha256, entry.size);
      }
    }
    return {
      libraryId: plan.libraryId,
      version: plan.version,
      files,
      missingPaths: missing.map(entry => entry.path),
      missing,
      stats: {
        ...plan.stats,
        cachedFiles: files.length,
        missingFiles: missing.length,
        downloadBytes: [...needed.values()].reduce((sum, size) => sum + size, 0),
      },
    };
  }
  async ensure(library, catalog, requestedPaths, options = {}) {
    const plan = this.plan(library, catalog, requestedPaths, options);
    const limits = selectedLimits(options.limits);
    options.signal?.throwIfAborted();
    const previous = this.queue;
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    this.queue = previous.then(() => gate);
    try {
      await abortable(previous, options.signal);
      options.signal?.throwIfAborted();
      return await this.download(plan, limits, options);
    } finally {
      // A cancelled queued caller returns promptly while later callers still
      // wait for the operation that preceded its admission ticket.
      previous.then(release, release);
    }
  }
  async download(plan, limits, { signal, onProgress, offline = false }) {
    const files = [];
    const wanted = new Map();
    const cached = new Map();
    for (const entry of plan.files) {
      if (!cached.has(entry.sha256)) cached.set(entry.sha256, this.cached(entry));
      if (!cached.get(entry.sha256).file && !wanted.has(entry.sha256))
        wanted.set(entry.sha256, entry);
    }
    const downloadBytes = [...wanted.values()].reduce((sum, entry) => sum + entry.size, 0);
    const stats = {
      ...plan.stats,
      cachedFiles: plan.files.filter(entry => cached.get(entry.sha256).file).length,
      downloadedFiles: 0,
      downloadedBytes: 0,
      missingFiles: wanted.size,
      downloadBytes,
    };
    if (offline && wanted.size) {
      const error = Error('Requested data library resources are not cached for offline use.');
      error.code = 'DATA_LIBRARY_OFFLINE';
      throw error;
    }
    if (wanted.size) {
      checkSpace(this.directory, footprint(0, downloadBytes), this.space);
      this.createRoot();
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(
      () => controller.abort(Error('Data library download timed out.')),
      limits.timeoutMs,
    );
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => controller.abort(Error('Data library download stalled.')),
        limits.stallMs,
      );
    };
    const report = (phase, relative, received = 0) =>
      onProgress?.({
        libraryId: plan.libraryId,
        version: plan.version,
        phase,
        ...(relative ? { path: relative } : {}),
        completedFiles: stats.downloadedFiles,
        totalFiles: wanted.size,
        downloadedBytes: stats.downloadedBytes + received,
        totalBytes: downloadBytes,
      });
    try {
      combined.throwIfAborted();
      report('checking-cache');
      for (const entry of wanted.values()) {
        combined.throwIfAborted();
        touch();
        await this.downloadFile(plan, entry, {
          signal: combined,
          touch,
          report: received => report('downloading', entry.path, received),
        });
        stats.downloadedFiles++;
        stats.downloadedBytes += entry.size;
        report('verified', entry.path);
      }
      combined.throwIfAborted();
      for (const entry of plan.files) {
        const current = this.cached(entry);
        if (!current.file) throw Error('Data library cache changed; retry the request.');
        files.push({
          ...entry,
          file: current.file,
          cached: Boolean(cached.get(entry.sha256).file),
        });
      }
      report('complete');
      return {
        libraryId: plan.libraryId,
        version: plan.version,
        files,
        missingPaths: [],
        missing: [],
        stats: { ...stats, missingFiles: 0 },
      };
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(idle);
    }
  }
  async response(baseUrl, relative, { signal, touch }) {
    const base = httpsUrl(baseUrl);
    let url = new URL(relative.split('/').map(encodeURIComponent).join('/'), base);
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
        throw Error('Data library redirect is outside its declared origin or directory.');
      const response = await abortable(
        this.fetch(url.href, {
          redirect: 'manual',
          signal,
          credentials: 'omit',
          headers: { Accept: 'application/octet-stream' },
        }),
        signal,
        value => discard(value.body),
      );
      touch();
      if (response.redirected) {
        discard(response.body);
        throw Error('Data library redirect bypassed validation.');
      }
      if (!REDIRECTS.has(response.status)) {
        if (!response.ok || !response.body) {
          discard(response.body);
          throw Error(`Data library download failed: HTTP ${response.status}.`);
        }
        if (response.url) {
          const final = httpsUrl(response.url);
          if (final.href !== url.href) {
            discard(response.body);
            throw Error('Data library response does not match its checked URL.');
          }
        }
        return response;
      }
      discard(response.body);
      const location = response.headers.get('Location');
      if (redirects === 5 || !location)
        throw Error('Data library download has too many redirects.');
      if (location.includes('\\') || hasControl(location, true))
        throw Error('Invalid data library redirect.');
      url = httpsUrl(new URL(location, url).href);
    }
  }
  async downloadFile(plan, entry, transfer) {
    this.assertRoot();
    const temporary = path.join(this.directory, '.data-' + crypto.randomUUID() + '.partial');
    const destination = path.join(this.directory, entry.sha256);
    let fd;
    let reader;
    let published = false;
    const cancel = () => {
      discard(reader);
    };
    transfer.signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.response(plan.baseUrl, entry.path, transfer);
      if (Number(response.headers.get('Content-Length')) > entry.size) {
        discard(response.body);
        throw Error('Data library response exceeds its declared size.');
      }
      if (!response.body.getReader) throw Error('Data library response has no readable stream.');
      this.assertRoot();
      fd = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      reader = response.body.getReader();
      const digest = crypto.createHash('sha256');
      let received = 0;
      for (;;) {
        transfer.signal.throwIfAborted();
        const chunk = await abortable(reader.read(), transfer.signal);
        transfer.signal.throwIfAborted();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          throw Error('Data library response contains invalid bytes.');
        received += chunk.value.byteLength;
        if (received > entry.size) throw Error('Data library response exceeds its declared size.');
        transfer.touch();
        digest.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.length) {
          const written = fs.writeSync(fd, chunk.value, offset, chunk.value.length - offset);
          if (!written) throw Error('Data library cache write failed.');
          offset += written;
        }
        transfer.report(received);
      }
      if (received !== entry.size || digest.digest('hex') !== entry.sha256)
        throw Error('Data library integrity check failed.');
      transfer.signal.throwIfAborted();
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      this.assertRoot();
      // Check the destination again after the transfer. Never follow or replace
      // an unexpected link or special file introduced during a download.
      this.cached(entry);
      fs.renameSync(temporary, destination);
      published = true;
    } finally {
      transfer.signal.removeEventListener('abort', cancel);
      if (reader) {
        discard(reader);
        try {
          reader.releaseLock();
        } catch {}
      }
      if (fd !== undefined) fs.closeSync(fd);
      if (!published) {
        try {
          this.assertRoot();
          fs.rmSync(temporary, { force: true });
        } catch {}
      }
    }
  }
}

module.exports = {
  DataLibraryManager,
  planDataLibrary,
  validateDataLibrary,
  validateDataCatalog,
  DEFAULT_DATA_LIBRARY_LIMITS: DEFAULT_LIMITS,
};
