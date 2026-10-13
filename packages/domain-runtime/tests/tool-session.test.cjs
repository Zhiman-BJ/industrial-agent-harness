const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openToolSession, dockerCommand } = require('../src/tool-session.cjs');
const image = 'example.test/runtime/tool@sha256:' + 'a'.repeat(64);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-session-test-'));
  const docker = path.join(directory, 'docker');
  const log = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(
    docker,
    `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(process.env.SESSION_LOG, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='rm') process.exit(0);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const request=JSON.parse(line); if(!request.id) return;
fs.appendFileSync(process.env.SESSION_LOG, JSON.stringify({method:request.method,params:request.params})+'\\n');
if(request.params?.name==='hang') return;
if(request.params?.name==='crash') { console.error('fixture recovery startup failed'); process.exit(23); }
console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result: request.method==='initialize'?{serverInfo:{name:'fixture'}}:{content:[{type:'text',text:'ok'},{type:'image',mimeType:'image/png',data:'aGVsbG8='}]}}));
});
`,
    { mode: 0o700 },
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    docker,
    log,
    directory,
    spec: {
      docker,
      command: ['python', '/gateway.py'],
      runtime: { kind: 'docker', image },
      hostEnvironment: { SESSION_LOG: log },
      expectedServerName: 'fixture',
    },
  };
}
test(
  'protected session preserves images, shares process, and confirms container cleanup',
  {
    skip:
      process.platform === 'win32' &&
      'The fake container daemon is a shebang script over a unix transport; the real Windows daemon is docker.exe over a named pipe.',
  },
  async t => {
    const f = fixture(t);
    const session = await openToolSession(f.spec);
    const first = await session.callTool('first', {});
    assert.equal(first.content[1].type, 'image');
    await session.callTool('second', {});
    await session.close();
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    const launches = calls.filter(Array.isArray);
    assert.equal(launches.filter(args => args[0] === 'run').length, 1);
    assert.equal(launches.filter(args => args[0] === 'rm').length, 1);
    assert.ok(launches[0].includes('--read-only'));
    assert.ok(launches[0].includes('none'));
  },
);
test(
  'active cancellation cleans container; cancelled queued call is never dispatched',
  {
    skip:
      process.platform === 'win32' &&
      'The fake container daemon is a shebang script over a unix transport; the real Windows daemon is docker.exe over a named pipe.',
  },
  async t => {
    const f = fixture(t);
    const session = await openToolSession(f.spec);
    const active = new AbortController();
    const queued = new AbortController();
    const first = session.callTool('hang', {}, { signal: active.signal });
    const second = session.callTool('never', {}, { signal: queued.signal });
    const rejectedFirst = assert.rejects(first, /cancelled/);
    const rejectedSecond = assert.rejects(second, /queued/);
    queued.abort(Error('queued cancellation'));
    await new Promise(resolve => setTimeout(resolve, 50));
    active.abort(Error('active cancelled'));
    await Promise.all([rejectedFirst, rejectedSecond]);
    const calls = fs.readFileSync(f.log, 'utf8');
    assert.ok(
      !calls
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
        .some(call => call.params?.name === 'never'),
    );
    assert.ok(calls.includes('"rm"'));
  },
);
test('mutable images and unsafe mounts are rejected before launch', t => {
  const f = fixture(t);
  assert.throws(
    () => dockerCommand({ ...f.spec, runtime: { kind: 'docker', image: 'latest' } }),
    /immutable/,
  );
  assert.throws(
    () => dockerCommand({ ...f.spec, mounts: [{ source: f.directory, target: '/../host' }] }),
    /mount/,
  );
});

test('trusted profiles must opt into the bounded bridge network explicitly', t => {
  const f = fixture(t);
  const result = dockerCommand({ ...f.spec, runtime: { ...f.spec.runtime, network: 'bridge' } });
  assert.equal(result.args[result.args.indexOf('--network') + 1], 'bridge');
  assert.throws(
    () => dockerCommand({ ...f.spec, runtime: { ...f.spec.runtime, network: 'host' } }),
    /network/,
  );
});

test(
  'unexpected process exit preserves stderr and exit status before cleanup and for later calls',
  {
    skip:
      process.platform === 'win32' &&
      'The fake container daemon is a shebang script over a unix transport; the real Windows daemon is docker.exe over a named pipe.',
  },
  async t => {
    const f = fixture(t);
    const session = await openToolSession(f.spec);
    await assert.rejects(
      session.callTool('crash', {}),
      /Tool process exited \(23\): fixture recovery startup failed/,
    );
    await assert.rejects(session.callTool('after-crash', {}), /fixture recovery startup failed/);
    await session.close();
    assert.ok(fs.readFileSync(f.log, 'utf8').includes('"rm"'));
  },
);

test(
  'project session scopes close idle real transports independently and reject opens after disposal',
  {
    skip:
      process.platform === 'win32' &&
      'The fake container daemon is a shebang script over a unix transport; the real Windows daemon is docker.exe over a named pipe.',
  },
  async t => {
    const { createToolSessionScope } = require('../src/tool-session.cjs');
    const f = fixture(t);
    const first = createToolSessionScope(),
      second = createToolSessionScope();
    const a = await first.openToolSession(f.spec),
      b = await second.openToolSession(f.spec);
    assert.equal(first.close(), first.close());
    await first.close();
    assert.equal(a.closing, true);
    assert.equal(b.closing, false);
    await assert.rejects(first.openToolSession(f.spec), /scope closed/);
    await b.callTool('still-live', {});
    await second.close();
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(Array.isArray).filter(args => args[0] === 'rm').length, 2);
  },
);

test('scope disposal waits for late startup cleanup, bounds concurrent starts and reports cleanup failures', async () => {
  const { createToolSessionScope } = require('../src/tool-session.cjs');
  let finish,
    closes = 0,
    startupSignal;
  const scope = createToolSessionScope({
    maxSessions: 1,
    openSession: async spec => {
      startupSignal = spec.signal;
      await new Promise(resolve => {
        finish = resolve;
      });
      return {
        close: async () => {
          closes++;
        },
      };
    },
  });
  const pending = scope.openToolSession({});
  await Promise.resolve();
  await assert.rejects(scope.openToolSession({}), /limit/);
  const closing = scope.close();
  assert.equal(startupSignal.aborted, true);
  let finished = false;
  closing.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  finish();
  await assert.rejects(pending, /scope closed/);
  await closing;
  assert.equal(closes, 1);
  const failed = createToolSessionScope({
    openSession: async () => ({
      close: async () => {
        throw Error('cleanup not confirmed');
      },
    }),
  });
  await failed.openToolSession({});
  await assert.rejects(
    failed.close(),
    error => error instanceof AggregateError && error.errors[0].message === 'cleanup not confirmed',
  );
});
