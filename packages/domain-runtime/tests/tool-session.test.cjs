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
test('protected session preserves images, shares process, and confirms container cleanup', async t => {
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
});
test('active cancellation cleans container; cancelled queued call is never dispatched', async t => {
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
});
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
