const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { downloadRuntimeArchive, runtimeDownloadTimeout } = require('./runtime-download.cjs');
const { Transfer } = require('./transfer.cjs');

test('runtime timeout budget accommodates measured large download duration', () => {
  assert.ok(runtimeDownloadTimeout(1.4 * 1024 ** 3) > 2500 * 1000);
  assert.ok(runtimeDownloadTimeout(650 * 1024 ** 2) > 1160 * 1000);
  assert.ok(runtimeDownloadTimeout(64 * 1024 ** 3) <= 24 * 60 * 60 * 1000);
});

test('interrupted loopback download resumes exact validated bytes; ignored ranges restart; malformed identities fail closed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-download-test-'));
  const bytes = crypto.randomBytes(256 * 1024),
    requests = [];
  let mode = 'interrupt';
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range, validator: req.headers['if-range'] });
    const offset = Number((req.headers.range || '').match(/bytes=(\d+)-/)?.[1] || 0);
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://unsafe.example/file' });
      res.end();
      return;
    }
    const resume = offset && mode !== 'ignore';
    res.writeHead(resume ? 206 : 200, {
      ETag: mode === 'replace' ? '"replacement"' : '"object-v1"',
      'Content-Length': bytes.length - (resume ? offset : 0),
      ...(resume
        ? {
            'Content-Range': `bytes ${mode === 'malformed' ? offset + 1 : offset}-${bytes.length - 1}/${bytes.length}`,
          }
        : {}),
    });
    if (mode === 'interrupt') {
      res.write(bytes.subarray(0, 65536));
      setTimeout(() => res.destroy(), 20);
    } else res.end(bytes.subarray(resume ? offset : 0));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchOriginal = global.fetch;
  global.fetch = (url, options) =>
    fetchOriginal(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options);
  t.after(() => {
    global.fetch = fetchOriginal;
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const asset = {
    url: 'https://vendor.example/file',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const target = path.join(root, 'archive.zip');
  const interrupt = async () => {
    mode = 'interrupt';
    await assert.rejects(downloadRuntimeArchive(asset, target));
    assert.equal(fs.statSync(target + '.partial').size, 65536);
  };
  await interrupt();
  mode = 'resume';
  await downloadRuntimeArchive(asset, target);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(requests.at(-1), { range: 'bytes=65536-', validator: '"object-v1"' });
  assert.equal(fs.existsSync(target + '.partial'), false);
  for (const invalid of ['malformed', 'replace', 'redirect']) {
    fs.rmSync(target);
    await interrupt();
    mode = invalid;
    await assert.rejects(downloadRuntimeArchive(asset, target), /range mismatch|HTTPS/);
    assert.equal(fs.existsSync(target), false);
    if (invalid === 'redirect') {
      fs.rmSync(target + '.partial');
      fs.rmSync(target + '.partial.json');
    } else assert.equal(fs.existsSync(target + '.partial'), false);
    fs.writeFileSync(target, bytes);
  }
  fs.rmSync(target);
  await interrupt();
  mode = 'ignore';
  await downloadRuntimeArchive(asset, target);
  assert.deepEqual(fs.readFileSync(target), bytes);
  fs.rmSync(target);
  await interrupt();
  const corrupt = fs.openSync(target + '.partial', 'r+');
  fs.writeSync(corrupt, Buffer.from('corrupted prefix'), 0, 16, 0);
  fs.closeSync(corrupt);
  mode = 'resume';
  await assert.rejects(downloadRuntimeArchive(asset, target), /hash mismatch/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.partial'), false);
});

test('steady throttled loopback body outlives short old deadline; inactivity and cancel retain validated partial bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-throttled-test-'));
  const bytes = Buffer.alloc(100, 7);
  let stalled = false;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { ETag: '"fixed"', 'Content-Length': 100 });
    let offset = 0;
    const timer = setInterval(() => {
      if (stalled && offset) return;
      res.write(bytes.subarray(offset, offset + 10));
      offset += 10;
      if (offset === bytes.length) {
        clearInterval(timer);
        res.end();
      }
    }, 15);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = global.fetch;
  global.fetch = (url, options) => original(`http://127.0.0.1:${server.address().port}/`, options);
  t.after(() => {
    global.fetch = original;
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const asset = {
    url: 'https://vendor.example/slow',
    size: 100,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const target = path.join(root, 'archive');
  await downloadRuntimeArchive(asset, target, {
    transferOptions: { stallMs: 80, timeoutMs: 1000 },
  });
  assert.deepEqual(fs.readFileSync(target), bytes);
  stalled = true;
  fs.rmSync(target);
  await assert.rejects(
    downloadRuntimeArchive(asset, target, { transferOptions: { stallMs: 60, timeoutMs: 1000 } }),
    /stalled/,
  );
  assert.equal(fs.statSync(target + '.partial').size, 10);
  fs.rmSync(target + '.partial');
  fs.rmSync(target + '.partial.json');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(downloadRuntimeArchive(asset, target, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(fs.statSync(target + '.partial').size, 10);
  const transfer = new Transfer({ timeoutMs: 30, stallMs: 500 });
  await assert.rejects(
    transfer.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      transfer.signal.throwIfAborted();
    }),
    /timed out/,
  );
});
