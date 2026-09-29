const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {GodotRuntimeManager, isGodotExport} = require('../src/godot/runtime.cjs');

test('Godot export opens through a bounded session and rejects changed or unrelated files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-viewer-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [name, content] of Object.entries({'scene.html': '<html><head></head><body>Godot</body></html>', 'scene.js': 'window.Engine = {};', 'scene.wasm': 'wasm', 'scene.pck': 'pack', 'secret.js': 'private'})) fs.writeFileSync(path.join(root, name), content);
  const html = path.join(root, 'scene.html');
  assert.equal(isGodotExport(html), true);
  const runtime = new GodotRuntimeManager();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(html)).digest('hex');
  await assert.rejects(runtime.open(html, 'bad'), /changed/);
  const session = await runtime.open(html, hash);
  const page = await runtime.handle(new Request(session.url));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /_harness_bridge\.js/);
  const bridge = await runtime.handle(new Request(session.url.replace('scene.html', '_harness_bridge.js')));
  assert.equal(bridge.status, 200);
  assert.match(await bridge.text(), /HarnessGodotBridge/);
  assert.equal((await runtime.handle(new Request(session.url.replace('scene.html', 'secret.js')))).status, 404);
  assert.equal((await runtime.handle(new Request(session.url.replace('scene.html', '..%2Fsecret.js')))).status, 404);
  fs.writeFileSync(path.join(root, 'scene.pck'), 'changed');
  assert.equal((await runtime.handle(new Request(session.url.replace('scene.html', 'scene.pck')))).status, 409);
  runtime.close();
  assert.equal((await runtime.handle(new Request(session.url))).status, 404);
});

test('incomplete export is treated as ordinary HTML', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-viewer-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  assert.equal(isGodotExport(path.join(root, 'index.html')), false);
});
