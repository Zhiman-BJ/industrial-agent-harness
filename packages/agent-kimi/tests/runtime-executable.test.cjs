const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const [executable, script] of [
  ['entry.cjs', true],
  ['ENTRY.CJS', true],
  ['C:\\Program Files\\Kimi\\MAIN.MJS', true],
  ['ENTRY.JS', true],
  ['kimi.exe', false],
]) {
  test(`Kimi startup selects the interpreter for ${executable}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-runtime-entry-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/code-session.cjs'), 'utf8'), {
      module,
      process,
      require(name) {
        if (name === 'node:net')
          return {
            createServer() {
              const server = new EventEmitter();
              server.listen = (_port, _host, ready) => ready();
              server.address = () => ({ port: 12345 });
              server.close = done => done();
              return server;
            },
          };
        if (name === './tool-server.cjs')
          return {
            startToolServer: async () => ({
              config: { url: 'http://fixture.invalid' },
              close: async () => {},
            }),
          };
        return require(name);
      },
      setTimeout,
      clearTimeout,
    });
    let launched;
    const session = module.exports.createSession({
      shareDir: directory,
      workDir: directory,
      executable,
      spawn(command, args, options) {
        launched = { command, args: Array.from(args), options };
        throw Error('Launch captured before starting a real child.');
      },
    });
    await assert.rejects(session.start(), /Launch captured/);
    assert.equal(launched.command, script ? process.execPath : executable);
    assert.deepEqual(
      launched.args.slice(0, script ? 2 : 1),
      script ? [executable, 'web'] : ['web'],
    );
    assert.equal(launched.options.env.ELECTRON_RUN_AS_NODE, '1');
    await session.toolServer.close();
  });
}
