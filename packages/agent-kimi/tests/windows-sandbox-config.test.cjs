const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { windowsEnvironment, inside } = require('../src/windows-sandbox.cjs');
const { createSession } = require('../src/code-session.cjs');

test('Windows credential exclusions are case insensitive and environment keys have one effective value', () => {
  assert.deepEqual(
    windowsEnvironment(
      {
        PATH: 'first',
        Path: 'last',
        SERVICE_TOKEN: 'secret',
        service_token: 'another',
        EMPTY: '',
        OMIT: undefined,
      },
      ['Service_Token'],
    ),
    { Path: 'last', EMPTY: '' },
  );
});

test('Windows storage comparisons distinguish sibling prefixes, volumes and path case', () => {
  assert.equal(inside('C:\\Session', 'c:\\session\\workspace'), true);
  assert.equal(inside('C:\\Session', 'C:\\SESSION'), true);
  assert.equal(inside('C:\\Session', 'C:\\Session-other'), false);
  assert.equal(inside('C:\\Session', 'C:\\Session\\..\\project'), false);
  assert.equal(inside('C:\\Session', 'D:\\Session\\workspace'), false);
});

test('native session dispatch uses the protected launcher and never restores a removed host credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-protected-dispatch-'));
  const name = 'HARNESS_TEST_HOST_ONLY_DISPATCH';
  const previous = process.env[name];
  process.env[name] = 'host-only-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
  let calls = 0;
  const session = createSession({
    workDir: directory,
    shareDir: directory,
    env: { PATH: process.env.PATH },
    envIsolated: true,
    spawn(_executable, _args, options) {
      calls++;
      assert.equal(options.env[name], undefined);
      assert.equal(options.env.KIMI_CODE_HOME, directory);
      throw Error('controlled boundary launch refusal');
    },
  });
  t.after(() => session.close());
  await assert.rejects(session.initialize(), /controlled boundary launch refusal/);
  assert.equal(calls, 1, 'launcher refusal must not fall back to an unprotected spawn');
  assert.equal(session.child, undefined);
});
