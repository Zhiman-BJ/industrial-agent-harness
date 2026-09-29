const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {ChatStore} = require('../src/index.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-chat-store-'));
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {directory, project, store: new ChatStore(path.join(directory, 'chats'))};
}

test('desktop drafts reuse actual empty chats within the project/domain and preserve existing rows', t => {
  const {directory, project, store} = fixture(t); t.after(() => store.close());
  const first = store.createDraft(project, 'test-domain');
  assert.equal(store.createDraft(project, 'test-domain').id, first.id);
  const legacy = store.create(project, 'test-domain');
  assert.equal(store.createDraft(project, 'test-domain', first.id).id, first.id, 'keep the current draft');
  assert.equal(store.list(project, 'test-domain').length, 2, 'existing duplicates are not deleted');
  const turn = store.beginTurn(first.id, 'New chat', null, false);
  assert.equal(store.createDraft(project, 'test-domain', first.id).id, legacy.id, 'a scoped turn is not empty even with the default title');
  store.finish(turn, 'error');
  assert.equal(store.createDraft(project, 'test-domain', first.id).id, legacy.id, 'failed submissions remain history');
  assert.notEqual(store.createDraft(project, 'other-domain', legacy.id).id, legacy.id);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  assert.notEqual(store.createDraft(other, 'test-domain', legacy.id).id, legacy.id);
  store.db.prepare('UPDATE chats SET archived = 1 WHERE id = ?').run(legacy.id);
  const draft = store.createDraft(project, 'test-domain', legacy.id);
  assert.notEqual(draft.id, legacy.id, 'archived chats are not reopened');
  const release = store.acquire(draft.id);
  const unlocked = store.createDraft(project, 'test-domain', draft.id);
  assert.notEqual(unlocked.id, draft.id, 'do not reuse a chat reserved for execution');
  release();
  const reopened = new ChatStore(path.join(directory, 'chats')); t.after(() => reopened.close());
  assert.equal(reopened.createDraft(project, 'test-domain', draft.id).id, draft.id, 'draft survives reopening');
});

test('concurrent desktop draft requests from separate processes create only one chat', async t => {
  const {directory, project, store} = fixture(t); t.after(() => store.close());
  const results = await Promise.all(Array.from({length: 6}, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `const {ChatStore}=require(${JSON.stringify(path.resolve(__dirname, '../src/index.cjs'))});const store=new ChatStore(${JSON.stringify(path.join(directory, 'chats'))});process.stdout.write(JSON.stringify(Array.from({length:20},()=>store.createDraft(${JSON.stringify(project)},'test-domain').id)));store.close();`], {stdio: ['ignore', 'pipe', 'pipe']});
    t.after(() => child.kill('SIGKILL'));
    let output = '', errors = '';
    child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {errors += data;});
    child.once('error', reject); child.once('exit', code => {if (code !== 0) reject(Error(errors)); else {try {resolve(JSON.parse(output));} catch (error) {reject(error);}}});
  })));
  assert.equal(new Set(results.flat()).size, 1);
  assert.equal(store.list(project, 'test-domain').length, 1);
});

test('history survives reopening, separates projects/domains and pages without gaps', t => {
  const {directory, project, store} = fixture(t);
  const chat = store.create(project, 'test-domain');
  const ids = [];
  for (let i = 0; i < 23; i++) {
    const turn = store.beginTurn(chat.id, `Task ${i}`); ids.push(turn);
    store.append(turn, {type: 'text', text: `Answer ${i}`});
    store.append(turn, {type: 'status', contextUsage: 0.2});
    store.append(turn, {type: 'text', text: ' continued'});
    store.finish(turn, 'finished');
  }
  store.close();
  const reopened = new ChatStore(path.join(directory, 'chats')); t.after(() => reopened.close());
  assert.equal(reopened.list(project, 'test-domain')[0].title, 'Task 0');
  const first = reopened.history(chat.id, project, 'test-domain');
  const second = reopened.history(chat.id, project, 'test-domain', first.before);
  const third = reopened.history(chat.id, project, 'test-domain', second.before);
  assert.deepEqual([...third.turns, ...second.turns, ...first.turns].map(turn => turn.id), ids);
  assert.equal(third.hasMore, false);
  assert.equal(first.turns[0].events[0].text, 'Answer 13 continued');
  assert.throws(() => reopened.history(chat.id, project, 'other-domain'), /unavailable/);
  assert.throws(() => reopened.history('../outside', project, 'test-domain'), /Invalid/);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  assert.throws(() => reopened.get(chat.id, other, 'test-domain'), /unavailable/);
  assert.equal(fs.statSync(path.join(directory, 'chats/chats.sqlite')).mode & 0o777, 0o600);
});

test('one chat can have several runtime sessions; returning to an old scope starts a new segment', t => {
  const {directory, project, store} = fixture(t); t.after(() => store.close());
  const chat = store.create(project, 'test-domain');
  const one = store.runtimeSession(chat.id, 'scope-one'); store.initialized(one.id);
  assert.equal(store.runtimeSession(chat.id, 'scope-one').initialized, true);
  const two = store.runtimeSession(chat.id, 'scope-two');
  assert.notEqual(one.id, two.id);
  assert.notEqual(store.runtimeSession(chat.id, 'scope-one').id, one.id);
  const release = store.acquire(chat.id);
  const other = new ChatStore(path.join(directory, 'chats')); t.after(() => other.close());
  assert.throws(() => other.acquire(chat.id), /another process/);
  assert.throws(() => store.remove(chat.id, project, 'test-domain'), /another process/);
  release();
  other.acquire(chat.id)();
  store.remove(chat.id, project, 'test-domain');
  assert.equal(fs.existsSync(one.shareDir), false);
  assert.equal(store.list(project, 'test-domain').length, 0);
});

test('killed process leaves an interrupted turn and an expired approval, without replaying work', async t => {
  const {directory, project, store} = fixture(t);
  const chat = store.create(project, 'test-domain'); store.close();
  const child = spawn(process.execPath, ['-e', `const {ChatStore}=require(${JSON.stringify(path.resolve(__dirname, '../src/index.cjs'))});const s=new ChatStore(${JSON.stringify(path.join(directory, 'chats'))});s.acquire(${JSON.stringify(chat.id)});const t=s.beginTurn(${JSON.stringify(chat.id)},'Pending task');s.append(t,{type:'approval',id:'old',action:'write',description:'Do not replay'});process.stdout.write('ready');setInterval(()=>{},1000);`], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`Exited ${code}`)));});
  const live = new ChatStore(path.join(directory, 'chats'));
  assert.equal(live.history(chat.id, project, 'test-domain').turns[0].status, 'running');
  assert.throws(() => live.acquire(chat.id), /another process/); live.close();
  const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
  const recovered = new ChatStore(path.join(directory, 'chats')); t.after(() => recovered.close());
  const turn = recovered.history(chat.id, project, 'test-domain').turns[0];
  assert.equal(turn.status, 'interrupted');
  assert.match(turn.events.at(-1).message, /interrupted/);
  recovered.acquire(chat.id)();
  assert.equal(recovered.history(chat.id, project, 'test-domain').turns.length, 1);
});
