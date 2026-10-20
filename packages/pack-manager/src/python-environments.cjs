const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const tar = require('tar');
const { run } = require('./runtime-assets.cjs');
const { Transfer, TransferProgress } = require('./transfer.cjs');
const { availableSpace, footprint, checkSpace } = require('./install-space.cjs');

const FILE_BYTES = 128 * 1024 ** 2;
const TOTAL_BYTES = 512 * 1024 ** 2;
const TREE_BYTES = 2 * 1024 ** 3;
const TREE_FILES = 100000;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function unsafeText(value) {
  return [...value].some(
    character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
  );
}
function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    /[\\:%]/.test(value) ||
    unsafeText(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..') ||
    path.posix.normalize(value) !== value
  )
    throw Error('Unsafe Python runtime path.');
  return value;
}
function https(value, redirect = false) {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\\') || unsafeText(value))
    throw Error('Python runtime downloads require HTTPS.');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (!redirect && url.search)
  )
    throw Error('Python runtime URL is not a plain HTTPS URL.');
  return url;
}
function validateFile(file) {
  if (
    !file ||
    !SHA.test(file.sha256 || '') ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > FILE_BYTES
  )
    throw Error('Invalid Python runtime download declaration.');
  https(file.url);
}
function validatePythonEnvironments(assets = []) {
  if (!Array.isArray(assets) || assets.length > 8) throw Error('Invalid Python environments.');
  const ids = new Set(),
    variables = new Set();
  for (const asset of assets) {
    if (
      !ID.test(asset?.id || '') ||
      ids.has(asset.id) ||
      !VERSION.test(asset.version || '') ||
      typeof asset.label !== 'string' ||
      !asset.label ||
      asset.label.length > 200 ||
      asset.purpose !== 'viewer' ||
      !ID.test(asset.viewer || '') ||
      !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(asset.environment || '') ||
      variables.has(asset.environment) ||
      !/^3\.[0-9]{1,2}\.[0-9]{1,3}$/.test(asset.pythonVersion || '') ||
      !Array.isArray(asset.modules) ||
      !asset.modules.length ||
      asset.modules.length > 16 ||
      new Set(asset.modules).size !== asset.modules.length ||
      asset.modules.some(
        name => typeof name !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name),
      ) ||
      (asset.probe != null &&
        (typeof asset.probe !== 'string' ||
          !asset.probe ||
          Buffer.byteLength(asset.probe) > 16384)) ||
      !asset.platforms ||
      typeof asset.platforms !== 'object' ||
      Array.isArray(asset.platforms) ||
      !Object.keys(asset.platforms).length ||
      Object.keys(asset.platforms).length > 6
    )
      throw Error('Invalid managed Python environment declaration.');
    ids.add(asset.id);
    variables.add(asset.environment);
    for (const [platform, target] of Object.entries(asset.platforms)) {
      if (
        !/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(platform) ||
        !target ||
        !Number.isSafeInteger(target.installedSize) ||
        target.installedSize < 1 ||
        target.installedSize > TREE_BYTES ||
        target.interpreter?.format !== 'tar.gz' ||
        !Array.isArray(target.wheels) ||
        !target.wheels.length ||
        target.wheels.length > 16
      )
        throw Error('Invalid Python environment platform declaration.');
      validateFile(target.interpreter);
      safeRelative(target.interpreter.executable);
      const names = new Set(),
        filenames = new Set();
      for (const wheel of target.wheels) {
        validateFile(wheel);
        const name = wheel.name?.toLowerCase().replace(/[-_.]+/g, '-');
        if (
          !/^[a-z0-9][a-z0-9.-]*$/.test(name || '') ||
          names.has(name) ||
          !VERSION.test(wheel.version || '') ||
          !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*\.whl$/.test(wheel.filename || '') ||
          filenames.has(wheel.filename)
        )
          throw Error('Invalid or duplicate Python wheel declaration.');
        names.add(name);
        filenames.add(wheel.filename);
      }
    }
  }
  return assets;
}
function canonicalDestination(directory) {
  let existing = path.resolve(directory);
  const suffix = [];
  for (;;) {
    const stat = fs.lstatSync(existing, { throwIfNoEntry: false });
    if (stat) {
      if ((suffix.length === 0 && stat.isSymbolicLink()) || !fs.statSync(existing).isDirectory())
        throw Error('Python environment store must be a directory, not a link.');
      return path.join(fs.realpathSync(existing), ...suffix);
    }
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) throw Error('Invalid Python environment store.');
    existing = parent;
  }
}
function ordinaryDirectory(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
    throw Error('Python environment directory changed or contains a link.');
}
function fileHash(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Error('Python runtime resource is not an ordinary file.');
    const digest = crypto.createHash('sha256'),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, count));
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function inside(root, file) {
  return file.startsWith(root + path.sep);
}
function inventory(directory, maxBytes, hashes) {
  ordinaryDirectory(directory);
  const entries = [];
  let bytes = 0,
    count = 0;
  const visit = relative => {
    const file = path.join(directory, ...relative.split('/'));
    const stat = fs.lstatSync(file);
    if (++count > TREE_FILES) throw Error('Python runtime contains too many files.');
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      if (path.isAbsolute(target) || !inside(directory, fs.realpathSync(file)))
        throw Error('Python runtime contains an escaping symbolic link.');
      entries.push({ path: relative, type: 'link', target });
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > maxBytes) throw Error('Python runtime exceeds its expanded size limit.');
      entries.push({
        path: relative,
        type: 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
        mode: stat.mode & 0o777,
        ...(hashes ? { sha256: fileHash(file) } : {}),
      });
    } else throw Error('Python runtime contains a special file.');
  };
  for (const name of fs.readdirSync(directory).sort()) if (name !== 'receipt.json') visit(name);
  return entries;
}
function verifyInventory(directory, receipt, maxBytes, hashes = false) {
  if (!Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > TREE_FILES)
    throw Error('Invalid Python runtime receipt.');
  const current = inventory(directory, maxBytes, hashes);
  if (current.length !== receipt.files.length) throw Error('Python runtime installation changed.');
  for (let i = 0; i < current.length; i++) {
    const actual = current[i],
      recorded = receipt.files[i];
    safeRelative(recorded?.path);
    if (
      actual.path !== recorded.path ||
      actual.type !== recorded.type ||
      (actual.type === 'link'
        ? actual.target !== recorded.target
        : !SHA.test(recorded.sha256 || '') ||
          actual.size !== recorded.size ||
          actual.mtime !== recorded.mtime ||
          actual.mode !== recorded.mode ||
          (hashes && actual.sha256 !== recorded.sha256))
    )
      throw Error('Python runtime installation changed.');
  }
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
    void Promise.resolve(body?.cancel()).catch(() => {});
  } catch {}
}
function cleanEnvironment(profile) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:PYTHON|PIP|UV|QT_|QML|DYLD_|LD_|VIRTUAL_ENV$|CONDA|__PYVENV_LAUNCHER__$)/i.test(key),
    ),
  );
  return {
    ...env,
    HOME: profile,
    USERPROFILE: profile,
    XDG_CACHE_HOME: profile,
    TMPDIR: profile,
    TEMP: profile,
    TMP: profile,
    PIP_CONFIG_FILE: os.devNull,
    QT_QPA_PLATFORM: 'offscreen',
  };
}

class PythonEnvironmentManager {
  constructor({
    directory,
    platform = `${process.platform}-${process.arch}`,
    fetch: fetcher = (...args) => global.fetch(...args),
    command = run,
    space = availableSpace,
  } = {}) {
    if (!directory) throw Error('Python environment store is required.');
    this.directory = canonicalDestination(directory);
    this.platform = platform;
    this.fetch = fetcher;
    this.command = command;
    this.space = space;
  }
  selected(assets) {
    validatePythonEnvironments(assets);
    let total = 0;
    const hashes = new Map();
    for (const asset of assets)
      for (const file of this.files(asset)) {
        if (hashes.has(file.sha256) && hashes.get(file.sha256) !== file.size)
          throw Error('Conflicting Python runtime content sizes.');
        if (!hashes.has(file.sha256)) {
          hashes.set(file.sha256, file.size);
          total += file.size;
        }
      }
    if (total > TOTAL_BYTES)
      throw Error('Python environment downloads exceed the total size limit.');
    return assets;
  }
  files(asset) {
    const target = asset.platforms[this.platform];
    return target ? [target.interpreter, ...target.wheels] : [];
  }
  identity(asset) {
    return hash(Buffer.from(stable({ asset, platform: this.platform })));
  }
  location(asset) {
    return path.join(this.directory, 'environments', asset.id, this.identity(asset));
  }
  guard(file = this.directory) {
    ordinaryDirectory(this.directory);
    const relative = path.relative(this.directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('Python runtime escaped its store.');
    let current = this.directory;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) break;
      if (stat.isSymbolicLink()) throw Error('Python environment store contains a link.');
    }
  }
  cache(file) {
    return path.join(this.directory, 'downloads', file.sha256);
  }
  cached(file) {
    try {
      this.guard(this.cache(file));
      const stat = fs.lstatSync(this.cache(file));
      return stat.isFile() && stat.size === file.size && fileHash(this.cache(file)) === file.sha256;
    } catch {
      return false;
    }
  }
  receipt(asset, hashes = false) {
    const target = asset.platforms[this.platform];
    if (!target) throw Error('Python environment does not support this platform.');
    const directory = this.location(asset);
    this.guard(directory);
    if (fs.lstatSync(path.join(directory, '.needs-repair'), { throwIfNoEntry: false }))
      throw Error('Python environment needs repair after a failed readiness check.');
    const file = path.join(directory, 'receipt.json');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    let receipt;
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 32 * 1024 ** 2)
        throw Error('Invalid Python runtime receipt.');
      receipt = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
    if (
      receipt.schemaVersion !== 1 ||
      receipt.declarationHash !== this.identity(asset) ||
      receipt.pythonVersion !== asset.pythonVersion ||
      !receipt.checkedAt
    )
      throw Error('Python runtime receipt does not match its declaration.');
    verifyInventory(directory, receipt, target.installedSize, hashes);
    const executable = path.join(directory, ...target.interpreter.executable.split('/'));
    if (
      !inside(directory, fs.realpathSync(executable)) ||
      !fs.statSync(executable).isFile() ||
      !SHA.test(receipt.executableSha256 || '') ||
      fileHash(fs.realpathSync(executable)) !== receipt.executableSha256
    )
      throw Error('Python interpreter changed.');
    return { receipt, executable };
  }
  status(assets = []) {
    this.selected(assets);
    return assets.map(asset => {
      const view = {
        id: asset.id,
        label: asset.label,
        version: asset.version,
        purpose: asset.purpose,
        viewer: asset.viewer,
        environment: asset.environment,
      };
      try {
        const { receipt, executable } = this.receipt(asset);
        return { ...view, ready: true, executable, checkedAt: receipt.checkedAt };
      } catch (error) {
        const reason =
          error.code === 'ENOENT' ? 'Python environment needs preparation.' : error.message;
        return { ...view, ready: false, message: reason, reason };
      }
    });
  }
  environment(assets = []) {
    return Object.fromEntries(
      this.status(assets)
        .filter(item => item.ready)
        .map(item => [item.environment, item.executable]),
    );
  }
  resolve(assets = [], viewer) {
    this.selected(assets);
    const ready = [];
    for (const asset of assets.filter(item => item.viewer === viewer)) {
      try {
        // Opening a Viewer must freshly validate every installed resource,
        // including nested native modules. Render-time reuse belongs to the
        // desktop service that owns the already-open worker's lifetime.
        ready.push(this.receipt(asset, true));
      } catch {}
    }
    if (ready.length > 1) throw Error('Multiple Python environments match this Viewer.');
    return ready[0]?.executable;
  }
  estimate(assets = []) {
    this.selected(assets);
    const statuses = this.status(assets),
      hashes = new Set();
    let downloadBytes = 0,
      installedBytes = 0,
      cacheReused = false;
    for (let i = 0; i < assets.length; i++) {
      if (statuses[i].ready) {
        cacheReused = true;
        continue;
      }
      const target = assets[i].platforms[this.platform];
      if (!target) continue;
      installedBytes += target.installedSize;
      for (const file of this.files(assets[i]))
        if (!hashes.has(file.sha256)) {
          hashes.add(file.sha256);
          if (this.cached(file)) cacheReused = true;
          else downloadBytes += file.size;
        }
    }
    return footprint(downloadBytes, installedBytes, { estimated: false, cacheReused });
  }
  lock() {
    this.guard();
    const file = path.join(this.directory, 'prepare.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(
          file,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
        } catch (error) {
          fs.closeSync(fd);
          fs.rmSync(file, { force: true });
          throw error;
        }
        return () => {
          fs.closeSync(fd);
          this.guard(file);
          fs.rmSync(file, { force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        this.guard(file);
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1)
          throw Error('Python preparation lock is invalid.', { cause: error });
        try {
          process.kill(owner.pid, 0);
        } catch (probe) {
          if (probe.code === 'ESRCH') {
            fs.rmSync(file);
            continue;
          }
        }
        throw Error('Python environment preparation is already in progress.', { cause: error });
      }
    }
    throw Error('Python environment preparation is already in progress.');
  }
  async download(file, options) {
    const destination = this.cache(file);
    if (this.cached(file)) return destination;
    this.guard(path.dirname(destination));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    this.guard(destination);
    if (fs.existsSync(destination)) fs.rmSync(destination);
    const temporary = `${destination}.${crypto.randomUUID()}.partial`;
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    try {
      await new Transfer(options).run(async transfer => {
        let current = https(file.url),
          response;
        const initial = current;
        for (let redirect = 0; redirect <= 5; redirect++) {
          transfer.signal.throwIfAborted();
          response = await abortable(
            this.fetch(current.href, { redirect: 'manual', signal: transfer.signal }),
            transfer.signal,
            late => discard(late.body),
          );
          transfer.touch();
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          discard(response.body);
          const location = response.headers.get('location');
          if (redirect === 5 || !location)
            throw Error('Python runtime download has too many redirects.');
          current = https(new URL(location, current).href, true);
          if (
            current.origin !== initial.origin &&
            !(
              initial.hostname === 'github.com' &&
              [
                'release-assets.githubusercontent.com',
                'objects.githubusercontent.com',
                'github-releases.githubusercontent.com',
              ].includes(current.hostname)
            )
          )
            throw Error('Python runtime redirect changed its trusted origin.');
        }
        if (!response.ok || !response.body) {
          discard(response.body);
          throw Error(`Python runtime download failed: HTTP ${response.status}`);
        }
        const length = response.headers.get('content-length');
        if (length != null && Number(length) !== file.size) {
          discard(response.body);
          throw Error('Python runtime download size mismatch.');
        }
        const digest = crypto.createHash('sha256'),
          reader = response.body.getReader();
        const progress = new TransferProgress(file.size);
        let size = 0;
        options.onProgress?.(progress.update(0));
        try {
          for (;;) {
            const item = await abortable(reader.read(), transfer.signal);
            if (item.done) break;
            transfer.touch();
            size += item.value.byteLength;
            if (size > file.size || size > FILE_BYTES)
              throw Error('Python runtime download exceeds its size limit.');
            digest.update(item.value);
            fs.writeSync(fd, item.value);
            options.onProgress?.(progress.update(size));
          }
          if (size !== file.size || digest.digest('hex') !== file.sha256)
            throw Error('Python runtime download size or SHA-256 mismatch.');
        } finally {
          try {
            void Promise.resolve(reader.cancel()).catch(() => {});
          } catch {}
        }
      });
      fs.fsyncSync(fd);
      this.guard(destination);
      fs.renameSync(temporary, destination);
      return destination;
    } finally {
      fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
  async extract(archive, directory, target, signal) {
    const entries = new Map();
    let expanded = 0;
    const inspect = entry => {
      const relative = safeRelative(entry.path.replace(/\/$/, ''));
      if (['receipt.json', '.needs-repair', '.wheelhouse'].includes(relative.split('/')[0]))
        throw Error('Python archive contains a reserved installation path.');
      if (entries.size >= TREE_FILES || entries.has(relative))
        throw Error('Python archive has duplicate or too many entries.');
      if (!['File', 'OldFile', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type))
        throw Error('Python archive contains a special file.');
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        (entry.type !== 'Directory' && entry.size > target.installedSize)
      )
        throw Error('Invalid Python archive entry size.');
      expanded += entry.size;
      if (expanded > target.installedSize)
        throw Error('Python archive exceeds its expanded size limit.');
      let link;
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        if (
          typeof entry.linkpath !== 'string' ||
          !entry.linkpath ||
          path.posix.isAbsolute(entry.linkpath) ||
          /[\\:]/.test(entry.linkpath) ||
          unsafeText(entry.linkpath)
        )
          throw Error('Python archive contains an unsafe link.');
        link =
          entry.type === 'Link'
            ? safeRelative(entry.linkpath)
            : path.posix.normalize(path.posix.join(path.posix.dirname(relative), entry.linkpath));
        safeRelative(link);
      }
      entries.set(relative, { type: entry.type, link });
      entry.resume();
    };
    const bounded = () => {
      let size = 0;
      return new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          done(
            size > target.installedSize + TREE_FILES * 1024 + 1024 ** 2
              ? Error('Python archive expanded stream exceeds its limit.')
              : null,
            chunk,
          );
        },
      });
    };
    const read = async (parser, extracting = false) => {
      // node-tar's parser is a writable EventEmitter, not a Node Writable (it
      // has abort(), but no destroy()). Adapt it so pipeline can safely cancel
      // malformed archives without replacing their diagnostic with a TypeError.
      let finish, extractionError;
      const drained = new Promise(resolve => parser.once('end', resolve));
      const sink = new Writable({
        write(chunk, _encoding, done) {
          try {
            if (parser.write(chunk)) done();
            else parser.once('drain', done);
          } catch (error) {
            done(error);
          }
        },
        final(done) {
          finish = done;
          try {
            parser.end();
          } catch (error) {
            done(error);
          }
        },
        destroy(error, done) {
          if (error) {
            if (extracting) parser.end();
            else parser.abort(error);
          }
          done(error);
        },
      });
      parser.on('error', error => {
        if (extracting) extractionError ||= error;
        else sink.destroy(error);
      });
      parser.on('end', () => finish?.(extractionError));
      try {
        // Once extraction starts, finish the bounded, prevalidated local writes
        // before honouring cancellation. Removing staging while node-tar still
        // owns open files would race its asynchronous filesystem callbacks.
        await pipeline(fs.createReadStream(archive), zlib.createGunzip(), bounded(), sink, {
          signal: extracting ? undefined : signal,
        });
      } catch (error) {
        if (extracting) await drained;
        throw error;
      }
    };
    await read(tar.t({ strict: true, maxMetaEntrySize: 1024 ** 2, onReadEntry: inspect }));
    for (const [relative, entry] of entries) {
      let parent = path.posix.dirname(relative);
      while (parent !== '.') {
        if (entries.has(parent) && entries.get(parent).type !== 'Directory')
          throw Error('Python archive writes through a link or file.');
        parent = path.posix.dirname(parent);
      }
      if (
        entry.link &&
        (!entries.has(entry.link) ||
          (entry.type === 'Link' && !['File', 'OldFile'].includes(entries.get(entry.link).type)))
      )
        throw Error('Python archive link target is not an internal file.');
    }
    signal?.throwIfAborted();
    await read(
      tar.x({
        cwd: directory,
        strict: true,
        preservePaths: false,
        noMtime: true,
        noChmod: true,
        maxMetaEntrySize: 1024 ** 2,
      }),
      true,
    );
    signal?.throwIfAborted();
    // Tar validates paths and the post-walk verifies actual links before anything runs.
    inventory(directory, target.installedSize, false);
    const privateModes = file => {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        fs.chmodSync(file, 0o700);
        for (const name of fs.readdirSync(file)) privateModes(path.join(file, name));
      } else fs.chmodSync(file, stat.mode & 0o111 ? 0o700 : 0o600);
    };
    privateModes(directory);
  }
  async probe(asset, directory, options) {
    const target = asset.platforms[this.platform];
    const executable = path.join(directory, ...target.interpreter.executable.split('/'));
    if (!inside(directory, fs.realpathSync(executable)) || !fs.statSync(executable).isFile())
      throw Error('Python interpreter escaped its environment.');
    const profile = fs.mkdtempSync(path.join(this.directory, '.probe-'));
    try {
      const env = cleanEnvironment(profile);
      const spec = JSON.stringify({
        python: asset.pythonVersion.split('.').map(Number),
        modules: asset.modules,
        wheels: target.wheels.map(wheel => ({ name: wheel.name, version: wheel.version })),
      });
      const script = `import sys, importlib, importlib.metadata\nspec = ${spec}\nassert tuple(sys.version_info[:3]) == tuple(spec["python"]), "Python version mismatch"\nfor wheel in spec["wheels"]:\n assert importlib.metadata.version(wheel["name"]) == wheel["version"], "Python package version mismatch"\nfor name in spec["modules"]: importlib.import_module(name)\nprint("HARNESS_PYTHON_PROBE_OK")\n`;
      const output = await this.command(executable, ['-I', '-B', '-c', script], {
        cwd: profile,
        env,
        signal: options.signal,
        timeout: 60000,
      });
      if (!String(output).includes('HARNESS_PYTHON_PROBE_OK'))
        throw Error('Python runtime probe did not confirm readiness.');
      if (asset.probe)
        await this.command(executable, ['-I', '-B', '-c', asset.probe], {
          cwd: profile,
          env,
          signal: options.signal,
          timeout: 60000,
        });
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  async install(asset, options) {
    const target = asset.platforms[this.platform];
    const report = phase => options.onProgress?.({ label: asset.label, phase });
    const stage = fs.mkdtempSync(path.join(this.directory, '.staging-'));
    const destination = this.location(asset),
      backup = `${destination}.previous-${crypto.randomUUID()}`;
    let published = false,
      movedOld = false;
    try {
      const archive = await this.download(target.interpreter, options);
      const wheelFiles = [];
      for (const wheel of target.wheels)
        wheelFiles.push([wheel, await this.download(wheel, options)]);
      report('extracting');
      await this.extract(archive, stage, target, options.signal);
      const wheelhouse = path.join(stage, '.wheelhouse');
      fs.mkdirSync(wheelhouse, { mode: 0o700 });
      const requirements = [];
      for (const [wheel, file] of wheelFiles) {
        this.guard(file);
        if (!this.cached(wheel)) throw Error('Cached Python wheel changed.');
        const copied = path.join(wheelhouse, wheel.filename);
        fs.copyFileSync(file, copied, fs.constants.COPYFILE_EXCL);
        requirements.push(
          `${wheel.name} @ ${pathToFileURL(copied).href} --hash=sha256:${wheel.sha256}`,
        );
      }
      const requirementsFile = path.join(wheelhouse, 'requirements.txt');
      fs.writeFileSync(requirementsFile, requirements.join('\n') + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      const executable = path.join(stage, ...target.interpreter.executable.split('/'));
      if (!inside(stage, fs.realpathSync(executable)))
        throw Error('Python interpreter escaped its environment.');
      const profile = fs.mkdtempSync(path.join(this.directory, '.pip-'));
      try {
        report('installing');
        await this.command(
          executable,
          [
            '-I',
            '-B',
            '-m',
            'pip',
            '--isolated',
            'install',
            '--no-index',
            '--no-deps',
            '--only-binary=:all:',
            '--require-hashes',
            '--no-compile',
            '--no-cache-dir',
            '--no-user',
            '--disable-pip-version-check',
            '--no-warn-script-location',
            '-r',
            requirementsFile,
          ],
          { cwd: profile, env: cleanEnvironment(profile), signal: options.signal, timeout: 180000 },
        );
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
      }
      fs.rmSync(wheelhouse, { recursive: true, force: true });
      report('checking');
      await this.probe(asset, stage, options);
      inventory(stage, target.installedSize, false);
      options.signal?.throwIfAborted();
      this.guard(destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      this.guard(destination);
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, backup);
        movedOld = true;
      }
      fs.renameSync(stage, destination);
      published = true;
      // Standalone Python must still run after relocation; only then publish a receipt.
      await this.probe(asset, destination, options);
      options.signal?.throwIfAborted();
      const receipt = {
        schemaVersion: 1,
        declarationHash: this.identity(asset),
        pythonVersion: asset.pythonVersion,
        checkedAt: new Date().toISOString(),
        executableSha256: fileHash(
          fs.realpathSync(path.join(destination, ...target.interpreter.executable.split('/'))),
        ),
        files: inventory(destination, target.installedSize, true),
      };
      fs.writeFileSync(path.join(destination, 'receipt.json'), JSON.stringify(receipt), {
        flag: 'wx',
        mode: 0o600,
      });
      if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
      report('ready');
    } catch (error) {
      if (published) fs.rmSync(destination, { recursive: true, force: true });
      if (movedOld) fs.renameSync(backup, destination);
      throw error;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  async ensure(assets = [], options = {}) {
    const selected = this.selected(JSON.parse(JSON.stringify(assets)));
    options.signal?.throwIfAborted();
    if (!selected.length) return [];
    for (const asset of selected)
      if (!asset.platforms[this.platform])
        throw Error('Python environment does not support this platform.');
    const existing = this.status(selected);
    if (!options.recheck && existing.every(item => item.ready)) return existing;
    const estimate = this.estimate(selected);
    const checkedSpace = checkSpace(this.directory, estimate, this.space);
    options.onProgress?.({ label: selected[0].label, phase: 'checking-space', ...checkedSpace });
    if (!fs.existsSync(this.directory))
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.guard();
    fs.chmodSync(this.directory, 0o700);
    const unlock = this.lock();
    try {
      for (const asset of selected) {
        const report = progress => options.onProgress?.({ label: asset.label, ...progress });
        if (this.status([asset])[0].ready) {
          if (!options.recheck) continue;
          try {
            this.receipt(asset, true);
            report({ phase: 'checking' });
            await this.probe(asset, this.location(asset), options);
            options.signal?.throwIfAborted();
            continue;
          } catch (error) {
            if (options.signal?.aborted) throw error;
            // Retain the old bytes for recovery, but never call an environment
            // ready again after its content or real runtime probe failed.
            const marker = path.join(this.location(asset), '.needs-repair');
            this.guard(marker);
            fs.writeFileSync(marker, JSON.stringify({ checkedAt: new Date().toISOString() }), {
              flag: 'wx',
              mode: 0o600,
            });
          }
        }
        // A recheck may discover damage in an environment whose initial
        // estimate needed no installation. Budget the replacement before
        // staging it, while retaining the previous bytes for rollback.
        const repairSpace = checkSpace(this.directory, this.estimate([asset]), this.space);
        report({ phase: 'checking-space', ...repairSpace });
        await this.install(asset, { ...options, onProgress: report });
      }
      return this.status(selected);
    } finally {
      unlock();
    }
  }
}
module.exports = { PythonEnvironmentManager, validatePythonEnvironments };
