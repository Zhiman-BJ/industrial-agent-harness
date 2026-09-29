const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {ChatStore} = require('../../packages/harness-core/src/index.cjs');
const root = path.resolve(__dirname, '../..');
const executable = process.env.KIMI_EXECUTABLE || path.join(root, 'apps/desktop/.venv-kimi/bin/kimi');

test('real pinned Kimi CLI resumes three turns across separate CLI processes and rotates model context', {timeout: 90000, skip: !fs.existsSync(executable)}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-real-resume-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const requests = [];
  let interruptNext = false, activeChild;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (interruptNext) {interruptNext = false; activeChild.kill('SIGTERM'); return;}
    const n = body.messages.filter(message => message.role === 'user').length;
    const answer = `ACK turn ${n}`;
    if (body.stream) {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const base = {id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: body.model};
      res.write(`data: ${JSON.stringify({...base, choices: [{index: 0, delta: {role: 'assistant', content: answer}, finish_reason: null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110}})}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({id: 'test', object: 'chat.completion', created: 1, model: body.model, choices: [{index: 0, message: {role: 'assistant', content: answer}, finish_reason: 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110}}));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  async function run(task, chatId, model = 'test-first', interrupt = false) {
    const args = [path.join(root, 'apps/cli/src/main.cjs'), 'run', '--project-dir', directory, '--domain', 'godot', '--task', task, '--provider', 'openai_legacy', '--endpoint', endpoint, '--model', model, '--no-thinking', '--kimi-executable', executable, '--chat-dir', path.join(directory, 'chats'), '--state-dir', path.join(directory, 'state'), '--log-dir', path.join(directory, 'logs'), '--timeout-ms', '15000'];
    if (chatId) args.push('--chat-id', chatId);
    const child = spawn(process.execPath, args, {cwd: root, env: {...process.env, OPENAI_API_KEY: 'local-fixture-key', INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config')}, stdio: ['ignore', 'pipe', 'pipe']});
    activeChild = child; interruptNext = interrupt;
    let output = '', errors = ''; child.stdout.on('data', chunk => {output += chunk;}); child.stderr.on('data', chunk => {errors += chunk;});
    t.after(() => child.kill('SIGKILL'));
    const code = await new Promise((resolve, reject) => {child.once('exit', resolve); child.once('error', reject);});
    const rows = output.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(code, interrupt ? 130 : 0, `${output}\n${errors}`);
    assert.equal(rows.at(-1).status, interrupt ? 'interrupted' : 'finished');
    return rows.at(-1).chatId;
  }
  const token = `remember-${Date.now()}`;
  const chatId = await run(`Remember ${token}. Reply ACK.`, null);
  assert.equal(await run('Second message. Reply ACK.', chatId), chatId);
  assert.equal(await run('Third message. Reply ACK.', chatId), chatId);
  // Requests sent to a controlled endpoint prove Kimi loaded model context, independently of the UI history.
  const turns = requests.filter(request => JSON.stringify(request.messages).includes('User task:'));
  assert.deepEqual(turns.map(request => request.messages.filter(message => message.role === 'user').length), [1, 2, 3]);
  assert.ok(JSON.stringify(turns[2].messages).includes(token));
  assert.ok(turns[2].messages.some(message => message.role === 'assistant' && message.content === 'ACK turn 2'));
  await run('Changed model. Reply ACK.', chatId, 'test-second');
  const last = requests.filter(request => JSON.stringify(request.messages).includes('User task:')).at(-1);
  assert.equal(last.messages.filter(message => message.role === 'user').length, 1);
  await run('Interrupt this pending turn.', chatId, 'test-second', true);
  await run('Continue after interruption.', chatId, 'test-second');
  const resumed = requests.filter(request => JSON.stringify(request.messages).includes('User task:')).at(-1);
  assert.ok(JSON.stringify(resumed.messages).includes('Changed model. Reply ACK.'));
  const store = new ChatStore(path.join(directory, 'chats')); t.after(() => store.close());
  const history = store.history(chatId, directory, 'godot');
  assert.equal(history.turns.length, 6);
  assert.equal(history.turns[4].status, 'interrupted');
  assert.equal(history.turns[5].status, 'finished');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM runtime_sessions').get().count, 2);
});
