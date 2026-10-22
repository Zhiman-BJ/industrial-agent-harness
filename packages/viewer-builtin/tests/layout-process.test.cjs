const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const rasterModule = require.resolve('../src/layout/raster.cjs');
const realSpawn = childProcess.spawn;

function directory(t, relative = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = path.join(root, relative);
  fs.mkdirSync(result, { recursive: true });
  return result;
}
function scripts(directory) {
  for (const name of ['layout.py', 'layout_themes.py'])
    fs.writeFileSync(path.join(directory, name), '# fixture\n');
}
function load() {
  delete require.cache[rasterModule];
  return require(rasterModule);
}
function service(t, script, scriptDirectory) {
  const launches = [];
  t.mock.method(childProcess, 'spawn', (python, args, options) => {
    const child = realSpawn(process.execPath, ['--eval', script], options);
    launches.push({ python, args, options, child });
    return child;
  });
  const { RasterService } = load();
  const worker = new RasterService('selected-python', { scriptDirectory });
  t.after(() => worker.close());
  return { worker, launches };
}
function input(t, directory) {
  const file = path.join(directory, 'input.gds');
  fs.writeFileSync(file, 'fixture layout input');
  return file;
}

test('layout worker retains source paths and only rewrites the complete app.asar segment', t => {
  const { resolveLayoutScript } = load();
  for (const relative of ['source', 'app.asar-assets/layout', 'app.asar.unpacked/layout']) {
    const source = directory(t, relative);
    scripts(source);
    assert.equal(resolveLayoutScript(source), path.join(source, 'layout.py'));
  }
  const root = directory(t);
  const archived = path.join(root, 'app.asar', 'node_modules', 'viewer', 'layout');
  fs.writeFileSync(path.join(root, 'app.asar'), 'an archive is a file, not a directory');
  const unpacked = path.join(root, 'app.asar.unpacked', 'node_modules', 'viewer', 'layout');
  fs.mkdirSync(unpacked, { recursive: true });
  scripts(unpacked);
  assert.equal(resolveLayoutScript(archived), path.join(unpacked, 'layout.py'));
});

test('layout worker rejects missing or non-file companion scripts before launching Python', async t => {
  const root = directory(t);
  const { resolveLayoutScript } = load();
  assert.throws(() => resolveLayoutScript(root), /layout\.py.*Reinstall/);
  fs.writeFileSync(path.join(root, 'layout.py'), '# fixture\n');
  assert.throws(() => resolveLayoutScript(root), /layout_themes\.py.*Reinstall/);
  fs.mkdirSync(path.join(root, 'layout_themes.py'));
  assert.throws(() => resolveLayoutScript(root), /layout_themes\.py.*Reinstall/);
  const { worker, launches } = service(t, 'process.exit(0)', root);
  await assert.rejects(
    worker.call({ op: 'load', token: 't', path: input(t, root) }),
    /layout_themes\.py.*Reinstall/,
  );
  assert.equal(launches.length, 0);
  assert.equal(worker.active, null);
  assert.equal(worker.queue.length, 0);
});

test('layout worker passes unpacked paths and isolated Python flags to the interpreter', async t => {
  const root = directory(t);
  const archived = path.join(root, 'app.asar', 'layout');
  fs.writeFileSync(path.join(root, 'app.asar'), 'archive');
  const unpacked = path.join(root, 'app.asar.unpacked', 'layout');
  fs.mkdirSync(unpacked, { recursive: true });
  scripts(unpacked);
  const { worker, launches } = service(
    t,
    `process.stdin.once('data', bytes => { const request = JSON.parse(bytes); process.stdout.write(JSON.stringify({id: request.id, result: {cell: 'TOP'}})+'\\n'); });`,
    archived,
  );
  assert.deepEqual(await worker.call({ op: 'load', token: 't', path: input(t, root) }), {
    cell: 'TOP',
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].python, 'selected-python');
  assert.deepEqual(launches[0].args, [
    '-B',
    '-E',
    '-s',
    '-u',
    path.join(unpacked, 'layout.py'),
    '--max-rss-bytes',
    String(768 * 1024 * 1024),
  ]);
  assert.deepEqual(launches[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('layout worker retains a bounded stderr tail and the real exit code after streams close', async t => {
  const root = directory(t);
  scripts(root);
  const { worker } = service(
    t,
    `process.stdin.once('data', () => { process.stderr.write('discarded-prefix'+ 'x'.repeat(20000) + '\\nFINAL_IMPORT_ERROR: no module klayout\\n', () => process.exit(7)); });`,
    root,
  );
  await assert.rejects(worker.call({ op: 'load', token: 't', path: input(t, root) }), error => {
    assert.match(error.message, /KLayout renderer stopped/);
    assert.match(error.message, /exit code 7/);
    assert.match(error.message, /FINAL_IMPORT_ERROR: no module klayout/);
    assert.doesNotMatch(error.message, /discarded-prefix/);
    assert.ok(Buffer.byteLength(error.message) < 4600, 'stderr must remain bounded');
    return true;
  });
  assert.equal(worker.active, null);
  assert.equal(worker.queue.length, 0);
  await assert.rejects(
    worker.call({ op: 'load', token: 't', path: input(t, root) }),
    /FINAL_IMPORT_ERROR/,
  );
});

test('layout worker preserves the first protocol failure when the child later exits', async t => {
  const root = directory(t);
  scripts(root);
  const { worker, launches } = service(
    t,
    `process.stdin.once('data', () => { process.stdout.write('not-json\\n'); setTimeout(() => process.exit(9), 20); });`,
    root,
  );
  await assert.rejects(
    worker.call({ op: 'load', token: 't', path: input(t, root) }),
    /Invalid KLayout response/,
  );
  await new Promise(resolve => launches[0].child.once('close', resolve));
  assert.match(worker.lastError, /Invalid KLayout response/);
  assert.doesNotMatch(worker.lastError, /exit code 9/);
  assert.equal(worker.active, null);
  assert.equal(worker.queue.length, 0);
});

test('layout worker reports interpreter launch failure without replacing it with an exit message', async t => {
  const root = directory(t);
  scripts(root);
  const { RasterService } = load();
  const worker = new RasterService(path.join(root, 'missing-python'), { scriptDirectory: root });
  t.after(() => worker.close());
  await assert.rejects(
    worker.call({ op: 'load', token: 't', path: input(t, root) }),
    /KLayout renderer could not start.*ENOENT/,
  );
  assert.match(worker.lastError, /could not start.*ENOENT/);
  assert.equal(worker.active, null);
  assert.equal(worker.queue.length, 0);
});

test('layout worker includes a termination signal and drained stderr in diagnostics', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const root = directory(t);
  scripts(root);
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('worker was terminated'));
      child.emit('close', null, 'SIGTERM');
    });
    return child;
  });
  const { RasterService } = load();
  const worker = new RasterService('selected-python', { scriptDirectory: root });
  t.after(() => worker.close());
  await assert.rejects(
    worker.call({ op: 'load', token: 't', path: input(t, root) }),
    /signal SIGTERM[\s\S]*worker was terminated/,
  );
  assert.equal(worker.active, null);
  assert.equal(worker.queue.length, 0);
});

test('packaged layout smoke canonicalizes application aliases before checking unpacked scripts', t => {
  const { packagedPaths } = require('../../../scripts/smoke-packaged-layout.cjs');
  const root = directory(t);
  const application = path.join(root, 'actual', 'Example.app');
  const contents = path.join(application, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'));
  const executable = path.join(contents, 'MacOS', 'Example');
  const archive = path.join(contents, 'Resources', 'app.asar');
  fs.writeFileSync(executable, 'fixture');
  fs.writeFileSync(archive, 'archive');
  const alias = path.join(root, 'alias.app');
  fs.symlinkSync(application, alias, 'junction');
  assert.deepEqual(packagedPaths(path.join(alias, 'Contents', 'MacOS', 'Example'), 'darwin'), {
    executable: fs.realpathSync(executable),
    archive: fs.realpathSync(archive),
  });
});
