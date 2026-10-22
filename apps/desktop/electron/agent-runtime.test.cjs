const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const start = source.indexOf('let cachedAgentRuntime;');
const end = source.indexOf('function modelStatus()', start);
assert.ok(start >= 0 && end > start, 'The real Desktop runtime probe must be present.');

for (const [executable, script] of [
  ['entry.cjs', true],
  ['ENTRY.CJS', true],
  ['C:\\Program Files\\Kimi\\MAIN.MJS', true],
  ['ENTRY.JS', true],
  ['kimi.exe', false],
]) {
  test(`Desktop availability probes select the interpreter for ${executable}`, () => {
    const calls = [];
    const context = {
      process: { execPath: process.execPath, env: {} },
      kimiExecutable: () => executable,
      KIMI_CODE_VERSION: '2.1.1',
      spawnSync(command, args, options) {
        calls.push({ command, args: Array.from(args), options });
        return { status: 0, stdout: args.includes('--version') ? '2.1.1\n' : '--no-open' };
      },
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    assert.equal(context.agentRuntimeStatus().available, true);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.command, script ? process.execPath : executable);
      if (script) assert.equal(call.args[0], executable);
      assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
    }
    assert.deepEqual(calls[0].args, [...(script ? [executable] : []), '--version']);
    assert.deepEqual(calls[1].args, [...(script ? [executable] : []), 'web', '--help']);
  });
}
