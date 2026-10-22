const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { finished } = require('node:stream/promises');

test('Desktop packaging retains the pinned manager when workspace discovery cannot read its manifest', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pm-fallback-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '../../..');
  const script = `
    const {createRequire}=require('node:module');
    const path=require('node:path');
    const desktopRequire=createRequire(path.resolve('apps/desktop/package.json'));
    const builderRequire=createRequire(desktopRequire.resolve('electron-builder'));
    const {detectPackageManager}=builderRequire('app-builder-lib/out/node-module-collector/packageManager');
    (async()=>{
      const before=await detectPackageManager([process.argv[1]]);
      require('./electron-builder.config.cjs');
      const after=await detectPackageManager([process.argv[1]]);
      console.log(JSON.stringify({before:before.pm,after:after.pm}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const output = execFileSync(process.execPath, ['-e', script, workspace], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_user_agent: 'npm/11.19.0' },
    timeout: 15000,
  });
  const managers = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(managers.before, 'npm');
  assert.equal(managers.after, require('../../../package.json').packageManager.split('@')[0]);
});

test('the release ASAR rules unpack external Python scripts while retaining ordinary modules', async t => {
  const root = path.resolve(__dirname, '../../..');
  const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
  const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const asar = libRequire('@electron/asar');
  const config = require('../../../electron-builder.config.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-asar-scripts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = path.join(directory, 'stage');
  const archive = path.join(directory, 'app.asar');
  const scripts = [
    ['viewer-builtin', 'src/layout/layout.py'],
    ['viewer-builtin', 'src/layout/layout_themes.py'],
    ['domain-mcp', 'src/gateway.py'],
  ];
  const modules = [
    ['viewer-builtin', 'src/layout/raster.cjs'],
    ['domain-mcp', 'src/gateway.cjs'],
  ];
  const files = new Map(
    [...scripts, ...modules].map(([name, file]) => [
      `node_modules/@industrial-agent-harness/${name}/${file}`,
      fs.readFileSync(path.join(root, 'packages', name, file)),
    ]),
  );
  // Similar filenames outside the declared rules must remain in the archive.
  files.set(
    'node_modules/@industrial-agent-harness/domain-mcp/src/other.py',
    Buffer.from('# unrelated Python script\n'),
  );
  files.set('node_modules/other-package/gateway.py', Buffer.from('# another package\n'));
  for (const [relative, bytes] of files) {
    const file = path.join(stage, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const patterns = config.asarUnpack.map(pattern =>
    path.join(stage, pattern).split(path.sep).join('/'),
  );
  const archiveStream = await asar.createPackageWithOptions(stage, archive, {
    unpack: `{${patterns.join(',')}}`,
  });
  // ASAR 3 resolves after out.end(), before pending archive writes finish.
  // Wait for that returned stream, including write errors, before inspecting it.
  await finished(archiveStream, { cleanup: true });
  assert.equal(archiveStream.writableFinished, true);
  assert.equal(fs.statSync(archive).isFile(), true);
  const external = scripts.map(
    ([name, file]) => `node_modules/@industrial-agent-harness/${name}/${file}`,
  );
  const physical = [];
  for (const [relative, bytes] of files) {
    // ASAR 3 traverses header entries using the host path separator.
    const archiveRelative = path.normalize(relative);
    const file = path.join(archive + '.unpacked', relative);
    if (external.includes(relative)) {
      assert.equal(asar.statFile(archive, archiveRelative).unpacked, true, relative);
      assert.deepEqual(fs.readFileSync(file), bytes);
      physical.push(file);
    } else {
      assert.notEqual(asar.statFile(archive, archiveRelative).unpacked, true, relative);
      assert.equal(fs.existsSync(file), false, relative);
      assert.deepEqual(asar.extractFile(archive, archiveRelative), bytes);
    }
  }
  // Exercise the pinned library's Windows traversal on every host using the
  // real archive header, rather than assuming POSIX separators are portable.
  const asarRequire = createRequire(libRequire.resolve('@electron/asar'));
  const filesystemSource = fs.readFileSync(asarRequire.resolve('./filesystem'), 'utf8');
  const windowsModule = { exports: {} };
  vm.runInNewContext(filesystemSource, {
    module: windowsModule,
    exports: windowsModule.exports,
    require: name => (name === 'path' ? path.win32 : asarRequire(name)),
  });
  const windowsFilesystem = new windowsModule.exports.Filesystem('C:\\fixture\\app.asar');
  const header = asar.getRawHeader(archive);
  windowsFilesystem.setHeader(JSON.parse(header.headerString), header.headerSize);
  assert.throws(
    () => windowsFilesystem.getFile(external[0]),
    /was not found in this archive/,
    'Raw POSIX entry paths reproduce the Windows lookup failure.',
  );
  for (const relative of files.keys())
    assert.equal(
      windowsFilesystem.getFile(path.win32.normalize(relative)).unpacked === true,
      external.includes(relative),
      relative,
    );
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs"); console.log(JSON.stringify(JSON.parse(process.argv[1]).map(file=>fs.readFileSync(file).toString("base64"))));',
      JSON.stringify(physical),
    ],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  assert.deepEqual(
    JSON.parse(output),
    external.map(relative => files.get(relative).toString('base64')),
  );
});
