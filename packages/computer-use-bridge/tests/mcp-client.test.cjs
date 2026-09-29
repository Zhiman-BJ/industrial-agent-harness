const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {McpClient, resolveBinary, MAX_TOOL_OUTPUT_BYTES} = require('../src/mcp-client.cjs');

function fakeServerScript(dir, {failCall = false, big = false, cjkBig = false, image = false, hugeImage = false} = {}) {
  const serverFile = path.join(dir, 'server.cjs');
  const bigText = big ? `'x'.repeat(${MAX_TOOL_OUTPUT_BYTES + 500})` : cjkBig ? `'中'.repeat(8000)` : `null`;
  const imageContent = (image || hugeImage)
    ? `let b64 = ${hugeImage ? `'A'.repeat(4000000)` : `'iVBORw0KGgoAAAANSUh'`};
      let content = [{type: 'text', text}, {type: 'image', data: b64, mimeType: 'image/png'}];`
    : `let content = [{type: 'text', text}];`;
  fs.writeFileSync(serverFile, `
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2024-11-05', serverInfo: {name: 'fake', version: '0.0.0'}}}) + '\\n');
        } else if (message.method === 'tools/call') {
          let text = 'value for ' + message.params.name + ' ' + JSON.stringify(message.params.arguments);
          let isError = false;
          if (${failCall ? 'true' : 'false'} && message.params.name === 'access_denied') {text = 'Screen Recording permission is not granted to this app.'; isError = true;}
          if (${big || cjkBig} && ${bigText}) text = ${bigText};
          ${imageContent}
          process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {content, isError}}) + '\\n');
        }
      }
    });
  `);
  return serverFile;
}

function startFake({failCall = false, big = false, cjkBig = false, image = false, hugeImage = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bridge-fake-'));
  const serverFile = fakeServerScript(dir, {failCall, big, cjkBig, image, hugeImage});
  const client = new McpClient('node', {
    spawner: (bin, args, options) => {
      assert.equal(bin, 'node');
      assert.deepEqual(args, []);
      assert.equal(options.env.COMPUTER_USE_BROWSER, '0');
      return spawn(process.execPath, [serverFile], {stdio: ['pipe', 'pipe', 'pipe']});
    },
  });
  return {client, dir};
}

test('initialize handshake and a tools/call roundtrip', async t => {
  const {client, dir} = startFake();
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('click', {element_id: 'e1'});
  assert.equal(result.isError, false);
  assert.equal(result.needsSystemPermission, false);
  assert.match(result.output, /value for click/);
  assert.match(result.output, /"element_id":"e1"/);
});

test('permission errors are flagged needsSystemPermission', async t => {
  const {client, dir} = startFake({failCall: true});
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('access_denied', {});
  assert.equal(result.isError, true);
  assert.equal(result.needsSystemPermission, true);
  assert.match(result.output, /Screen Recording/);
});

test('output above the byte limit is truncated with a marker', async t => {
  const {client, dir} = startFake({big: true});
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('screenshot', {});
  assert.equal(result.truncated, true);
  assert.ok(result.outputBytes > MAX_TOOL_OUTPUT_BYTES);
  assert.match(result.output, /truncated/);
});

test('a crashed server marks the client closed so it is not reused', async t => {
  const {client, dir} = startFake();
  t.after(() => {fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  client.child.kill(9);
  await new Promise(resolve => client.child.on('exit', resolve));
  assert.equal(client.closed, true);
});

test('closing the client rejects in-flight and future calls', async t => {
  const {client, dir} = startFake();
  t.after(() => {fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  client.close();
  await assert.rejects(client.call('list_apps', {}), /closed/);
});

test('image blocks are forwarded as base64 alongside the text output', async t => {
  const {client, dir} = startFake({image: true});
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('screenshot', {display: 0});
  assert.equal(result.isError, false);
  assert.match(result.output, /value for screenshot/);
  assert.deepEqual(result.images, [{data: 'iVBORw0KGgoAAAANSUh', mimeType: 'image/png'}]);
});

test('an oversized image is dropped with a notice instead of shipping base64', async t => {
  const {client, dir} = startFake({hugeImage: true});
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('screenshot', {display: 0});
  assert.equal(result.images.length, 0);
  assert.match(result.output, /image_unavailable/);
});

test('text-only responses report no images', async t => {
  const {client, dir} = startFake();
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('list_apps', {});
  assert.deepEqual(result.images, []);
});

test('a UTF-8 character split across stdout chunks decodes intact', async () => {
  const {EventEmitter} = require('node:events');
  const fakeChild = {stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: {write() {}}, on() {}, kill() {}};
  const client = new McpClient('node', {spawner: () => fakeChild});
  const line = `${JSON.stringify({jsonrpc: '2.0', id: 1, result: {content: [{type: 'text', text: '标签 访问树'}]}})}\n`;
  const bytes = Buffer.from(line, 'utf8');
  // Cut inside the first multi-byte character so neither chunk is valid UTF-8
  // on its own; decoding each chunk independently corrupts it to U+FFFD.
  const cut = bytes.indexOf(Buffer.from('标', 'utf8')) + 1;
  assert.ok(cut > 0 && cut < bytes.length, 'the split lands inside a multi-byte character');
  const call = client.rpc('tools/call', {name: 'get_app_state', arguments: {}});
  fakeChild.stdout.emit('data', bytes.subarray(0, cut));
  fakeChild.stdout.emit('data', bytes.subarray(cut));
  const result = await call;
  assert.equal(result.content[0].text, '标签 访问树');
});

test('CJK output above the byte budget is truncated by bytes, not characters', async t => {
  const {client, dir} = startFake({cjkBig: true});
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  // 8000 characters of '中' are 24000 UTF-8 bytes: under the limit by
  // character count, far above it by bytes. The budget is bytes.
  const result = await client.call('get_app_state', {});
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= MAX_TOOL_OUTPUT_BYTES, `output stays within the byte budget, got ${Buffer.byteLength(result.output, 'utf8')}`);
  assert.match(result.output, /truncated/);
});

test('a truncated error with a dropped oversized image keeps the error prefix and image notice', async t => {
  const {client, dir} = startFake({failCall: true, big: true, hugeImage: true});
  t.after(() => {client.close(); fs.rmSync(dir, {recursive: true, force: true});});
  await client.initialize();
  const result = await client.call('access_denied', {});
  assert.equal(result.isError, true);
  assert.equal(result.truncated, true);
  assert.match(result.output, /\[computer-use error\]/, 'the model is still told the call failed');
  assert.match(result.output, /image_unavailable/, 'the dropped-image notice survives truncation');
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= MAX_TOOL_OUTPUT_BYTES);
});

test('resolveBinary prefers GUI_BRIDGE_BIN, then the installed directory, then PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bridge-bin-'));
  const installed = path.join(dir, 'munim-computer-use');
  fs.writeFileSync(installed, '#!/bin/sh\n');
  assert.equal(resolveBinary(dir, {}), installed);
  assert.equal(resolveBinary(dir, {GUI_BRIDGE_BIN: '/custom/bin'}), '/custom/bin');
  assert.equal(resolveBinary(undefined, {GUI_BRIDGE_BIN: undefined}), 'munim-computer-use');
  fs.rmSync(dir, {recursive: true, force: true});
});
