const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeAssetManager, validateRuntimeAssets } = require('./runtime-assets.cjs');
const { PackManager, createArchive, digest } = require('./index.cjs');

async function waitForChildPid(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(file, 'utf8').trim();
      const pid = Number(content);
      if (/^[1-9]\d*$/.test(content) && Number.isSafeInteger(pid)) return pid;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Installer child PID was not published in ${file}.`);
}

async function assertChildReaped(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Reaping requires an actual child PID');
  // macOS CI can still observe the PID immediately after the child's close
  // event. Bound the reaping check; a live/leaked child must still fail.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Installer child ${pid} remains observable after close.`);
}

test('installer readiness waits for PID content instead of accepting an empty file as process group zero', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-child-pid-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ready = path.join(directory, 'child.ready');
  let resolved = false;
  const waiting = waitForChildPid(ready).then(pid => {
    resolved = true;
    return pid;
  });
  // A readiness file becomes visible when the writer opens it, before its PID
  // bytes arrive. An empty read must not become Number('') === 0.
  fs.writeFileSync(ready, '');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'Creating the file does not publish a child PID');
  fs.writeFileSync(ready, '0');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'PID zero addresses a process group, not the child');
  fs.writeFileSync(ready, String(process.pid));
  assert.equal(await waiting, process.pid);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-toolchain-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('pinned vendor disk image');
  const asset = {
    id: 'modeler',
    label: 'Modeler',
    version: '1.2.3',
    type: 'macos-app-dmg',
    platform: 'darwin-arm64',
    url: 'https://vendor.example/runtime.dmg',
    sha256: digest(bytes),
    size: bytes.length,
    app: 'Modeler.app',
    executable: 'Contents/bin/modeler',
    environment: 'INDUSTRIAL_HARNESS_MODELER_CMD',
    versionArgs: ['--version'],
    versionText: '1.2.3',
    profileEnvironment: {},
  };
  const events = [],
    commands = [];
  let imports = 0,
    wrongVersion = false;
  const command = async (file, args) => {
    commands.push([file, args]);
    if (file.endsWith('/hdiutil') && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1];
      const executable = path.join(mount, asset.app, asset.executable);
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, 'vendor executable');
    } else if (file.endsWith('/hdiutil') && args[0] === 'detach')
      fs.rmSync(path.join(args[1], asset.app), { recursive: true });
    else if (file.endsWith('/ditto')) fs.cpSync(args[0], args[1], { recursive: true });
    else if (path.basename(file) === 'modeler') return wrongVersion ? '1.0.0' : 'Modeler 1.2.3';
    return '';
  };
  // The official archive the user downloaded in their browser.
  const download = path.join(directory, 'official-download.dmg');
  fs.writeFileSync(download, bytes);
  const manager = new RuntimeAssetManager({
    directory,
    platform: 'darwin-arm64',
    command,
  });
  const importArchive = manager.importArchive.bind(manager);
  manager.importArchive = async (item, file) => {
    imports++;
    return importArchive(item, file);
  };
  return {
    directory,
    manager,
    asset,
    events,
    commands,
    download,
    import: (item = asset, file = download) => manager.importArchive(item, file),
    options: { onProgress: state => events.push(state) },
    downloads: () => imports,
    wrongVersion: () => {
      wrongVersion = true;
    },
  };
}
test('managed vendor app is verified, probed, detached and reused; deleted executable can be repaired from verified cache', async t => {
  const f = fixture(t);
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  await f.import();
  await f.manager.ensure([f.asset], f.options);
  const status = f.manager.status([f.asset])[0];
  assert.equal(status.ready, true);
  assert.ok(status.executable.startsWith(f.directory));
  assert.equal(f.manager.environment([f.asset]).INDUSTRIAL_HARNESS_MODELER_CMD, status.executable);
  assert.ok(f.commands.some(([file]) => file.endsWith('/codesign')));
  assert.ok(f.commands.some(([file, args]) => file.endsWith('/hdiutil') && args[0] === 'detach'));
  await f.manager.ensure([f.asset]);
  assert.equal(f.downloads(), 1);
  fs.rmSync(status.executable);
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  await f.manager.ensure([f.asset]);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.downloads(), 1);
});
test('corrupt or mismatched imports are rejected before anything mounts or executes', async t => {
  const f = fixture(t);
  const corrupt = path.join(f.directory, 'corrupt.dmg');
  fs.writeFileSync(corrupt, Buffer.alloc(f.asset.size, 1));
  await assert.rejects(f.import(f.asset, corrupt), /does not match the pinned official release/);
  const undersized = path.join(f.directory, 'undersized.dmg');
  fs.writeFileSync(undersized, 'wrong bytes');
  await assert.rejects(f.import(f.asset, undersized), /size differs/);
  await assert.rejects(f.import(f.asset, f.directory), /Choose the downloaded/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
});
test('a missing archive stops installation with official-source guidance', async t => {
  const f = fixture(t);
  await assert.rejects(f.manager.ensure([f.asset]), error => {
    assert.equal(error.code, 'RUNTIME_ARCHIVE_REQUIRED');
    assert.equal(error.asset.id, f.asset.id);
    assert.equal(error.asset.url, f.asset.url);
    assert.match(error.message, /Download the official release/);
    return true;
  });
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
  await f.import();
  await f.manager.ensure([f.asset]);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
});
test('archive requirements report presence for the download picker', async t => {
  const f = fixture(t);
  assert.deepEqual(
    f.manager.archives([f.asset]).map(({ id, present }) => ({ id, present })),
    [{ id: f.asset.id, present: false }],
  );
  await f.import();
  const [state] = f.manager.archives([f.asset]);
  assert.equal(state.present, true);
  assert.equal(state.size, f.asset.size);
  assert.equal(state.url, f.asset.url);
  // Importing the same verified bytes again is an idempotent reuse.
  const again = await f.import();
  assert.equal(again.reused, true);
});
test('failed native probe cleans staging and mount and preserves a previous usable version', async t => {
  const f = fixture(t);
  await f.import();
  await f.manager.ensure([f.asset]);
  f.wrongVersion();
  const newer = { ...f.asset, version: '1.2.4' };
  await assert.rejects(f.manager.ensure([newer]), /version check/);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.manager.status([newer])[0].ready, false);
  assert.ok(f.commands.some(([file, args]) => file.endsWith('/hdiutil') && args[0] === 'detach'));
  assert.ok(
    !fs
      .readdirSync(path.dirname(f.manager.location(newer)))
      .some(name => name.startsWith('.staging')),
  );
});
test('asynchronous preparation keeps a cross-process lock until completion', async t => {
  const f = fixture(t);
  await f.import();
  let resume, entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const original = f.manager.command;
  f.manager.command = async (file, args, options) => {
    if (file.endsWith('/hdiutil') && args[0] === 'attach') {
      entered();
      await new Promise(resolve => {
        resume = resolve;
      });
    }
    return original(file, args, options);
  };
  const active = f.manager.ensure([f.asset]);
  await started;
  await assert.rejects(f.manager.ensure([f.asset]), /already in progress/);
  resume();
  await active;
  assert.equal(f.manager.status([f.asset])[0].ready, true);
});
test('runtime metadata rejects shell paths, unsafe variables and unsupported installers', () => {
  for (const asset of [
    { id: '../../escape' },
    { type: 'shell-script' },
    { app: '../Bad.app' },
    { environment: 'HOME' },
  ])
    assert.throws(() => validateRuntimeAssets([asset]), /Invalid/);
});
test('Core bundled catalog is bounded and a failed toolchain update keeps active Pack unchanged', async t => {
  const f = fixture(t),
    resources = path.join(f.directory, 'core');
  fs.mkdirSync(resources);
  function bundle(version) {
    const source = path.join(f.directory, version);
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, 'bundle.json'),
      JSON.stringify({
        schemaVersion: 1,
        domain: 'modeling',
        label: 'Modeling',
        emoji: 'M',
        version,
        coreApi: 1,
        skills: [],
        capabilities: [],
        providerPacks: [],
        runtimeAssets: [f.asset],
      }),
    );
    const bytes = createArchive(source),
      url = `modeling-${version}.hpack`;
    fs.writeFileSync(path.join(resources, url), bytes);
    return {
      domain: 'modeling',
      version,
      sha256: digest(bytes),
      size: bytes.length,
      url,
      platforms: [`${process.platform}-${process.arch}`],
    };
  }
  const entries = [bundle('1.0.0'), bundle('1.0.1')];
  fs.writeFileSync(
    path.join(resources, 'catalog.unsigned.json'),
    JSON.stringify({ schemaVersion: 1, packs: entries }),
  );
  const manager = new PackManager({ directory: path.join(f.directory, 'packs') });
  const catalog = manager.bundledCatalog(resources);
  manager.runtimeAssets = f.manager;
  await f.import();
  await manager.install(catalog.packs[0], { prepareRuntime: true });
  manager.runtimeAssets.ensure = async () => {
    throw Error('vendor offline');
  };
  await assert.rejects(
    manager.install(catalog.packs[1], { prepareRuntime: true }),
    /vendor offline/,
  );
  assert.equal(manager.list()[0].version, '1.0.0');
  fs.writeFileSync(path.join(resources, entries[1].url), 'tampered');
  await assert.rejects(manager.install(catalog.packs[1]), /hash mismatch/);
  await assert.rejects(manager.install({ ...catalog.packs[0] }), /verified catalog/);
});

test('declared nested vendor app and extra executable environment survive integrity checks', async t => {
  const f = fixture(t);
  f.asset.archiveApp = 'Vendor Suite/Modeler.app';
  f.asset.installedSize = 4096;
  f.asset.environmentExecutables = { INDUSTRIAL_HARNESS_MODELER_PYTHON: 'Contents/bin/python' };
  const original = f.manager.command;
  f.manager.command = async (file, args, options) => {
    if (file.endsWith('/hdiutil') && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1];
      const root = path.join(mount, f.asset.archiveApp);
      fs.mkdirSync(path.join(root, 'Contents/bin'), { recursive: true });
      fs.writeFileSync(path.join(root, f.asset.executable), 'vendor executable');
      fs.writeFileSync(path.join(root, 'Contents/bin/python'), 'vendor interpreter');
      return '';
    }
    if (file.endsWith('/hdiutil') && args[0] === 'detach') {
      fs.rmSync(path.join(args[1], 'Vendor Suite'), { recursive: true });
      return '';
    }
    return original(file, args, options);
  };
  await f.import();
  await f.manager.ensure([f.asset], f.options);
  const environment = f.manager.environment([f.asset]);
  assert.match(
    environment.INDUSTRIAL_HARNESS_MODELER_PYTHON,
    /Modeler\.app[/\\]Contents[/\\]bin[/\\]python$/,
  );
  assert.deepEqual(
    f.events.map(event => event.phase),
    [
      'verifying',
      'checking-space',
      'verifying',
      'mounting',
      'copying',
      'checking',
      'activating',
      'ready',
    ],
  );
  fs.writeFileSync(environment.INDUSTRIAL_HARNESS_MODELER_PYTHON, 'damaged');
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  assert.equal(f.manager.environment([f.asset]).INDUSTRIAL_HARNESS_MODELER_CMD, '');
  await f.manager.ensure([f.asset]);
  assert.equal(f.downloads(), 1);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
});

test('space preflight prevents installation and preserves previous runtime on full disk', async t => {
  const f = fixture(t);
  await f.import();
  await f.manager.ensure([f.asset]);
  f.manager.space = () => 1;
  await assert.rejects(
    f.manager.ensure([{ ...f.asset, version: '1.2.4' }]),
    error => error.code === 'ENOSPC' && error.requiredBytes > error.availableBytes,
  );
  assert.equal(f.downloads(), 1);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(fs.existsSync(path.join(f.manager.directory, 'prepare.lock')), false);
});

test('cancel after copying cleans staging and keeps verified cache and previous version', async t => {
  const f = fixture(t);
  await f.import();
  await f.manager.ensure([f.asset]);
  const controller = new AbortController();
  const newer = { ...f.asset, version: '1.2.4' };
  await assert.rejects(
    f.manager.ensure([newer], {
      signal: controller.signal,
      onProgress: event => {
        if (event.phase === 'checking') controller.abort(Error('User cancelled'));
      },
    }),
    /cancel/i,
  );
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.manager.status([newer])[0].ready, false);
  assert.equal(f.downloads(), 1);
  assert.ok(
    !fs.readdirSync(path.dirname(f.manager.location(newer))).some(file => file.startsWith('.')),
  );
  await f.manager.ensure([newer]);
  assert.equal(f.manager.status([newer])[0].ready, true);
  assert.equal(f.downloads(), 1);
});

test('escaping app links and wrong signatures are refused before native probe and activation', async t => {
  for (const mode of ['link', 'signature']) {
    const f = fixture(t),
      original = f.manager.command;
    await f.import();
    let probed = false;
    f.manager.command = async (file, args, options) => {
      if (path.basename(file) === 'modeler') probed = true;
      if (file.endsWith('/codesign') && mode === 'signature')
        throw Error('Invalid vendor signature');
      const result = await original(file, args, options);
      if (file.endsWith('/ditto') && mode === 'link')
        fs.symlinkSync(f.directory, path.join(args[1], 'escaped'), 'junction');
      return result;
    };
    await assert.rejects(f.manager.ensure([f.asset]), /escaping|signature/);
    assert.equal(probed, false);
    assert.equal(f.manager.status([f.asset])[0].ready, false);
  }
});

test('runtime metadata rejects conflicting environments and invalid footprint or app source', t => {
  const f = fixture(t);
  for (const change of [
    { installedSize: -1 },
    { installedSize: 33 * 1024 ** 3 },
    { archiveApp: '../Modeler.app' },
    { archiveApp: '/Modeler.app' },
    { environmentExecutables: { HOME: 'Contents/bin/python' } },
    { environmentExecutables: { INDUSTRIAL_HARNESS_MODELER_CMD: 'Contents/bin/other' } },
    { environmentExecutables: { INDUSTRIAL_HARNESS_OTHER: '../outside' } },
  ])
    assert.throws(() => validateRuntimeAssets([{ ...f.asset, ...change }]), /Invalid/);
});

test('footprint-only recipe updates reuse legacy receipts and cannot invalidate the active runtime', async t => {
  const f = fixture(t);
  await f.import();
  await f.manager.ensure([f.asset]);
  const original = f.manager.location(f.asset);
  const metadataUpdate = { ...f.asset, installedSize: 4096 };
  assert.equal(f.manager.location(metadataUpdate), original);
  assert.equal(f.manager.status([metadataUpdate])[0].ready, true);
  const commandsBefore = f.commands.length;
  await f.manager.ensure([metadataUpdate]);
  assert.equal(f.commands.length, commandsBefore);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.downloads(), 1);
});

test('changed execution recipes remain isolated if Pack activation is cancelled or fails', async t => {
  const f = fixture(t);
  await f.import();
  await f.manager.ensure([f.asset]);
  const original = f.manager.location(f.asset);
  const changed = { ...f.asset, profileEnvironment: { XDG_CONFIG_HOME: 'home' } };
  assert.notEqual(f.manager.location(changed), original);
  const controller = new AbortController();
  await assert.rejects(
    f.manager.ensure([changed], {
      signal: controller.signal,
      onProgress: event => {
        if (event.phase === 'activating')
          controller.abort(Error('Cancelled before Pack activation'));
      },
    }),
    /Cancelled/,
  );
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  await f.manager.ensure([changed]);
  // This represents a later Pack-level cancellation/failure: the old declaration
  // still resolves to its unchanged executable and receipt.
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.manager.status([changed])[0].ready, true);
  assert.equal(f.manager.location(f.asset), original);
  assert.equal(f.downloads(), 1);
});

test('retry space checks subtract verified runtime archives before deciding disk is full', async t => {
  const f = fixture(t);
  f.asset.installedSize = 4096;
  await f.import();
  await f.manager.ensure([f.asset]);
  const executable = f.manager.status([f.asset])[0].executable;
  fs.rmSync(executable);
  // Enough for app staging + reserve, but not enough for downloading again.
  f.manager.space = () => 64 * 1024 ** 2 + f.asset.installedSize + 1;
  const progress = [];
  await f.manager.ensure([f.asset], { onProgress: event => progress.push(event) });
  assert.ok(
    progress.some(
      event => event.phase === 'checking-space' && event.cacheReused && event.downloadBytes === 0,
    ),
  );
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.downloads(), 1);
});

test('Pack retry does not reject a cached runtime based on the conservative display estimate', async t => {
  const f = fixture(t);
  f.asset.installedSize = 4096;
  await f.import();
  await f.manager.ensure([f.asset]);
  fs.rmSync(f.manager.status([f.asset])[0].executable);
  const source = path.join(f.directory, 'source-for-retry');
  fs.mkdirSync(source);
  const manifest = JSON.stringify({
    schemaVersion: 1,
    domain: 'modeling',
    label: 'Modeling',
    emoji: 'M',
    version: '1.0.0',
    coreApi: 1,
    skills: [],
    capabilities: [],
    providerPacks: [],
    runtimeAssets: [f.asset],
  });
  fs.writeFileSync(path.join(source, 'bundle.json'), manifest);
  const bytes = createArchive(source);
  const available = 64 * 1024 ** 2 + f.asset.installedSize + 1;
  const manager = new PackManager({
    directory: path.join(f.directory, 'packs'),
    space: () => available,
  });
  manager.runtimeAssets = f.manager;
  f.manager.space = () => available;
  const entry = {
    domain: 'modeling',
    version: '1.0.0',
    size: bytes.length,
    sha256: digest(bytes),
    installedSize: Buffer.byteLength(manifest),
    runtimeAssets: [f.asset],
  };
  assert.ok(manager.estimate(entry).requiredBytes > available);
  await manager.install(entry, { bytes, allowUnsigned: true, prepareRuntime: true });
  assert.equal(manager.list()[0].domain, 'modeling');
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.downloads(), 1);
});

test('late installer abort waits for the real child to finish before reporting cancellation', async t => {
  const { run } = require('./runtime-assets.cjs');
  const f = fixture(t),
    marker = path.join(f.directory, 'child-exited'),
    ready = marker + '.ready';
  const controller = new AbortController();
  const script = `const fs=require('node:fs');
    process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv[1],'exited');process.exit(0)},150));
    fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`;
  const active = run(process.execPath, ['-e', script, marker, ready], {
    signal: controller.signal,
  });
  const pid = await waitForChildPid(ready);
  controller.abort(Error('User cancelled native preparation'));
  await assert.rejects(active, error => {
    assert.equal(error, controller.signal.reason);
    assert.match(error.message, /User cancelled/);
    return true;
  });
  // Windows terminates directly instead of dispatching the JS SIGTERM handler.
  // Check the delayed exit marker before waiting, so an early rejection cannot
  // pass merely because the child eventually exits during the reaping check.
  if (process.platform !== 'win32') assert.equal(fs.readFileSync(marker, 'utf8'), 'exited');
  await assertChildReaped(pid);
});

test(
  'native preparation timeout identifies the command with bounded output after its process exits',
  { timeout: 15000 },
  async t => {
    const { run } = require('./runtime-assets.cjs');
    const f = fixture(t),
      marker = path.join(f.directory, 'timed-out-child-exited'),
      ready = marker + '.ready';
    const script = `const fs=require('node:fs');
    process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv[1],'exited');process.exit(0)},150));
    fs.writeFileSync(process.argv[2],String(process.pid));
    process.stderr.write('discarded-prefix'+'x'.repeat(3000)+'native-command-stalled');
    setInterval(()=>{},1000);`;
    await assert.rejects(
      run(process.execPath, ['-e', script, marker, ready], {
        timeout: 1000,
        env: { ...process.env, HARNESS_TEST_PRIVATE: 'private-env-must-not-be-logged' },
      }),
      error => {
        assert.match(error.message, /Runtime preparation timed out after 1 seconds\./);
        const detail = error.message.match(/Command: ([^;]+); elapsed: (\d+) ms/);
        assert.equal(detail?.[1], path.basename(process.execPath));
        assert.ok(Number(detail[2]) >= 1000);
        assert.match(error.message, /native-command-stalled$/);
        assert.doesNotMatch(error.message, /discarded-prefix|private-env-must-not-be-logged/);
        assert.ok(error.message.length < 2200);
        return true;
      },
    );
    const pid = await waitForChildPid(ready);
    if (process.platform !== 'win32') assert.equal(fs.readFileSync(marker, 'utf8'), 'exited');
    await assertChildReaped(pid);
  },
);

test('failed native commands retain exit diagnostics and command identity', async () => {
  const { run } = require('./runtime-assets.cjs');
  await assert.rejects(
    run(process.execPath, ['-e', "process.stderr.write('vendor diagnostic');process.exit(7)"]),
    error => {
      assert.match(error.message, /Runtime preparation failed \(7\)/);
      assert.ok(error.message.includes(`Command: ${path.basename(process.execPath)}; elapsed:`));
      assert.match(error.message, /vendor diagnostic$/);
      return true;
    },
  );
});

test('an attach that partially mounts before rejecting is detached before cleanup', async t => {
  const f = fixture(t),
    original = f.manager.command;
  await f.import();
  let source,
    detached = false;
  f.manager.command = async (file, args, options) => {
    if (file.endsWith('/hdiutil') && args[0] === 'attach') {
      await original(file, args, options);
      source = args[args.indexOf('-mountpoint') + 1];
      throw Error('Cancelled while attach was finishing');
    }
    if (file.endsWith('/hdiutil') && args[0] === 'detach') {
      assert.ok(fs.existsSync(path.join(args[1], f.asset.app)));
      detached = true;
    }
    return original(file, args, options);
  };
  await assert.rejects(f.manager.ensure([f.asset]), /Cancelled/);
  assert.equal(detached, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(f.manager.status([f.asset])[0].ready, false);
});

test('a malformed runtime receipt can be repaired from cache instead of blocking path resolution', async t => {
  const f = fixture(t);
  await f.import();
  await f.manager.ensure([f.asset]);
  const location = f.manager.location(f.asset);
  fs.writeFileSync(path.join(location, 'receipt.json'), 'null');
  assert.equal(f.manager.status([f.asset])[0].ready, false);
  await f.manager.ensure([f.asset]);
  assert.equal(f.manager.status([f.asset])[0].ready, true);
  assert.equal(f.downloads(), 1);
});

test('disk-full lock writes close descriptors and release both preparation and Pack locks for retry', async t => {
  const f = fixture(t);
  await f.import();
  const pack = new PackManager({ directory: path.join(f.directory, 'packs') });
  for (const [manager, attempt, lock] of [
    [f.manager, () => f.manager.ensure([f.asset]), path.join(f.manager.directory, 'prepare.lock')],
    [pack, () => pack.withLock(() => 'locked'), path.join(pack.directory, 'install.lock')],
  ]) {
    const original = fs.writeFileSync;
    let descriptor;
    fs.writeFileSync = function (file, ...args) {
      if (typeof file === 'number') {
        descriptor = file;
        const error = Error('No disk space while recording lock owner');
        error.code = 'ENOSPC';
        throw error;
      }
      return original.call(fs, file, ...args);
    };
    try {
      await assert.rejects(async () => attempt(), { code: 'ENOSPC' });
    } finally {
      fs.writeFileSync = original;
    }
    assert.equal(fs.existsSync(lock), false);
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    await attempt();
    assert.equal(fs.existsSync(lock), false);
  }
  assert.equal(f.manager.status([f.asset])[0].ready, true);
});
