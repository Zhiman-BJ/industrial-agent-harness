const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {KimiSession} = require('../src/index.cjs');
const {validateProfile, writeCliConfig, sessionEnv} = require('../src/model-config.cjs');

// Opt-in integration: uses the pinned, installed CLI and SDK with a local API server.
// No credentials, model network, renderer, or substitute agent loop are involved.
for (const provider of ['openai_legacy', 'kimi']) test(`real Kimi CLI delivers inline images through ${provider} and retains them in native history`, {skip: !process.env.KIMI_EXECUTABLE, timeout: 45000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-vision-wire-'));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({url: request.url, body: JSON.parse(raw)});
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const value of [
      {choices: [{index: 0, delta: {role: 'assistant', content: 'Image received.'}, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 50, completion_tokens: 5, total_tokens: 55}},
    ]) response.write(`data: ${JSON.stringify({id: 'vision-wire', object: 'chat.completion.chunk', created: 1, model: 'test-vision', ...value})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close(); fs.rmSync(root, {recursive: true, force: true});});
  const profile = validateProfile({provider, endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-vision', contextSize: 262144, thinking: false, imageInputMode: 'enabled'});
  const runtime = {profile, apiKey: 'wire-test-key', shareDir: writeCliConfig(root, profile), env: sessionEnv(profile, 'wire-test-key'), executable: process.env.KIMI_EXECUTABLE, revision: 0};
  const events = [];
  const session = new KimiSession(root, () => ({domain: 'test', stage: 'test', capabilityIds: [], skills: [], tools: []}), () => null, () => null, event => events.push(event), () => runtime, undefined, {directory: path.join(root, 'logs')});
  t.after(() => session.close());
  const timer = setTimeout(() => {void session.interrupt();}, 35000); t.after(() => clearTimeout(timer));
  const image = {id: 'wire-image', name: 'pixel.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQkAAAAASUVORK5CYII='};
  await session.run('Describe this image', [image]);
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  const firstUser = requests[0].body.messages.filter(message => message.role === 'user').at(-1);
  assert.ok(firstUser, JSON.stringify({messages: requests[0].body.messages.map(({role,content}) => ({role,content: JSON.stringify(content).slice(-300)})), events}));
  assert.equal(firstUser.content.find(part => part.type === 'image_url').image_url.url, image.dataUrl);
  await session.run('Now reply using text');
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.equal(requests.length, 2);
  const users = requests[1].body.messages.filter(message => message.role === 'user');
  assert.equal(users[0].content.find(part => part.type === 'image_url').image_url.url, image.dataUrl);
  assert.ok(!JSON.stringify(users.at(-1).content).includes('image_url'));
  assert.equal(events.filter(event => event.type === 'done' && event.result.status === 'finished').length, 2);
});
