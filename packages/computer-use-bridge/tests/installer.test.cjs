const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {installBridge, ensureInstalled, status, source, assetName, parseSums} = require('../src/installer.cjs');

function buildZipAsset(dir, binaryContent) {
  const staging = path.join(dir, 'stage');
  fs.mkdirSync(staging, {recursive: true});
  fs.writeFileSync(path.join(staging, 'munim-computer-use'), binaryContent, {mode: 0o755});
  const zipFile = path.join(dir, 'munim-computer-use-macos-universal.zip');
  execFileSync('zip', ['-q', zipFile, 'munim-computer-use'], {cwd: staging});
  return fs.readFileSync(zipFile);
}

// Routes by URL suffix (the installer requests /{repo}/releases/download/{tag}/{file}).
// With `redirect`, the asset path issues one 302 hop to ?direct=1 before serving.
function startServer({asset, sumsText, assetFilename, redirect = false}) {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const url = request.url.split('?')[0];
      if (url.endsWith('SHA256SUMS.txt')) {
        response.writeHead(200, {'content-type': 'text/plain'});
        return response.end(sumsText);
      }
      if (url.endsWith(assetFilename)) {
        if (redirect && !request.url.includes('direct=1')) {
          response.writeHead(302, {location: `${url}?direct=1`});
          return response.end();
        }
        response.writeHead(200, {'content-type': 'application/octet-stream'});
        return response.end(asset);
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// env points the installer at the local http server; the test passes http.get as `get`.
function envFor(server) {
  return {
    GUI_BRIDGE_SOURCE_REPO: 'test/repo',
    GUI_BRIDGE_TAG: 'v9.9.9',
    GUI_BRIDGE_RELEASE_BASE: `http://127.0.0.1:${server.address().port}`,
    platform: 'darwin',
    arch: 'arm64',
  };
}

test('parseSums parses SHA256SUMS lines', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const sums = parseSums(`${a}  SomeFile.zip\n\n${b}  other.tar.gz\n`);
  assert.deepEqual(sums, {'somefile.zip': a, 'other.tar.gz': b});
});

test('source and assetName resolve per platform', () => {
  assert.deepEqual(source({}), {repo: 'munimtechnologies/munim-computer-use', tag: 'v0.4.3'});
  assert.deepEqual(source({GUI_BRIDGE_SOURCE_REPO: 'org/fork', GUI_BRIDGE_TAG: 'v1.2.3'}), {repo: 'org/fork', tag: 'v1.2.3'});
  assert.equal(assetName('darwin'), 'munim-computer-use-macos-universal.zip');
  assert.equal(assetName('linux', 'arm64'), 'munim-computer-use-linux-arm64.tar.gz');
  assert.equal(assetName('linux', 'x64'), 'munim-computer-use-linux-x64.tar.gz');
  assert.equal(assetName('win32'), 'munim-computer-use-windows-x64.zip');
});

test('a GUI_BRIDGE_BIN override skips installation entirely', async () => {
  const result = await ensureInstalled('/nonexistent/target', {GUI_BRIDGE_BIN: '/custom/munim-computer-use'}, () => {});
  assert.deepEqual(result, {binary: '/custom/munim-computer-use', external: true});
});

test('installBridge downloads, verifies, extracts; ensureInstalled is idempotent', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bridge-install-'));
  t.after(() => fs.rmSync(workDir, {recursive: true, force: true}));
  const assetDir = path.join(workDir, 'asset');
  fs.mkdirSync(assetDir, {recursive: true});
  const asset = buildZipAsset(assetDir, '#!/bin/sh\necho fake\n');
  const sha = crypto.createHash('sha256').update(asset).digest('hex');
  const sumsText = `${sha}  munim-computer-use-macos-universal.zip\n`;
  const server = await startServer({asset, sumsText, assetFilename: 'munim-computer-use-macos-universal.zip', redirect: true});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = envFor(server);
  const target = path.join(workDir, 'gui-bridge');
  const events = [];
  const first = await installBridge(target, env, (event, detail) => events.push(event), http.get);
  assert.match(first.binary, /munim-computer-use$/);
  assert.equal(first.sha256, sha);
  assert.equal(first.cached, undefined);
  assert.deepEqual(events, ['downloading', 'verified', 'ready']);
  const installed = status(target);
  assert.equal(installed.state, 'ready');
  assert.equal(installed.version.tag, 'v9.9.9');
  const second = await ensureInstalled(target, env, () => {}, http.get);
  assert.equal(second.cached, true);
  assert.equal(fs.statSync(first.binary).mode & 0o777, 0o755);
});

test('installBridge rejects on SHA256 mismatch and removes partial output', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bridge-install-'));
  t.after(() => fs.rmSync(workDir, {recursive: true, force: true}));
  const assetDir = path.join(workDir, 'asset');
  fs.mkdirSync(assetDir, {recursive: true});
  const asset = buildZipAsset(assetDir, '#!/bin/sh\necho fake\n');
  const badSums = 'f'.repeat(64) + '  munim-computer-use-macos-universal.zip\n';
  const server = await startServer({asset, sumsText: badSums, assetFilename: 'munim-computer-use-macos-universal.zip'});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = envFor(server);
  const target = path.join(workDir, 'gui-bridge');
  await assert.rejects(installBridge(target, env, () => {}, http.get), /SHA256 mismatch/);
  assert.equal(fs.existsSync(target), false);
});
