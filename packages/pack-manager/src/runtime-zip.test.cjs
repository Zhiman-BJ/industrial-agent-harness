const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { inspectRuntimeZip } = require('./runtime-zip.cjs');
const { RuntimeAssetManager } = require('./runtime-assets.cjs');
const { digest } = require('./index.cjs');

function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      bytes = Buffer.from(entry.bytes || 'fixture');
    const head = Buffer.alloc(30),
      dir = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(zlib.crc32(bytes), 14);
    head.writeUInt32LE(bytes.length, 18);
    head.writeUInt32LE(bytes.length, 22);
    head.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(0x0314, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(zlib.crc32(bytes), 16);
    dir.writeUInt32LE(bytes.length, 20);
    dir.writeUInt32LE(bytes.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((entry.mode || 0o100755) * 65536) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    local.push(head, name, bytes);
    central.push(dir, name);
    offset += head.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runtime-zip-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('ZIP preflight rejects traversal, symlinks, duplicate paths, bombs and local-header substitution', t => {
  const root = fixture(t),
    file = path.join(root, 'runtime.zip');
  const cases = [
    zip([{ name: '../outside', bytes: 'x' }]),
    zip([{ name: '/absolute', bytes: 'x' }]),
    zip([{ name: 'App.app/link', mode: 0o120777 }]),
    zip([{ name: 'App.app/x' }, { name: 'App.app/X' }]),
  ];
  const altered = zip([{ name: 'App.app/file' }]);
  altered[30] = '.'.charCodeAt(0);
  cases.push(altered);
  for (const bytes of cases) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => inspectRuntimeZip(file, 1024), /runtime ZIP/i);
  }
  fs.writeFileSync(file, zip([{ name: 'App.app/payload', bytes: 'large' }]));
  assert.throws(() => inspectRuntimeZip(file, 2), /size limit/);
  assert.deepEqual(inspectRuntimeZip(file, 1024), { installedBytes: 5, files: 1 });
});

test('ZIP installation extracts app, verifies signature/version and reuses cache after repair', async t => {
  const root = fixture(t),
    events = [],
    commands = [];
  const bytes = zip([{ name: 'Renderer.app/Contents/MacOS/Renderer', bytes: 'vendor' }]);
  const asset = {
    id: 'renderer',
    label: 'Renderer',
    version: '1.2.3',
    platform: 'darwin-arm64',
    type: 'macos-app-zip',
    url: 'https://vendor.example/renderer.zip',
    sha256: digest(bytes),
    size: bytes.length,
    installedSize: 6,
    app: 'Renderer.app',
    executable: 'Contents/MacOS/Renderer',
    environment: 'INDUSTRIAL_HARNESS_RENDERER',
    versionArgs: ['--version'],
    versionText: '1.2.3',
    profileEnvironment: {},
  };
  const manager = new RuntimeAssetManager({
    directory: root,
    platform: 'darwin-arm64',
    command: async (file, args) => {
      commands.push([file, args]);
      if (file === '/usr/bin/ditto') {
        if (process.platform === 'darwin') await promisify(execFile)(file, args);
        else {
          const executable = path.join(args.at(-1), asset.app, asset.executable);
          fs.mkdirSync(path.dirname(executable), { recursive: true });
          fs.writeFileSync(executable, 'vendor');
        }
      }
      return path.basename(file) === 'Renderer' ? '1.2.3' : '';
    },
  });
  const download = path.join(root, 'official-download.zip');
  fs.writeFileSync(download, bytes);
  await manager.importArchive(asset, download);
  await manager.ensure([asset], { onProgress: event => events.push(event) });
  assert.equal(manager.status([asset])[0].ready, true);
  assert.ok(events.some(event => event.phase === 'extracting'));
  assert.ok(events.some(event => event.phase === 'activating'));
  assert.ok(!commands.some(([file]) => file.endsWith('/hdiutil')));
  fs.rmSync(manager.status([asset])[0].executable);
  await manager.ensure([asset]);
  assert.equal(manager.status([asset])[0].ready, true);
});
