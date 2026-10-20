const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const tar = require('tar');
const { run } = require('./runtime-assets.cjs');
const {
  PythonEnvironmentManager,
  validatePythonEnvironments,
} = require('./python-environments.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function archive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '');
    const header = new tar.Header({
      path: entry.path,
      mode: entry.mode || 0o600,
      type: entry.type || 'File',
      size: data.length,
      ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
    });
    const block = Buffer.alloc(512);
    header.encode(block);
    blocks.push(block, data);
    if (data.length % 512) blocks.push(Buffer.alloc(512 - (data.length % 512)));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-environment-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const interpreter =
    options.archive ||
    archive([
      { path: 'python', type: 'Directory', mode: 0o700 },
      { path: 'python/bin', type: 'Directory', mode: 0o700 },
      { path: 'python/bin/python3.12', data: 'pinned interpreter fixture', mode: 0o700 },
      { path: 'python/lib', type: 'Directory', mode: 0o700 },
      { path: 'python/lib/stdlib.txt', data: 'pinned standard library' },
      ...(process.platform === 'win32'
        ? []
        : [{ path: 'python/bin/python3', type: 'SymbolicLink', linkpath: 'python3.12' }]),
    ]);
  const wheel = Buffer.from('pinned wheel fixture');
  const asset = {
    id: 'viewer-python',
    label: 'Viewer Python',
    version: '1.0.0',
    purpose: 'viewer',
    viewer: 'drawing',
    environment: 'INDUSTRIAL_HARNESS_VIEWER_PYTHON',
    pythonVersion: '3.12.15',
    modules: ['shapes.db', 'shapes.lay'],
    probe: 'print("OWNER_DRAWING_PROBE")',
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        interpreter: {
          url: 'https://official.example/python.tar.gz',
          sha256: digest(interpreter),
          size: interpreter.length,
          executable: 'python/bin/python3.12',
          format: 'tar.gz',
        },
        wheels: [
          {
            name: 'shapes',
            version: '1.2.3',
            filename: 'shapes-1.2.3-py3-none-any.whl',
            url: 'https://official.example/shapes.whl',
            sha256: digest(wheel),
            size: wheel.length,
          },
        ],
        installedSize: 1024 ** 2,
      },
    },
  };
  const calls = [],
    commands = [];
  const manager = new PythonEnvironmentManager({
    directory: path.join(root, 'managed'),
    space: () => 2 * 1024 ** 3,
    fetch: async (url, request) => {
      calls.push({ url, request });
      if (options.fetch) return options.fetch(url, request);
      const data = url.endsWith('shapes.whl') ? wheel : interpreter;
      return new Response(data, { headers: { 'content-length': String(data.length) } });
    },
    command: async (executable, args, settings) => {
      commands.push({ executable, args, settings });
      if (options.command) return options.command(executable, args, settings);
      if (args.includes('pip')) {
        const requirements = fs.readFileSync(args.at(-1), 'utf8');
        assert.match(requirements, /^shapes @ file:\/\/\/.+ --hash=sha256:[a-f0-9]{64}\n$/);
        const packageFile = path.join(
          path.dirname(path.dirname(executable)),
          'lib',
          'installed-package.so',
        );
        fs.writeFileSync(packageFile, 'pinned package extension');
      }
      return 'HARNESS_PYTHON_PROBE_OK\n';
    },
    ...options.manager,
  });
  return {
    root,
    asset,
    manager,
    calls,
    commands,
    interpreter,
    wheel,
    target: asset.platforms[manager.platform],
  };
}

test('readiness, resolution and empty preparation are read-only and offline', async t => {
  const f = fixture(t);
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.equal(f.manager.resolve([f.asset], 'drawing'), undefined);
  assert.deepEqual(f.manager.environment([f.asset]), {});
  assert.deepEqual(await f.manager.ensure([]), []);
  assert.equal(fs.existsSync(f.manager.directory), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.commands.length, 0);
  f.manager.space = () => 0;
  await assert.rejects(f.manager.ensure([f.asset]), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(f.manager.directory), false);
});

test('pinned downloads install privately, run isolated local pip and probe before and after relocation', async t => {
  const f = fixture(t);
  const progress = [];
  const original = {
    PYTHONPATH: process.env.PYTHONPATH,
    PIP_INDEX_URL: process.env.PIP_INDEX_URL,
    UV_INDEX_URL: process.env.UV_INDEX_URL,
  };
  Object.assign(process.env, {
    PYTHONPATH: '/untrusted',
    PIP_INDEX_URL: 'https://untrusted.invalid',
    UV_INDEX_URL: 'https://untrusted.invalid',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const result = await f.manager.ensure([f.asset], { onProgress: item => progress.push(item) });
  assert.equal(result[0].ready, true);
  assert.equal(f.calls.length, 2);
  const executable = f.manager.resolve([f.asset], 'drawing');
  assert.equal(executable, result[0].executable);
  assert.deepEqual(f.manager.environment([f.asset]), {
    INDUSTRIAL_HARNESS_VIEWER_PYTHON: executable,
  });
  assert.equal(f.commands.filter(command => command.args.includes('pip')).length, 1);
  assert.equal(
    f.commands.filter(command => command.args.at(-1).includes('HARNESS_PYTHON_PROBE_OK')).length,
    2,
  );
  assert.equal(
    f.commands.filter(command => command.args.at(-1).includes('OWNER_DRAWING_PROBE')).length,
    2,
  );
  assert.ok(f.commands.some(command => command.executable.includes('.staging-')));
  assert.ok(f.commands.some(command => command.executable === executable));
  for (const command of f.commands) {
    assert.deepEqual(command.args.slice(0, 2), ['-I', '-B']);
    assert.equal(command.settings.env.PYTHONPATH, undefined);
    assert.equal(command.settings.env.PIP_INDEX_URL, undefined);
    assert.equal(command.settings.env.UV_INDEX_URL, undefined);
    assert.equal(command.settings.env.PIP_CONFIG_FILE, os.devNull);
    assert.equal(command.settings.env.QT_QPA_PLATFORM, 'offscreen');
  }
  const pip = f.commands.find(command => command.args.includes('pip'));
  for (const flag of [
    '--isolated',
    '--no-index',
    '--no-deps',
    '--only-binary=:all:',
    '--require-hashes',
    '--no-compile',
  ])
    assert.ok(pip.args.includes(flag));
  assert.ok(progress.some(item => item.phase === 'ready'));
  assert.equal(fs.lstatSync(f.manager.directory).isDirectory(), true);
  // Windows reports emulated mode bits rather than POSIX access permissions.
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.manager.directory).mode & 0o077, 0);
  f.calls.length = 0;
  f.commands.length = 0;
  assert.equal((await f.manager.ensure([f.asset]))[0].ready, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.commands.length, 0);
  assert.equal(f.manager.estimate([f.asset]).downloadBytes, 0);
  assert.equal(f.manager.estimate([f.asset]).cacheReused, true);
});

test('deleted extensions are detected and repaired from verified offline cache', async t => {
  const f = fixture(t);
  await f.manager.ensure([f.asset]);
  const directory = f.manager.location(f.asset);
  fs.rmSync(path.join(directory, 'python/lib/installed-package.so'));
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  f.manager.fetch = async () => assert.fail('repair must reuse verified archive and wheel');
  const result = await f.manager.ensure([f.asset], { recheck: true });
  assert.equal(result[0].ready, true);
  assert.equal(
    fs.readFileSync(path.join(directory, 'python/lib/installed-package.so'), 'utf8'),
    'pinned package extension',
  );
});

test('recheck verifies all content hashes even if size and mtime were preserved', async t => {
  const f = fixture(t);
  await f.manager.ensure([f.asset]);
  const file = path.join(f.manager.location(f.asset), 'python/lib/stdlib.txt');
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 120));
  // Preserve the cheap metadata identity in the receipt to exercise the full
  // hash check independently of filesystem timestamp rounding differences.
  const receiptFile = path.join(f.manager.location(f.asset), 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.files.find(entry => entry.path === 'python/lib/stdlib.txt').mtime =
    fs.statSync(file).mtimeMs;
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  await f.manager.ensure([f.asset], { recheck: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'pinned standard library');
});

test('a failed old probe followed by failed repair preserves bytes but persists needs-repair', async t => {
  const f = fixture(t);
  await f.manager.ensure([f.asset]);
  const previous = fs.readFileSync(path.join(f.manager.location(f.asset), 'receipt.json'), 'utf8');
  let oldProbeFailed = false;
  f.manager.command = async (executable, args) => {
    if (args.includes('pip')) return '';
    if (!executable.includes('.staging-')) {
      oldProbeFailed = true;
      throw Error('final interpreter probe failed');
    }
    return 'HARNESS_PYTHON_PROBE_OK';
  };
  await assert.rejects(
    f.manager.ensure([f.asset], { recheck: true }),
    /final interpreter probe failed/,
  );
  assert.equal(oldProbeFailed, true);
  assert.equal(
    fs.readFileSync(path.join(f.manager.location(f.asset), 'receipt.json'), 'utf8'),
    previous,
  );
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.match(f.manager.status([f.asset])[0].reason, /needs repair/);
  const restarted = new PythonEnvironmentManager({ directory: f.manager.directory });
  assert.equal(restarted.status([f.asset])[0].ready, false);
  assert.equal(restarted.resolve([f.asset], 'drawing'), undefined);
  f.manager.command = async () => 'HARNESS_PYTHON_PROBE_OK';
  assert.equal((await f.manager.ensure([f.asset], { recheck: true }))[0].ready, true);
  assert.equal(fs.existsSync(path.join(f.manager.location(f.asset), '.needs-repair')), false);
  assert.ok(
    !fs.readdirSync(f.manager.directory).some(name => /^\.(staging|pip|probe)-/.test(name)),
  );
});

test('hash mismatch, stream overflow, HTTPS downgrade and foreign redirects fail without readiness', async t => {
  for (const mode of ['hash', 'overflow', 'downgrade', 'foreign']) {
    const f = fixture(t, {
      fetch: async () => {
        if (mode === 'hash') return new Response(Buffer.alloc(20));
        if (mode === 'overflow')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.alloc(1024 ** 2));
                controller.close();
              },
            }),
          );
        return new Response(null, {
          status: 302,
          headers: {
            location:
              mode === 'downgrade'
                ? 'http://official.example/file'
                : 'https://foreign.invalid/file',
          },
        });
      },
    });
    await assert.rejects(f.manager.ensure([f.asset]), /SHA-256|size|HTTPS|origin/);
    assert.equal(f.manager.status([f.asset])[0].ready, false);
    assert.equal(f.commands.length, 0);
    assert.ok(!fs.readdirSync(f.manager.directory).some(name => name.startsWith('.staging-')));
    assert.ok(
      !fs
        .readdirSync(path.join(f.manager.directory, 'downloads'))
        .some(name => name.endsWith('.partial')),
    );
  }
});

test('GitHub release redirects are limited and retain pinned content identity', async t => {
  let redirect = false;
  const f = fixture(t, {
    fetch: async url => {
      if (url.startsWith('https://github.com/')) {
        redirect = true;
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/file?signature=pinned',
          },
        });
      }
      return new Response(url.includes('shapes') ? f.wheel : f.interpreter);
    },
  });
  f.target.interpreter.url =
    'https://github.com/official/python/releases/download/v1/python.tar.gz';
  assert.equal((await f.manager.ensure([f.asset]))[0].ready, true);
  assert.equal(redirect, true);
  const repeated = fixture(t, {
    fetch: async () => new Response(null, { status: 302, headers: { location: '/again' } }),
  });
  await assert.rejects(repeated.manager.ensure([repeated.asset]), /too many redirects/);
  assert.equal(repeated.calls.length, 6);
});

test('archive traversal, escaping links, link descendants and special files are rejected before execution', async t => {
  for (const entries of [
    [{ path: '../escape', data: 'outside' }],
    [{ path: '/absolute', data: 'outside' }],
    [{ path: 'python/link', type: 'SymbolicLink', linkpath: '../../outside' }],
    [{ path: 'python/link', type: 'Link', linkpath: '../outside' }],
    [
      { path: 'python/link', type: 'SymbolicLink', linkpath: 'safe' },
      { path: 'python/link/child', data: 'unsafe' },
      { path: 'python/safe', type: 'Directory' },
    ],
    [{ path: 'python/device', type: 'CharacterDevice' }],
    [
      { path: 'python/file', data: 'first' },
      { path: 'python/file', data: 'duplicate' },
    ],
  ]) {
    const f = fixture(t, { archive: archive(entries) });
    await assert.rejects(
      f.manager.ensure([f.asset]),
      /Unsafe|unsafe|escaping|internal|link|special|duplicate|absolute/i,
    );
    assert.equal(f.commands.length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
  }
});

test('internal links and interpreter aliases remain contained and preserve file identity', async t => {
  // Hardlinks are unprivileged on Windows as well as POSIX. Exercise real tar
  // validation/extraction, not an adapter that pretends to create a symlink.
  const linked = fixture(t, {
    archive: archive([
      { path: 'python', type: 'Directory', mode: 0o700 },
      { path: 'python/bin', type: 'Directory', mode: 0o700 },
      { path: 'python/bin/python3.12', data: 'pinned interpreter fixture', mode: 0o700 },
      { path: 'python/bin/python3', type: 'Link', linkpath: 'python/bin/python3.12' },
      { path: 'python/lib', type: 'Directory', mode: 0o700 },
      { path: 'python/lib/stdlib.txt', data: 'pinned standard library' },
    ]),
  });
  linked.target.interpreter.executable = 'python/bin/python3';
  assert.equal((await linked.manager.ensure([linked.asset]))[0].ready, true);
  const alias = linked.manager.resolve([linked.asset], 'drawing');
  const target = path.join(path.dirname(alias), 'python3.12');
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), false);
  assert.equal(fs.statSync(alias).ino, fs.statSync(target).ino);
  assert.ok(fs.statSync(alias).nlink >= 2);
  fs.writeFileSync(alias, 'changed through the actual hardlink');
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed through the actual hardlink');
  assert.equal(linked.manager.status([linked.asset])[0].ready, false);

  if (process.platform !== 'win32') {
    const relative = fixture(t);
    relative.target.interpreter.executable = 'python/bin/python3';
    assert.equal((await relative.manager.ensure([relative.asset]))[0].ready, true);
    const executable = relative.manager.resolve([relative.asset], 'drawing');
    assert.equal(fs.lstatSync(executable).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(executable), 'python3.12');
    assert.equal(fs.realpathSync(executable), path.join(path.dirname(executable), 'python3.12'));
  }
});

test('replaced stores or cache parents cannot redirect installation writes', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.manager.directory);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(
    outside,
    path.join(f.manager.directory, 'downloads'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(fs.lstatSync(path.join(f.manager.directory, 'downloads')).isSymbolicLink(), true);
  await assert.rejects(f.manager.ensure([f.asset]), /link/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(f.commands.length, 0);
  assert.throws(
    () => new PythonEnvironmentManager({ directory: path.join(f.manager.directory, 'downloads') }),
    /link/,
  );
});

test('cancelled or stalled downloads discard partial files and release preparation ownership', async t => {
  const f = fixture(t, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        }),
      ),
  });
  const controller = new AbortController();
  const pending = f.manager.ensure([f.asset], { signal: controller.signal });
  setTimeout(() => controller.abort(Error('cancelled fixture')), 10);
  await assert.rejects(pending, /cancelled fixture/);
  assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
  await assert.rejects(f.manager.ensure([f.asset], { stallMs: 10 }), /stalled/);
  assert.ok(
    !fs
      .readdirSync(path.join(f.manager.directory, 'downloads'))
      .some(name => name.endsWith('.partial')),
  );
});

test('declarations reject unsafe paths, missing pins, duplicate names and excessive downloads', t => {
  const f = fixture(t);
  for (const mutate of [
    a => {
      a.platforms[f.manager.platform].interpreter.executable = '../outside';
    },
    a => {
      a.platforms[f.manager.platform].interpreter.url = 'http://official.example/file';
    },
    a => {
      a.platforms[f.manager.platform].wheels[0].sha256 = '';
    },
    a => {
      a.modules = ['valid; import os'];
    },
    a => {
      a.pythonVersion = '3.12';
    },
    a => {
      a.probe = 'x'.repeat(16385);
    },
    a => {
      a.platforms[f.manager.platform].wheels.push({ ...a.platforms[f.manager.platform].wheels[0] });
    },
    a => {
      a.platforms[f.manager.platform].wheels[0].filename = '../sample.whl';
    },
  ]) {
    const copy = structuredClone(f.asset);
    mutate(copy);
    assert.throws(() => validatePythonEnvironments([copy]));
  }
  const assets = Array.from({ length: 5 }, (_, i) => {
    const copy = structuredClone(f.asset);
    copy.id += i;
    copy.environment += i;
    copy.platforms[f.manager.platform].interpreter.size = 128 * 1024 ** 2;
    copy.platforms[f.manager.platform].interpreter.sha256 = String(i).repeat(64);
    return copy;
  });
  assert.throws(() => f.manager.estimate(assets), /total size limit/);
  assert.equal(f.calls.length, 0);
});

test('actual child failure and cancellation leave no activated receipt', async t => {
  const failed = fixture(t, {
    manager: {
      command: (executable, args, settings) => {
        assert.ok(fs.existsSync(executable));
        assert.ok(args.includes('pip'));
        return run(
          process.execPath,
          ['-e', 'process.stderr.write("actual-child-failure"); process.exit(7);'],
          settings,
        );
      },
    },
  });
  // The command adapter substitutes Node for fixture interpreter bytes while
  // retaining the production bounded runner's real exit/cancellation lifecycle.
  await assert.rejects(
    failed.manager.ensure([failed.asset]),
    /failed \(7\).*|actual-child-failure/s,
  );
  assert.equal(failed.manager.status([failed.asset])[0].ready, false);
  let startedFile;
  const slow = fixture(t, {
    manager: {
      command: (executable, args, settings) => {
        assert.ok(fs.existsSync(executable));
        assert.ok(args.includes('pip'));
        return run(
          process.execPath,
          [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
            startedFile,
          ],
          settings,
        );
      },
    },
  });
  startedFile = path.join(slow.root, 'child-started');
  const controller = new AbortController();
  const pending = slow.manager.ensure([slow.asset], { signal: controller.signal });
  t.after(async () => {
    controller.abort(Error('child test cleanup'));
    await pending.catch(() => {});
  });
  const started = new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (fs.existsSync(startedFile)) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(Error('actual child did not start'));
    }, 5000);
    t.after(() => {
      clearInterval(poll);
      clearTimeout(timeout);
    });
  });
  await Promise.race([started, pending]);
  const pid = Number(fs.readFileSync(startedFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  controller.abort(Error('actual child cancelled'));
  await assert.rejects(pending, /actual child cancelled/);
  assert.equal(slow.manager.status([slow.asset])[0].ready, false);
  assert.equal(fs.existsSync(path.join(slow.manager.directory, 'prepare.lock')), false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('failed new declaration keeps an independently valid previous runtime ready', async t => {
  const f = fixture(t);
  await f.manager.ensure([f.asset]);
  const previous = f.manager.resolve([f.asset], 'drawing');
  const replacement = structuredClone(f.asset);
  replacement.version = '2.0.0';
  f.manager.command = async executable => {
    if (!executable.includes('.staging-')) throw Error('replacement cannot run after relocation');
    return 'HARNESS_PYTHON_PROBE_OK';
  };
  await assert.rejects(f.manager.ensure([replacement]), /replacement cannot run/);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.manager.resolve([f.asset], 'drawing'), previous);
  assert.equal(f.manager.status([replacement])[0].ready, false);
});

test('resolve reuses bounded cross-manager validation and invalidates receipt or interpreter changes', async t => {
  const f = fixture(t);
  await f.manager.ensure([f.asset]);
  const executable = f.manager.resolve([f.asset], 'drawing');
  const directory = f.manager.location(f.asset),
    receipt = path.join(directory, 'receipt.json');
  const original = fs.readdirSync;
  let walks = 0;
  fs.readdirSync = (file, ...args) => {
    if (String(file).startsWith(directory)) walks++;
    return original(file, ...args);
  };
  try {
    for (let i = 0; i < 50; i++) {
      const fresh = new PythonEnvironmentManager({ directory: f.manager.directory });
      assert.equal(fresh.resolve([f.asset], 'drawing'), executable);
    }
    assert.equal(walks, 0, 'render-time resolution must not rescan the Python tree');
    fs.appendFileSync(receipt, '\n');
    assert.equal(f.manager.resolve([f.asset], 'drawing'), executable);
    assert.ok(walks > 0, 'a changed receipt requires a fresh full validation');
    fs.appendFileSync(executable, '# changed executable\n');
    assert.equal(f.manager.resolve([f.asset], 'drawing'), undefined);
    assert.equal(f.manager.status([f.asset])[0].ready, false);
    fs.rmSync(receipt);
    assert.equal(f.manager.resolve([f.asset], 'drawing'), undefined);
  } finally {
    fs.readdirSync = original;
  }
});

test('full readiness invalidates a fast resolution when a module disappears', async t => {
  const f = fixture(t);
  await f.manager.ensure([f.asset]);
  assert.ok(f.manager.resolve([f.asset], 'drawing'));
  fs.rmSync(path.join(f.manager.location(f.asset), 'python/lib/installed-package.so'));
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.equal(f.manager.resolve([f.asset], 'drawing'), undefined);
});

test('the shared preparation lock blocks competing managers and is released after cancellation', async t => {
  let started;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  const f = fixture(t, {
    fetch: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const pending = f.manager.ensure([f.asset], { signal: controller.signal });
  await waiting;
  const competing = new PythonEnvironmentManager({
    directory: f.manager.directory,
    space: () => 2 * 1024 ** 3,
  });
  await assert.rejects(competing.ensure([f.asset]), /already in progress/);
  controller.abort(Error('cancel locked download'));
  await assert.rejects(pending, /cancel locked download/);
  assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
});

test('ready reuse needs no disk writes and recheck failure budgets the full replacement', async t => {
  const f = fixture(t);
  f.target.installedSize = 256 * 1024 ** 2;
  await f.manager.ensure([f.asset]);
  f.manager.space = () => 0;
  assert.equal((await f.manager.ensure([f.asset]))[0].ready, true);
  f.manager.space = () => 128 * 1024 ** 2;
  f.manager.command = async () => {
    throw Error('old runtime probe failed');
  };
  f.calls.length = 0;
  await assert.rejects(f.manager.ensure([f.asset], { recheck: true }), { code: 'ENOSPC' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
});

test('cancellation during validated extraction waits for file writes before removing staging', async t => {
  const f = fixture(t);
  const controller = new AbortController(),
    original = fs.createReadStream;
  let reads = 0;
  fs.createReadStream = (file, ...args) => {
    const stream = original(file, ...args);
    if (String(file) === f.manager.cache(f.target.interpreter) && ++reads === 2)
      queueMicrotask(() => controller.abort(Error('cancel actual extraction')));
    return stream;
  };
  try {
    await assert.rejects(
      f.manager.ensure([f.asset], { signal: controller.signal }),
      /cancel actual extraction/,
    );
    assert.equal(reads, 2);
    assert.equal(f.commands.length, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!fs.readdirSync(f.manager.directory).some(name => name.startsWith('.staging-')));
    assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
  } finally {
    fs.createReadStream = original;
  }
});
