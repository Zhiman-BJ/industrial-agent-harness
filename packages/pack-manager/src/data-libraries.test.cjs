const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  DataLibraryManager,
  validateDataLibrary,
  validateDataCatalog,
  DEFAULT_DATA_LIBRARY_LIMITS,
} = require('./data-libraries.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const first = Buffer.from('first pinned data');
const second = Buffer.from('second pinned data');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-library-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'cache');
  if (!options.lazy) fs.mkdirSync(directory, { mode: 0o700 });
  const library = {
    id: 'public.shapes',
    version: '1.2.3',
    baseUrl: 'https://official.example/library/0123456789012345678901234567890123456789/',
  };
  const declaration = (name, data) => ({ path: name, size: data.length, sha256: hash(data) });
  const catalog = {
    schemaVersion: 1,
    ...library,
    files: [
      declaration('parts/first.bin', first),
      declaration('parts/first-alias.bin', first),
      declaration('parts/second.bin', second),
    ],
  };
  const calls = [];
  const manager = new DataLibraryManager({
    directory,
    space: () => 1024 ** 3,
    async fetch(url, request) {
      calls.push({ url, request });
      if (options.fetch) return options.fetch(url, request);
      const data = url.endsWith('second.bin') ? second : first;
      return new Response(data, { headers: { 'Content-Length': String(data.length) } });
    },
    ...options.manager,
  });
  return { root, directory, library, catalog, manager, calls };
}

function apiFixture(t, options = {}) {
  const f = fixture(t, options);
  f.library.baseUrl = 'https://official.example/api/v4/';
  f.library.download = {
    type: 'gitlab-repository-files',
    project: 'public-group/shapes',
    ref: '0123456789012345678901234567890123456789',
  };
  f.catalog.baseUrl = f.library.baseUrl;
  f.catalog.schemaVersion = 2;
  f.catalog.download = { ...f.library.download };
  return f;
}

test('pinned GitLab file API planning is offline and encodes full project/file paths once', async t => {
  const f = apiFixture(t, { lazy: true });
  const relative = 'Models.3dshapes/R_0603 (日本).step';
  f.catalog.files.push({ ...f.catalog.files[0], path: relative });
  const plan = f.manager.plan(f.library, f.catalog, [relative]);
  assert.deepEqual(plan.download, f.library.download);
  assert.equal(f.manager.resolve(f.library, f.catalog, [relative]).missingPaths[0], relative);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.directory), false);
  const result = await f.manager.ensure(f.library, f.catalog, [relative]);
  const expected = new URL(
    'projects/' +
      encodeURIComponent(f.library.download.project) +
      '/repository/files/' +
      encodeURIComponent(relative) +
      '/raw',
    f.library.baseUrl,
  );
  expected.searchParams.set('ref', f.library.download.ref);
  assert.equal(f.calls[0].url, expected.href);
  assert.equal(f.calls[0].request.redirect, 'manual');
  assert.equal(f.calls[0].request.credentials, 'omit');
  assert.equal(result.stats.downloadedFiles, 1);
  assert.deepEqual(fs.readFileSync(result.files[0].file), first);
  const cached = await f.manager.ensure(f.library, f.catalog, [relative], { offline: true });
  assert.equal(cached.stats.downloadedFiles, 0);
  assert.equal(f.calls.length, 1);
});

test('GitLab API declarations bind catalog project and immutable revision without general query support', t => {
  const f = apiFixture(t);
  for (const download of [
    null,
    { ...f.library.download, type: 'custom-template' },
    { ...f.library.download, project: '../other' },
    { ...f.library.download, project: 'group//repo' },
    { ...f.library.download, project: 'group%2Frepo' },
    { ...f.library.download, project: 'https://other.example/repo' },
    { ...f.library.download, ref: 'main' },
    { ...f.library.download, query: 'token=secret' },
  ])
    assert.throws(() => validateDataLibrary({ ...f.library, download }), /download source/);
  for (const change of [{ project: 'other/repo' }, { ref: 'a'.repeat(40) }])
    assert.throws(
      () =>
        validateDataCatalog(
          { ...f.catalog, download: { ...f.catalog.download, ...change } },
          f.library,
        ),
      /download source/,
    );
  assert.throws(
    () => validateDataCatalog({ ...f.catalog, download: undefined }, f.library),
    /download source/,
  );
  assert.throws(
    () => validateDataCatalog({ ...f.catalog, schemaVersion: 1 }, f.library),
    /mismatching/,
  );
  assert.throws(
    () => validateDataLibrary({ ...f.library, baseUrl: 'https://official.example/library/' }),
    /API v4/,
  );
  assert.throws(
    () => validateDataLibrary({ ...f.library, baseUrl: f.library.baseUrl + '?ref=main' }),
    /HTTPS/,
  );
});

test('GitLab API redirects and response URLs cannot change origin, project, file or pinned ref', async t => {
  const suffix = '/projects/public-group%2Fshapes/repository/files/parts%2Ffirst.bin/raw';
  for (const changed of [
    'https://other.example/api/v4' + suffix + '?ref=' + '0'.repeat(40),
    'https://official.example/api/v4' +
      suffix.replace('shapes', 'other') +
      '?ref=' +
      '0'.repeat(40),
    'https://official.example/api/v4' +
      suffix.replace('first.bin', 'second.bin') +
      '?ref=' +
      '0'.repeat(40),
    '?ref=main',
    '?ref=0123456789012345678901234567890123456789&token=secret',
    '#fragment',
  ]) {
    const f = apiFixture(t, {
      fetch: () => new Response(null, { status: 302, headers: { Location: changed } }),
    });
    await assert.rejects(
      f.manager.ensure(f.library, f.catalog, ['parts/first.bin']),
      /pinned file or revision/,
    );
    assert.equal(f.calls.length, 1);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
  const f = apiFixture(t, {
    fetch: () => {
      const response = new Response(first);
      Object.defineProperty(response, 'url', {
        value: 'https://official.example/api/v4/unexpected?ref=main',
      });
      return response;
    },
  });
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin']),
    /pinned file or revision/,
  );
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('API 403, rate limits and HTML/error bytes cannot publish a verified model', async t => {
  for (const status of [403, 429]) {
    const f = apiFixture(t, { fetch: () => new Response('Just a moment...', { status }) });
    await assert.rejects(
      f.manager.ensure(f.library, f.catalog, ['parts/first.bin']),
      new RegExp('HTTP ' + status),
    );
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
  const f = apiFixture(t, { fetch: () => new Response(Buffer.alloc(first.length, '<')) });
  await assert.rejects(f.manager.ensure(f.library, f.catalog, ['parts/first.bin']), /integrity/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('construction and offline resolution do not create a missing cache directory', async t => {
  const f = fixture(t, { lazy: true });
  assert.equal(fs.existsSync(f.directory), false);
  const result = f.manager.resolve(f.library, f.catalog, ['parts/first.bin']);
  assert.deepEqual(result.missingPaths, ['parts/first.bin']);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin'], { offline: true }),
    { code: 'DATA_LIBRARY_OFFLINE' },
  );
  assert.equal(fs.existsSync(f.directory), false);
  f.manager.space = () => 0;
  await assert.rejects(f.manager.ensure(f.library, f.catalog, ['parts/first.bin']), {
    code: 'ENOSPC',
  });
  assert.equal(fs.existsSync(f.directory), false);
  f.manager.space = () => 1024 ** 3;
  const downloaded = await f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  assert.equal(downloaded.files.length, 1);
  assert.equal(fs.statSync(f.directory).isDirectory(), true);
});

test('planning selects only catalog resources and counts shared hashes once', t => {
  const f = fixture(t);
  const plan = f.manager.plan(f.library, f.catalog, [
    'parts/first.bin',
    'parts/first-alias.bin',
    'parts/first.bin',
  ]);
  assert.deepEqual(plan.stats, {
    requestedFiles: 2,
    uniqueFiles: 1,
    totalBytes: first.length,
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('catalog validation allows larger unrequested files but request admission keeps the small budget', t => {
  const f = fixture(t);
  f.catalog.files.push({
    path: 'large.bin',
    size: 32 * 1024 ** 2,
    sha256: 'a'.repeat(64),
  });
  assert.equal(validateDataCatalog(f.catalog, f.library), f.catalog);
  assert.equal(f.manager.plan(f.library, f.catalog, ['parts/first.bin']).files.length, 1);
  assert.throws(() => f.manager.plan(f.library, f.catalog, ['large.bin']), /per-file/);
});

test('declarations and catalogs reject unsafe paths, URLs, identities and duplicate entries', t => {
  const f = fixture(t);
  for (const baseUrl of [
    'http://official.example/library/',
    'https://user:secret@official.example/library/',
    'https://official.example/library/?token=secret',
    'https://official.example/library/#fragment',
    'https://official.example/library',
    'https://official.example/%2e%2e/library/',
  ])
    assert.throws(() => validateDataLibrary({ ...f.library, baseUrl }), /library|HTTPS/);
  for (const name of [
    '../outside.bin',
    '/outside.bin',
    'parts\\outside.bin',
    'parts/%2e%2e/outside.bin',
    'parts/file.bin?query',
    'parts/file.bin#fragment',
    'parts/file\0.bin',
  ])
    assert.throws(
      () =>
        validateDataCatalog(
          { ...f.catalog, files: [{ ...f.catalog.files[0], path: name }] },
          f.library,
        ),
      /Unsafe/,
    );
  assert.throws(
    () => validateDataCatalog({ ...f.catalog, id: 'other.library' }, f.library),
    /mismatching/,
  );
  assert.throws(
    () =>
      validateDataCatalog({ ...f.catalog, baseUrl: 'https://other.example/library/' }, f.library),
    /base URL/,
  );
  assert.throws(
    () =>
      validateDataCatalog(
        { ...f.catalog, files: [f.catalog.files[0], f.catalog.files[0]] },
        f.library,
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateDataCatalog(
        {
          ...f.catalog,
          files: [f.catalog.files[0], { ...f.catalog.files[1], size: first.length + 1 }],
        },
        f.library,
      ),
    /Invalid/,
  );
});

test('request limits fail before network activity or staging and may only be reduced', async t => {
  const f = fixture(t);
  const requests = ['parts/first.bin', 'parts/second.bin'];
  for (const limits of [
    { files: 1 },
    { fileBytes: first.length - 1 },
    { totalBytes: first.length + second.length - 1 },
    { files: DEFAULT_DATA_LIBRARY_LIMITS.files + 1 },
  ])
    await assert.rejects(
      f.manager.ensure(f.library, f.catalog, requests, { limits }),
      /limit|budget/,
    );
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['undeclared.bin']),
    /not in.*catalog/,
  );
  const tooMany = {
    ...f.catalog,
    files: Array.from({ length: 10001 }, (_, i) => ({
      path: 'part-' + i,
      sha256: hash(first),
      size: first.length,
    })),
  };
  assert.throws(() => validateDataCatalog(tooMany, f.library), /catalog/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('atomic downloads retain no executable bits and cached resources work offline', async t => {
  const f = fixture(t);
  const progress = [];
  const requested = ['parts/first.bin', 'parts/first-alias.bin'];
  const loaded = await f.manager.ensure(f.library, f.catalog, requested, {
    onProgress: event => progress.push(event),
  });
  assert.equal(f.calls.length, 1, 'same hash is fetched once');
  assert.equal(loaded.files.length, 2);
  assert.equal(loaded.files[0].file, loaded.files[1].file);
  assert.equal(loaded.stats.downloadedFiles, 1);
  assert.equal(loaded.stats.downloadedBytes, first.length);
  assert.deepEqual(loaded.missingPaths, []);
  assert.equal(fs.statSync(loaded.files[0].file).mode & 0o111, 0);
  assert.deepEqual(fs.readFileSync(loaded.files[0].file), first);
  assert.equal(JSON.stringify(progress).includes(f.directory), false);
  assert.equal(progress.at(-1).phase, 'complete');
  const found = f.manager.resolve(f.library, f.catalog, requested);
  assert.equal(
    found.files.every(file => file.cached),
    true,
  );
  assert.equal(found.stats.downloadBytes, 0);
  assert.equal(found.stats.missingFiles, 0);
  const offline = await f.manager.ensure(f.library, f.catalog, requested, { offline: true });
  assert.equal(offline.stats.downloadedFiles, 0);
  assert.equal(f.calls.length, 1);
});

test('resolve exposes missing and corrupt cache states without making a network request', async t => {
  const f = fixture(t);
  const initial = f.manager.resolve(f.library, f.catalog, ['parts/first.bin', 'parts/second.bin']);
  assert.deepEqual(initial.missingPaths, ['parts/first.bin', 'parts/second.bin']);
  assert.equal(initial.stats.downloadBytes, first.length + second.length);
  assert.equal(f.calls.length, 0);
  await f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  const file = path.join(f.manager.directory, hash(first));
  fs.writeFileSync(file, Buffer.alloc(first.length, 120));
  const corrupt = f.manager.resolve(f.library, f.catalog, ['parts/first.bin']);
  assert.equal(corrupt.files.length, 0);
  assert.deepEqual(corrupt.missing, [{ path: 'parts/first.bin', reason: 'integrity' }]);
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin'], { offline: true }),
    { code: 'DATA_LIBRARY_OFFLINE' },
  );
  await f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(fs.readFileSync(file), first);
});

test('concurrent consumers deduplicate through a reverified content-addressed cache', async t => {
  const f = fixture(t);
  const results = await Promise.all([
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin']),
    f.manager.ensure(f.library, f.catalog, ['parts/first-alias.bin']),
  ]);
  assert.equal(f.calls.length, 1);
  assert.equal(results[0].stats.downloadedFiles, 1);
  assert.equal(results[1].stats.downloadedFiles, 0);
});

test('a queued cancellation returns promptly without releasing another active transfer', async t => {
  let release;
  let started;
  const beginning = new Promise(resolve => {
    started = resolve;
  });
  const response = new Promise(resolve => {
    release = resolve;
  });
  const f = fixture(t, {
    fetch: () => {
      started();
      return response;
    },
  });
  const active = f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  await beginning;
  const controller = new AbortController();
  const queued = f.manager.ensure(f.library, f.catalog, ['parts/second.bin'], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  const following = f.manager.ensure(f.library, f.catalog, ['parts/first-alias.bin']);
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  release(new Response(first));
  await Promise.all([active, following]);
  assert.equal(
    f.calls.length,
    1,
    'the following request waits and then reuses the verified object',
  );
});

test('constructing a manager over a read-only hot cache does not require write access', async t => {
  const f = fixture(t);
  const loaded = await f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  const entries = fs.readdirSync(f.directory);
  const attempts = [];
  const deny = name => {
    attempts.push(name);
    throw Object.assign(Error('The hot cache is read-only.'), { code: 'EROFS' });
  };
  // Enforce read-only access even where POSIX directory modes are unavailable,
  // and record rejected calls so catching EROFS cannot hide a write attempt.
  if (process.platform !== 'win32') fs.chmodSync(f.directory, 0o500);
  const guards = [
    'mkdirSync',
    'chmodSync',
    'writeSync',
    'writeFileSync',
    'appendFileSync',
    'renameSync',
    'rmSync',
    'unlinkSync',
    'rmdirSync',
    'truncateSync',
    'ftruncateSync',
    'copyFileSync',
    'cpSync',
    'linkSync',
    'symlinkSync',
  ].map(name => t.mock.method(fs, name, () => deny(name)));
  const open = fs.openSync;
  guards.push(
    t.mock.method(fs, 'openSync', (file, flags, ...options) => {
      const writes =
        typeof flags === 'string'
          ? !['r', 'rs', 'sr'].includes(flags)
          : (flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC |
                fs.constants.O_APPEND)) !==
            0;
      if (writes) return deny('openSync with write flags');
      return Reflect.apply(open, fs, [file, flags, ...options]);
    }),
  );
  try {
    const readonly = new DataLibraryManager({
      directory: f.directory,
      fetch: () => {
        throw Error('offline read attempted a network request');
      },
    });
    const result = readonly.resolve(f.library, f.catalog, ['parts/first.bin']);
    assert.equal(result.files.length, 1);
    const offline = await readonly.ensure(f.library, f.catalog, ['parts/first.bin'], {
      offline: true,
    });
    assert.equal(offline.stats.downloadedFiles, 0);
    assert.deepEqual(attempts, [], 'construction, resolution and offline reuse attempt no writes');
  } finally {
    for (const guard of guards) guard.mock.restore();
    if (process.platform !== 'win32') fs.chmodSync(f.directory, 0o700);
  }
  assert.deepEqual(fs.readdirSync(f.directory), entries);
  assert.deepEqual(fs.readFileSync(loaded.files[0].file), first);
  assert.equal(f.calls.length, 1, 'read-only reuse causes no additional network activity');
});

test('a damaged transfer is never published and removes its private staging file', async t => {
  const f = fixture(t, {
    fetch: () => new Response(Buffer.alloc(first.length, 120)),
  });
  await assert.rejects(f.manager.ensure(f.library, f.catalog, ['parts/first.bin']), /integrity/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const oversized = fixture(t, { fetch: () => new Response(Buffer.concat([first, first])) });
  await assert.rejects(
    oversized.manager.ensure(oversized.library, oversized.catalog, ['parts/first.bin']),
    /declared size/,
  );
  assert.deepEqual(fs.readdirSync(oversized.directory), []);
});

test('cancelling a streamed transfer aborts before publication and cleans its temporary file', async t => {
  let cancelled = false;
  const controller = new AbortController();
  const f = fixture(t, {
    fetch: () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(first.subarray(0, 3));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin'], {
      signal: controller.signal,
      onProgress(event) {
        if (event.phase === 'downloading') controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('an idle stream has a bounded deadline and is cancelled with cleanup', async t => {
  let cancelled = false;
  const f = fixture(t, {
    fetch: () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin'], {
      limits: { stallMs: 5, timeoutMs: 100 },
    }),
    /stalled/,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('an unresponsive connection and a nonsettling cancel promise cannot outlive transfer deadlines', async t => {
  const waiting = fixture(t, { fetch: () => new Promise(() => {}) });
  await assert.rejects(
    waiting.manager.ensure(waiting.library, waiting.catalog, ['parts/first.bin'], {
      limits: { stallMs: 5, timeoutMs: 100 },
    }),
    /stalled/,
  );
  const cancel = fixture(t, {
    fetch: () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {});
          },
        }),
      ),
  });
  await assert.rejects(
    cancel.manager.ensure(cancel.library, cancel.catalog, ['parts/first.bin'], {
      limits: { stallMs: 5, timeoutMs: 100 },
    }),
    /stalled/,
  );
  assert.deepEqual(fs.readdirSync(cancel.directory), []);
});

test('same-origin redirects remain inside the declared directory and preserve the hash identity', async t => {
  let count = 0;
  const f = fixture(t, {
    fetch: () => {
      if (!count++)
        return new Response(null, { status: 302, headers: { Location: 'first-final.bin' } });
      return new Response(first);
    },
  });
  await f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].request.redirect, 'manual');
  assert.ok(f.calls[1].url.endsWith('/parts/first-final.bin'));
});

test('redirects reject downgrade, credentials, another origin, directory escape, queries and loops', async t => {
  for (const location of [
    'http://official.example/library/first.bin',
    'https://user:secret@official.example/library/first.bin',
    'https://other.example/library/first.bin',
    '/outside.bin',
    'first.bin?token=secret',
    'first.bin#fragment',
    'first.bin',
  ]) {
    const f = fixture(t, {
      fetch: () => new Response(null, { status: 302, headers: { Location: location } }),
    });
    await assert.rejects(
      f.manager.ensure(f.library, f.catalog, ['parts/first.bin']),
      /HTTPS|credentials|redirect|origin/,
    );
    assert.ok(f.calls.length <= 6);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('symlink cache entries and cache directory replacement cannot escape to another directory', async t => {
  const f = fixture(t);
  const outsideDirectory = path.join(f.root, 'outside');
  fs.mkdirSync(outsideDirectory);
  const outside = path.join(outsideDirectory, 'outside.bin');
  fs.writeFileSync(outside, first);
  // Directory junctions need no administrator privilege on Windows; the
  // cache must reject them as entries and roots before following the target.
  const directoryLink = (target, link) =>
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform === 'win32')
    directoryLink(outsideDirectory, path.join(f.directory, hash(first)));
  else fs.symlinkSync(outside, path.join(f.directory, hash(first)), 'file');
  assert.throws(() => f.manager.resolve(f.library, f.catalog, ['parts/first.bin']), /Unsafe/);
  await assert.rejects(f.manager.ensure(f.library, f.catalog, ['parts/first.bin']), /Unsafe/);
  assert.deepEqual(fs.readFileSync(outside), first);
  assert.equal(f.calls.length, 0);
  const link = path.join(f.root, 'linked-cache');
  directoryLink(f.directory, link);
  assert.throws(() => new DataLibraryManager({ directory: link }), /symbolic/);
  fs.renameSync(f.directory, path.join(f.root, 'original-cache'));
  fs.mkdirSync(path.join(f.root, 'other-cache'));
  directoryLink(path.join(f.root, 'other-cache'), f.directory);
  assert.throws(() => f.manager.resolve(f.library, f.catalog, ['parts/first.bin']), /unsafe/);
  assert.deepEqual(fs.readdirSync(outsideDirectory), ['outside.bin']);
  assert.deepEqual(fs.readFileSync(outside), first);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'other-cache')), []);
  assert.equal(f.calls.length, 0);
});

test('disk admission counts only missing bytes and fails before fetching on insufficient space', async t => {
  const f = fixture(t);
  await f.manager.ensure(f.library, f.catalog, ['parts/first.bin']);
  f.manager.space = () => 1;
  await assert.rejects(
    f.manager.ensure(f.library, f.catalog, ['parts/first.bin', 'parts/second.bin']),
    { code: 'ENOSPC' },
  );
  assert.equal(f.calls.length, 1);
  f.manager.space = () => 64 * 1024 ** 2 + second.length;
  await f.manager.ensure(f.library, f.catalog, ['parts/first.bin', 'parts/second.bin']);
  assert.equal(f.calls.length, 2);
  f.manager.space = () => 0;
  const cached = await f.manager.ensure(f.library, f.catalog, ['parts/first.bin'], {
    offline: true,
  });
  assert.equal(cached.stats.downloadedBytes, 0);
});
