const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {KimiSession} = require('../src/index.cjs');
const {validateProfile, writeCliConfig, sessionEnv} = require('../src/model-config.cjs');

test('real native sessions overlap; completion and interruption stay isolated', {skip: !process.env.KIMI_EXECUTABLE, timeout: 45000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parallel-wire-'));
  const incoming = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    incoming.push({body: JSON.parse(raw), response});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close(); fs.rmSync(root, {recursive: true, force: true});});
  const profile = validateProfile({provider: 'openai_legacy', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'parallel-test', contextSize: 262144, thinking: false});
  const runtime = {profile, apiKey: 'test', shareDir: writeCliConfig(root, profile), env: sessionEnv(profile, 'test'), executable: process.env.KIMI_EXECUTABLE, revision: 0};
  const eventsA = [], eventsB = [];
  // Same directory is intentional: independent native sessions must also work
  // within one project, without replacing each other's context or stream.
  const make = events => new KimiSession(root, () => ({domain: 'test', stage: 'test', capabilityIds: [], skills: [], tools: []}), () => null, () => null, event => events.push(event), () => runtime, undefined, {directory: path.join(root, 'logs')});
  const a = make(eventsA), b = make(eventsB);
  t.after(async () => {await Promise.all([a.close(), b.close()]);});
  const timer = setTimeout(() => {void a.interrupt(); void b.interrupt();}, 35000); t.after(() => clearTimeout(timer));
  const runA = a.run('SESSION_ALPHA'), runB = b.run('SESSION_BETA');
  const deadline = Date.now() + 20000;
  while (incoming.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(incoming.length, 2, 'both sessions reach the API before either response');
  assert.equal(a.running, true); assert.equal(b.running, true);
  const requestA = incoming.find(({body}) => JSON.stringify(body.messages).includes('SESSION_ALPHA'));
  const requestB = incoming.find(({body}) => JSON.stringify(body.messages).includes('SESSION_BETA'));
  assert.ok(requestA); assert.ok(requestB); assert.notEqual(requestA, requestB);
  assert.ok(!JSON.stringify(requestA.body.messages).includes('SESSION_BETA'));
  assert.ok(!JSON.stringify(requestB.body.messages).includes('SESSION_ALPHA'));
  requestA.response.writeHead(200, {'content-type': 'text/event-stream'});
  requestA.response.end(`data: ${JSON.stringify({id: 'a', object: 'chat.completion.chunk', created: 1, model: 'parallel-test', choices: [{index: 0, delta: {content: 'ALPHA_COMPLETE'}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12}})}\n\ndata: [DONE]\n\n`);
  await runA;
  assert.equal(a.running, false); assert.equal(b.running, true);
  await a.close(); assert.equal(b.running, true, 'closing one native session leaves the other active');
  await b.interrupt(); await runB;
  assert.ok(eventsA.some(event => event.type === 'text' && event.text === 'ALPHA_COMPLETE'));
  assert.ok(!eventsB.some(event => event.type === 'text' && event.text === 'ALPHA_COMPLETE'));
  assert.equal(eventsB.find(event => event.type === 'done')?.result.status, 'cancelled');
  assert.deepEqual(eventsA.filter(event => event.type === 'error'), []);
  assert.deepEqual(eventsB.filter(event => event.type === 'error'), []);
});
