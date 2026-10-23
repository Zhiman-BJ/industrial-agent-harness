'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRendererProtocol } = require('./product-protocol.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-renderer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<main>Unchanged App</main>');
  fs.writeFileSync(path.join(root, 'assets/app.js'), 'export const app = true;');
  return root;
}
test('serves identical declared frontend bytes at the production origin', async t => {
  const protocol = createRendererProtocol(fixture(t));
  const page = protocol.handle(new Request('app://viewer/index.html'));
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<main>Unchanged App</main>');
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(protocol.manifest.length, 2);
  for (const item of protocol.manifest) assert.match(item.sha256, /^[0-9a-f]{64}$/);
});
test('rejects alternate origins, undeclared paths and encoded traversal', t => {
  const protocol = createRendererProtocol(fixture(t));
  for (const url of [
    'app://other/index.html',
    'app://viewer/%2e%2e%2findex.html',
    'app://viewer/assets/unknown.js',
  ])
    assert.ok(protocol.handle(new Request(url)).status >= 400);
});
test('rejects changed bytes and links after startup', t => {
  const root = fixture(t);
  const protocol = createRendererProtocol(root);
  fs.writeFileSync(path.join(root, 'assets/app.js'), 'export const app = false;');
  assert.equal(protocol.handle(new Request('app://viewer/assets/app.js')).status, 409);
  fs.unlinkSync(path.join(root, 'assets/app.js'));
  fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'assets/app.js'));
  assert.equal(protocol.handle(new Request('app://viewer/assets/app.js')).status, 409);
});
test('refuses renderer directories with symlinks or without a complete entry', t => {
  const root = fixture(t);
  fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'assets/link.html'));
  assert.throws(() => createRendererProtocol(root), /links/);
  fs.unlinkSync(path.join(root, 'assets/link.html'));
  fs.unlinkSync(path.join(root, 'index.html'));
  assert.throws(() => createRendererProtocol(root), /index.html/);
});
