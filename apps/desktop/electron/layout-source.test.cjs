const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LayoutSourceStore } = require('./layout-source.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function setup(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-source-test-'));
  const file = path.join(directory, 'source.gds');
  const bytes = Buffer.from('layout-fixture-0123456789');
  await fs.writeFile(file, bytes);
  const store = new LayoutSourceStore(path.join(directory, 'snapshots'), options);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, file, bytes, store, sha256: digest(bytes) };
}

test('snapshot preserves verified source bytes and releases disk reservation on close', async t => {
  const { file, bytes, store, sha256 } = await setup(t);
  const source = await store.prepare({ file, sha256 });
  assert.notEqual(source.path, file);
  assert.deepEqual(await fs.readFile(source.path), bytes);
  assert.equal(source.sha256, sha256);
  assert.equal(store.reservedBytes, bytes.length);
  await source.assertCurrent();
  await source.assertCurrent();
  if (process.platform !== 'win32') assert.equal((await fs.stat(source.path)).mode & 0o222, 0);
  await source.close();
  await source.close();
  assert.equal(store.reservedBytes, 0);
  await assert.rejects(source.assertCurrent(), /changed/);
  await assert.rejects(fs.stat(source.path), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('same-size source rewrite with restored mtime revokes the captured source version', async t => {
  const { file, bytes, store, sha256 } = await setup(t);
  const originalStat = await fs.stat(file);
  const source = await store.prepare({ file, sha256 });
  const modified = Buffer.from(bytes);
  modified[0] ^= 1;
  await fs.writeFile(file, modified);
  await fs.utimes(file, originalStat.atime, originalStat.mtime);
  await assert.rejects(source.assertCurrent(), /changed/);
  assert.deepEqual(
    await fs.readFile(source.path),
    bytes,
    'worker input is still the verified version',
  );
});

test('path replacement revokes even an identical-content source', async t => {
  const { directory, file, bytes, store, sha256 } = await setup(t);
  const source = await store.prepare({ file, sha256 });
  const replacement = path.join(directory, 'replacement.gds');
  await fs.writeFile(replacement, bytes);
  await fs.rename(replacement, file);
  await assert.rejects(source.assertCurrent(), /changed/);
});

test('snapshot tampering is rejected before further tile requests', async t => {
  const { file, bytes, store, sha256 } = await setup(t);
  const source = await store.prepare({ file, sha256 });
  await fs.chmod(source.path, 0o600);
  await fs.writeFile(source.path, Buffer.alloc(bytes.length));
  await fs.chmod(source.path, 0o400);
  await assert.rejects(source.assertCurrent(), /changed/);
});

test('wrong source digest, import size and aborted copy never publish a snapshot', async t => {
  const { file, bytes, store, sha256 } = await setup(t, { maxSourceBytes: 64 });
  await assert.rejects(store.prepare({ file, sha256: '0'.repeat(64) }), /changed/);
  assert.equal(store.reservedBytes, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.prepare({ file, sha256, signal: controller.signal }), /abort/i);
  await fs.writeFile(file, Buffer.alloc(65));
  await assert.rejects(store.prepare({ file, sha256 }), /import size/);
  assert.equal(store.reservedBytes, 0);
  assert.deepEqual(await fs.readdir(store.directory), []);
  assert.ok(bytes.length < 64);
});

test('concurrent prepares cannot overbook the snapshot byte quota', async t => {
  const { file, bytes, store, sha256 } = await setup(t, { maxBytes: 30 });
  const results = await Promise.allSettled([
    store.prepare({ file, sha256 }),
    store.prepare({ file, sha256 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(store.reservedBytes, bytes.length);
  await store.close();
  assert.equal(store.reservedBytes, 0);
});

test('source symlinks and source deletion are rejected', async t => {
  const { directory, file, store, sha256 } = await setup(t);
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'linked.gds');
    await fs.symlink(file, link);
    await assert.rejects(store.prepare({ file: link, sha256 }), /changed/);
  }
  const source = await store.prepare({ file, sha256 });
  await fs.unlink(file);
  await assert.rejects(source.assertCurrent(), /changed/);
});

test('a same-size write during copy cannot publish mixed or stale bytes', async t => {
  const { file, store } = await setup(t);
  const bytes = Buffer.alloc(1024 * 1024, 17);
  await fs.writeFile(file, bytes);
  const canonical = await fs.realpath(file);
  const open = fs.open;
  let changed = false;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonical) {
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = options => {
        const stream = create(options);
        stream.once('data', () => {
          changed = true;
          const sync = require('node:fs');
          const fd = sync.openSync(file, 'r+');
          sync.writeSync(fd, Buffer.from([18]), 0, 1, 0);
          sync.closeSync(fd);
        });
        return stream;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(store.prepare({ file, sha256: digest(bytes) }), /changed/);
    assert.equal(changed, true);
    assert.equal(store.reservedBytes, 0);
    assert.deepEqual(await fs.readdir(store.directory), []);
  } finally {
    fs.open = open;
  }
});

test('failed cleanup stays charged and can be retried', async t => {
  const { file, bytes, store, sha256 } = await setup(t);
  const source = await store.prepare({ file, sha256 });
  const remove = fs.rm;
  fs.rm = async (...args) => {
    if (args[0] === path.dirname(source.path))
      throw Object.assign(Error('test cleanup failure'), { code: 'EACCES' });
    return remove(...args);
  };
  try {
    await assert.rejects(source.close(), /cleanup failure/);
    assert.equal(store.reservedBytes, bytes.length);
    assert.equal(store.sources.has(source), true);
  } finally {
    fs.rm = remove;
  }
  await source.close();
  assert.equal(store.reservedBytes, 0);
  assert.equal(store.sources.has(source), false);
});

test('startup reclaims dead sessions and preserves another live session', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-source-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dead = path.join(directory, `session-2147483647-${crypto.randomUUID()}`);
  const live = path.join(directory, `session-${process.pid}-${crypto.randomUUID()}`);
  await fs.mkdir(dead);
  await fs.mkdir(live);
  await fs.writeFile(path.join(dead, 'source.gds'), 'dead');
  await fs.writeFile(path.join(live, 'source.gds'), 'live');
  const store = new LayoutSourceStore(directory);
  await store.ready;
  await assert.rejects(fs.stat(dead), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(live, 'source.gds'), 'utf8'), 'live');
  assert.equal(store.reservedBytes, 4);
});
