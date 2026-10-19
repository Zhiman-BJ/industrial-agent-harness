// Content-bound, private read-only input for the display worker. Per-tile
// validation revokes changed sources; it never hashes a mutable input again.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const changed = () => Error('Layout artifact changed; reopen this view.');
const fingerprint = stat =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

class LayoutSourceStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES;
    this.maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
    this.reservedBytes = 0;
    this.sources = new Set();
    this.ready = this.initialize();
  }

  async initialize() {
    await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fsp.lstat(this.directory)).isSymbolicLink())
      throw Error('Invalid layout snapshot directory.');
    this.directory = await fsp.realpath(this.directory);
    await fsp.chmod(this.directory, 0o700);
    // Recover only this store's private sessions, never project files. Other
    // live processes' sessions count against the quota and are not removed.
    for (const name of await fsp.readdir(this.directory)) {
      const match = /^session-(\d+)-[0-9a-f-]+$/.exec(name);
      if (!match) continue;
      const directory = path.join(this.directory, name);
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (!running(Number(match[1]))) {
        await fsp.chmod(directory, 0o700);
        await fsp.rm(directory, { recursive: true, force: true });
      } else {
        for (const file of await fsp.readdir(directory)) {
          const child = await fsp.lstat(path.join(directory, file));
          if (child.isFile()) this.reservedBytes += child.size;
        }
      }
    }
  }

  async prepare({ file, sha256, signal }) {
    await this.ready;
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw Error('Invalid layout source identity.');
    const extension = path.extname(file).toLowerCase();
    if (!['.gds', '.gdsii', '.oas', '.oasis'].includes(extension))
      throw Error('Unsupported layout input.');
    if ((await fsp.lstat(file)).isSymbolicLink()) throw changed();
    const original = await fsp.realpath(file);
    const handle = await fsp.open(original, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let directory;
    let reserved = 0;
    let transferred = false;
    try {
      const before = await handle.stat({ bigint: true });
      const bytes = Number(before.size);
      if (!before.isFile() || !Number.isSafeInteger(bytes) || bytes > this.maxSourceBytes)
        throw Error('Layout input exceeds the supported import size.');
      if (this.reservedBytes + bytes > this.maxBytes)
        throw Error('Layout snapshot storage budget reached. Close another layout and retry.');
      // Reserve before any further await; concurrent opens cannot overbook.
      this.reservedBytes += bytes;
      reserved = bytes;
      const disk = await fsp.statfs(this.directory);
      if (disk.bavail * disk.bsize < bytes + 16 * 1024 * 1024)
        throw Error('Not enough disk space for the layout snapshot.');
      signal?.throwIfAborted();
      directory = path.join(this.directory, `session-${process.pid}-${crypto.randomUUID()}`);
      await fsp.mkdir(directory, { mode: 0o700 });
      const snapshot = path.join(directory, `${sha256}${extension}`);
      const hash = crypto.createHash('sha256');
      let copied = 0;
      await pipeline(
        handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 }),
        new Transform({
          transform(chunk, _encoding, callback) {
            copied += chunk.length;
            if (copied > bytes) return callback(changed());
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        fs.createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      const after = await handle.stat({ bigint: true });
      if (
        copied !== bytes ||
        hash.digest('hex') !== sha256 ||
        fingerprint(before) !== fingerprint(after) ||
        (await fsp.realpath(file)) !== original ||
        fingerprint(await fsp.lstat(original, { bigint: true })) !== fingerprint(before)
      )
        throw changed();
      await fsp.chmod(snapshot, 0o400);
      await fsp.chmod(directory, 0o500);
      const snapshotIdentity = fingerprint(await fsp.lstat(snapshot, { bigint: true }));
      const sourceIdentity = fingerprint(before);
      let closed = false;
      let closing;
      const source = {
        path: snapshot,
        sha256,
        bytes,
        assertCurrent: async () => {
          if (closed) throw changed();
          try {
            const [currentSource, currentSnapshot, sourcePath, snapshotPath] = await Promise.all([
              fsp.lstat(original, { bigint: true }),
              fsp.lstat(snapshot, { bigint: true }),
              fsp.realpath(file),
              fsp.realpath(snapshot),
            ]);
            if (
              closed ||
              sourcePath !== original ||
              snapshotPath !== snapshot ||
              !currentSource.isFile() ||
              !currentSnapshot.isFile() ||
              fingerprint(currentSource) !== sourceIdentity ||
              fingerprint(currentSnapshot) !== snapshotIdentity
            )
              throw changed();
          } catch {
            throw changed();
          }
        },
        close: () => {
          if (closing) return closing;
          closed = true;
          closing = (async () => {
            try {
              await fsp.chmod(directory, 0o700).catch(error => {
                if (error.code !== 'ENOENT') throw error;
              });
              await fsp.rm(directory, { recursive: true, force: true });
              this.sources.delete(source);
              this.reservedBytes -= bytes;
            } catch (error) {
              // Failed cleanup still occupies disk and stays in the quota.
              closing = undefined;
              throw error;
            }
          })();
          return closing;
        },
      };
      signal?.throwIfAborted();
      this.sources.add(source);
      transferred = true;
      return source;
    } finally {
      await handle.close();
      if (!transferred) {
        if (directory) {
          await fsp.chmod(directory, 0o700).catch(() => {});
          await fsp.rm(directory, { recursive: true, force: true });
        }
        this.reservedBytes -= reserved;
      }
    }
  }

  async close() {
    await Promise.allSettled([...this.sources].map(source => source.close()));
  }
}

module.exports = { LayoutSourceStore, MAX_SOURCE_BYTES, MAX_SNAPSHOT_BYTES };
