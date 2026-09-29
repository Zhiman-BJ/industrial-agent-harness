const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createGuiPlugin} = require('../src/index.cjs');

// A fake server that answers initialize and the first tools/call, then exits
// so the next call must go through the rebuild path.
function crashingServerScript(dir) {
  const serverFile = path.join(dir, 'server.cjs');
  fs.writeFileSync(serverFile, `
    let buffer = '';
    let calls = 0;
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
          calls += 1;
          process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: 'call ' + calls}], isError: false}}) + '\\n');
          if (calls >= 2) process.exit(9);
        }
      }
    });
  `);
  return serverFile;
}

test('a dead MCP server is rebuilt on the next call instead of failing forever', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bridge-rebuild-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const serverFile = crashingServerScript(dir);
  let spawns = 0;
  const plugin = createGuiPlugin({
    enabled: () => true,
    installedDir: null,
    env: {GUI_BRIDGE_BIN: 'node'},
    spawner: (bin, args, options) => {
      spawns += 1;
      return spawn(process.execPath, [serverFile], {stdio: ['pipe', 'pipe', 'pipe']});
    },
  });
  t.after(() => plugin.close());
  const first = await plugin.clientLike.call('list_apps', {});
  const second = await plugin.clientLike.call('list_apps', {});
  assert.match(first.output, /call 1/);
  // Let the crash propagate: the server exits after its second call.
  await new Promise(resolve => setTimeout(resolve, 150));
  // The next call must hit a fresh server.
  const third = await plugin.clientLike.call('list_apps', {});
  assert.match(third.output, /call 1/);
  assert.ok(spawns >= 2, 'a new server process was spawned after the crash');
});
