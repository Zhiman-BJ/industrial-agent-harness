const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChatStore, deriveChatTitle } = require('../src/index.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-chat-store-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const stores = [];
  const openStore = () => {
    const store = new ChatStore(path.join(directory, 'chats'));
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, project, store: openStore(), openStore };
}

test('desktop drafts reuse actual empty chats within the project/domain and preserve existing rows', t => {
  const { directory, project, store, openStore } = fixture(t);
  t.after(() => store.close());
  const first = store.createDraft(project, 'test-domain');
  assert.equal(store.createDraft(project, 'test-domain').id, first.id);
  const legacy = store.create(project, 'test-domain');
  assert.equal(
    store.createDraft(project, 'test-domain', first.id).id,
    first.id,
    'keep the current draft',
  );
  assert.equal(store.list(project, 'test-domain').length, 2, 'existing duplicates are not deleted');
  const turn = store.beginTurn(first.id, 'New chat', null, false);
  assert.equal(
    store.createDraft(project, 'test-domain', first.id).id,
    legacy.id,
    'a scoped turn is not empty even with the default title',
  );
  store.finish(turn, 'error');
  assert.equal(
    store.createDraft(project, 'test-domain', first.id).id,
    legacy.id,
    'failed submissions remain history',
  );
  assert.notEqual(store.createDraft(project, 'other-domain', legacy.id).id, legacy.id);
  const other = path.join(directory, 'other');
  fs.mkdirSync(other);
  assert.notEqual(store.createDraft(other, 'test-domain', legacy.id).id, legacy.id);
  store.db.prepare('UPDATE chats SET archived = 1 WHERE id = ?').run(legacy.id);
  const draft = store.createDraft(project, 'test-domain', legacy.id);
  assert.notEqual(draft.id, legacy.id, 'archived chats are not reopened');
  const release = store.acquire(draft.id);
  const unlocked = store.createDraft(project, 'test-domain', draft.id);
  assert.notEqual(unlocked.id, draft.id, 'do not reuse a chat reserved for execution');
  release();
  const reopened = openStore();
  t.after(() => reopened.close());
  assert.equal(
    reopened.createDraft(project, 'test-domain', draft.id).id,
    draft.id,
    'draft survives reopening',
  );
});

test('approval mode is scoped to one chat, persists across stores and cannot change an executing chat', t => {
  const { directory, project, store, openStore } = fixture(t);
  const first = store.create(project, 'test-domain');
  const second = store.create(project, 'test-domain');
  assert.equal(first.approvalMode, 'ask');
  assert.equal(store.setApprovalMode(first.id, project, 'test-domain', 'auto'), 'auto');
  const reopened = openStore();
  assert.equal(reopened.history(first.id, project, 'test-domain').chat.approvalMode, 'auto');
  assert.equal(reopened.get(second.id, project, 'test-domain').approvalMode, 'ask');
  assert.equal(reopened.create(project, 'test-domain').approvalMode, 'ask');
  assert.equal(
    store.list(project, 'test-domain').find(chat => chat.id === first.id).approvalMode,
    'auto',
  );
  const other = path.join(directory, 'other');
  fs.mkdirSync(other);
  assert.throws(() => store.setApprovalMode(first.id, other, 'test-domain', 'auto'), /unavailable/);
  assert.throws(
    () => store.setApprovalMode(first.id, project, 'other-domain', 'auto'),
    /unavailable/,
  );
  assert.throws(
    () => store.setApprovalMode(first.id, project, 'test-domain', 'invalid'),
    /Invalid/,
  );
  const release = store.acquire(first.id);
  assert.throws(
    () => reopened.setApprovalMode(first.id, project, 'test-domain', 'ask'),
    /Stop this chat/,
  );
  store.setApprovalMode(second.id, project, 'test-domain', 'auto');
  release();
  const turn = store.beginTurn(first.id, 'held turn');
  assert.throws(
    () => store.setApprovalMode(first.id, project, 'test-domain', 'ask'),
    /Stop this chat/,
  );
  store.finish(turn, 'finished');
  store.setApprovalMode(first.id, project, 'test-domain', 'ask');
  assert.equal(reopened.get(first.id, project, 'test-domain').approvalMode, 'ask');
  assert.equal(reopened.get(second.id, project, 'test-domain').approvalMode, 'auto');
  store.remove(first.id, project, 'test-domain');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM chat_preferences WHERE chat_id = ?').get(first.id)
      .n,
    0,
  );
});

test('concurrent desktop draft requests from separate processes create only one chat', async t => {
  const { directory, project, store } = fixture(t);
  t.after(() => store.close());
  const results = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '-e',
              `const {ChatStore}=require(${JSON.stringify(path.resolve(__dirname, '../src/index.cjs'))});const store=new ChatStore(${JSON.stringify(path.join(directory, 'chats'))});process.stdout.write(JSON.stringify(Array.from({length:20},()=>store.createDraft(${JSON.stringify(project)},'test-domain').id)));store.close();`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          t.after(() => child.kill('SIGKILL'));
          let output = '',
            errors = '';
          child.stdout.on('data', data => {
            output += data;
          });
          child.stderr.on('data', data => {
            errors += data;
          });
          child.once('error', reject);
          child.once('exit', code => {
            if (code !== 0) reject(Error(errors));
            else {
              try {
                resolve(JSON.parse(output));
              } catch (error) {
                reject(error);
              }
            }
          });
        }),
    ),
  );
  assert.equal(new Set(results.flat()).size, 1);
  assert.equal(store.list(project, 'test-domain').length, 1);
});

test('history survives reopening, separates projects/domains and pages without gaps', t => {
  const { directory, project, store, openStore } = fixture(t);
  const chat = store.create(project, 'test-domain');
  const ids = [];
  for (let i = 0; i < 23; i++) {
    const turn = store.beginTurn(chat.id, `Task ${i}`);
    ids.push(turn);
    store.append(turn, { type: 'text', text: `Answer ${i}` });
    store.append(turn, { type: 'status', contextUsage: 0.2 });
    store.append(turn, { type: 'text', text: ' continued' });
    store.finish(turn, 'finished');
  }
  store.close();
  const reopened = openStore();
  t.after(() => reopened.close());
  assert.equal(reopened.list(project, 'test-domain')[0].title, 'Task 0');
  const first = reopened.history(chat.id, project, 'test-domain');
  const second = reopened.history(chat.id, project, 'test-domain', first.before);
  const third = reopened.history(chat.id, project, 'test-domain', second.before);
  assert.deepEqual(
    [...third.turns, ...second.turns, ...first.turns].map(turn => turn.id),
    ids,
  );
  assert.equal(third.hasMore, false);
  assert.equal(first.turns[0].events[0].text, 'Answer 13 continued');
  assert.throws(() => reopened.history(chat.id, project, 'other-domain'), /unavailable/);
  assert.throws(() => reopened.history('../outside', project, 'test-domain'), /Invalid/);
  const other = path.join(directory, 'other');
  fs.mkdirSync(other);
  assert.throws(() => reopened.get(chat.id, other, 'test-domain'), /unavailable/);
  // POSIX permission bits are not represented by Windows stat().
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(directory, 'chats/chats.sqlite')).mode & 0o777, 0o600);
});

test('receipt times survive stream coalescing and reopening without changing source events', t => {
  const { project, store, openStore } = fixture(t);
  const chat = store.create(project, 'test-domain');
  const turn = store.beginTurn(chat.id, 'Timestamp test');
  const input = Object.freeze({ type: 'text', text: 'First' });
  const before = Date.now();
  const first = store.append(turn, input);
  assert.ok(Date.parse(first.recordedAt) >= before && Date.parse(first.recordedAt) <= Date.now());
  assert.equal(input.recordedAt, undefined);
  store.append(turn, { type: 'status', contextUsage: 0.2 });
  store.append(turn, { type: 'text', text: ' second' });
  store.finish(turn, 'finished');
  store.close();
  const restored = openStore().history(chat.id, project, 'test-domain').turns[0];
  assert.equal(restored.events[0].recordedAt, first.recordedAt);
  assert.equal(restored.events[0].text, 'First second');
});

test('one chat can have several runtime sessions; returning to an old scope starts a new segment', t => {
  const { directory, project, store, openStore } = fixture(t);
  t.after(() => store.close());
  const chat = store.create(project, 'test-domain');
  const one = store.runtimeSession(chat.id, 'scope-one');
  store.initialized(one.id);
  assert.equal(store.runtimeSession(chat.id, 'scope-one').initialized, true);
  const two = store.runtimeSession(chat.id, 'scope-two');
  assert.notEqual(one.id, two.id);
  assert.notEqual(store.runtimeSession(chat.id, 'scope-one').id, one.id);
  const release = store.acquire(chat.id);
  const other = openStore();
  t.after(() => other.close());
  assert.throws(() => other.acquire(chat.id), /another process/);
  assert.throws(() => store.remove(chat.id, project, 'test-domain'), /another process/);
  release();
  other.acquire(chat.id)();
  store.remove(chat.id, project, 'test-domain');
  assert.equal(fs.existsSync(one.shareDir), false);
  assert.equal(store.list(project, 'test-domain').length, 0);
});

test('killed process leaves an interrupted turn and an expired approval, without replaying work', async t => {
  const { directory, project, store, openStore } = fixture(t);
  const chat = store.create(project, 'test-domain');
  store.close();
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const {ChatStore}=require(${JSON.stringify(path.resolve(__dirname, '../src/index.cjs'))});const s=new ChatStore(${JSON.stringify(path.join(directory, 'chats'))});s.acquire(${JSON.stringify(chat.id)});const t=s.beginTurn(${JSON.stringify(chat.id)},'Pending task');s.append(t,{type:'approval',id:'old',action:'write',description:'Do not replay'});process.stdout.write('ready');setInterval(()=>{},1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(Error(`Exited ${code}`)));
  });
  const live = openStore();
  assert.equal(live.history(chat.id, project, 'test-domain').turns[0].status, 'running');
  assert.throws(() => live.acquire(chat.id), /another process/);
  live.close();
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exit;
  const recovered = openStore();
  t.after(() => recovered.close());
  const turn = recovered.history(chat.id, project, 'test-domain').turns[0];
  assert.equal(turn.status, 'interrupted');
  assert.match(turn.events.at(-1).message, /interrupted/);
  recovered.acquire(chat.id)();
  assert.equal(recovered.history(chat.id, project, 'test-domain').turns.length, 1);
});

test('stable result event IDs deduplicate across store handles and request history stays isolated', t => {
  const { project, store, openStore } = fixture(t);
  const chat = store.create(project, 'test-domain');
  const turn = store.beginTurn(chat.id, 'Results');
  const event = { type: 'results-changed', eventId: 'results:stable', results: { revision: 1 } };
  const original = store.append(turn, event);
  const other = openStore();
  assert.deepEqual(other.append(turn, { ...event, results: { revision: 999 } }), original);
  assert.equal(store.turnEvents(chat.id, turn).length, 1);
  assert.equal(store.latestEvents(chat.id, 'results-changed')[0].results.revision, 1);
  const stranger = store.create(project, 'test-domain');
  assert.throws(() => other.turnEvents(stranger.id, turn), /another chat/);
});


test('chat titles derive concisely, rename validates, and auto titles never override a user rename', t => {
  const { project, store, openStore } = fixture(t);
  const chat = store.create(project, 'test-domain');
  assert.equal(chat.title, 'New chat');

  store.beginTurn(
    chat.id,
    '修改 Godot 场景 main.tscn：把 Box 节点的 BoxMesh 尺寸改为 Vector3(5, 4, 3)，把 Box 节点的位置改为 Vector3(0, 1, 0)，然后运行验证确认结果',
  );
  const derived = store.get(chat.id, project, 'test-domain').title;
  assert.ok([...derived].length <= 49, `derived title stays concise: ${derived}`);
  assert.ok(derived.endsWith('…'), 'truncated titles are marked');

  // The eligibility probe gates model requests: only an untouched derived title qualifies.
  assert.equal(store.autoTitleTarget(chat.id)?.task.startsWith('修改 Godot 场景'), true);
  assert.equal(store.autoTitleTarget('not-a-uuid'), null);

  // Short tasks and multiline tasks keep their first line, whitespace collapsed.
  const second = store.create(project, 'test-domain');
  store.beginTurn(second.id, '  调整一下\n盒子大小  再验证  ', null, false);
  assert.equal(store.get(second.id, project, 'test-domain').title, '调整一下');
  assert.ok(store.autoTitleTarget(second.id), 'single-turn derived chat is eligible');
  store.beginTurn(second.id, 'second turn', null, false);
  assert.equal(store.autoTitleTarget(second.id), null, 'multi-turn chats are never auto-titled');
  assert.equal(store.autoTitle(second.id, '太迟了'), false);

  // A model title lands only while the derived title is untouched.
  assert.equal(store.autoTitle(chat.id, '调整盒子尺寸与位置'), true);
  assert.equal(store.get(chat.id, project, 'test-domain').title, '调整盒子尺寸与位置');
  assert.equal(store.autoTitleTarget(chat.id), null, 'a refined chat is no longer eligible');
  assert.equal(store.autoTitle(chat.id, '不应再覆盖'), false, 'second auto title is ignored');
  assert.equal(store.autoTitle(chat.id, ''), false);
  assert.equal(store.autoTitle(chat.id, 'x'.repeat(101)), false);

  const renamed = store.rename(chat.id, project, 'test-domain', '  我的验证会话  ');
  assert.equal(renamed.title, '我的验证会话');
  assert.throws(() => store.rename(chat.id, project, 'test-domain', '   '), /chat title/);
  assert.throws(
    () => store.rename(chat.id, project, 'test-domain', 'x'.repeat(101)),
    /chat title/,
  );
  assert.equal(
    store.rename(chat.id, project, 'test-domain', 'a\nb').title,
    'a b',
    'newlines collapse to a single space',
  );
  const otherDomain = openStore();
  t.after(() => otherDomain.close());
  assert.throws(
    () => otherDomain.rename(chat.id, project, 'other-domain', 'x'),
    /unavailable/,
  );

  // A user rename wins over a late model title.
  const third = store.create(project, 'test-domain');
  store.beginTurn(third.id, '把盒子调大一点，你觉得合适就行，然后验证一下', null, false);
  store.rename(third.id, project, 'test-domain', '模糊任务');
  assert.equal(store.autoTitle(third.id, '模型起的名字'), false);
  assert.equal(store.get(third.id, project, 'test-domain').title, '模糊任务');

  // The custom-title flag is authoritative: renaming to the exact derived text
  // still counts as user-set, so equality alone can never reopen auto titling.
  const fourth = store.create(project, 'test-domain');
  const fourthTask = '把 Box 设为不可见';
  store.beginTurn(fourth.id, fourthTask, null, false);
  store.rename(fourth.id, project, 'test-domain', deriveChatTitle(fourthTask));
  assert.equal(
    store.autoTitleTarget(fourth.id),
    null,
    'rename to the derived text stays protected',
  );
  assert.equal(store.autoTitle(fourth.id, '模型标题'), false);

  // Renaming does not reorder the recency list.
  const before = store.list(project, 'test-domain').map(item => item.id);
  store.rename(before.at(-1), project, 'test-domain', '顺序不变');
  assert.deepEqual(
    store.list(project, 'test-domain').map(item => item.id),
    before,
  );
});

test('schema v1 databases gain the custom-title flag on open and newer schemas are rejected', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-chat-migrate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chatsDir = path.join(directory, 'chats');
  fs.mkdirSync(chatsDir);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(chatsDir, 'chats.sqlite'));
  db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, project_path TEXT NOT NULL, domain TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    INSERT INTO chats VALUES ('00000000-0000-4000-8000-000000000000', 'legacy', '/tmp/legacy', 'test-domain', '旧会话', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0);
    PRAGMA user_version = 1;`);
  db.close();

  const store = new ChatStore(chatsDir);
  t.after(() => store.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(
    store.db
      .prepare(
        "SELECT custom_title FROM chats WHERE id = '00000000-0000-4000-8000-000000000000'",
      )
      .get().custom_title,
    0,
    'legacy rows default to machine titles',
  );

  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const chat = store.create(project, 'test-domain');
  store.beginTurn(chat.id, '验证迁移后的行为', null, false);
  assert.ok(store.autoTitleTarget(chat.id), 'fresh chats stay eligible');
  store.rename(chat.id, project, 'test-domain', '人工标题');
  assert.equal(
    store.db.prepare('SELECT custom_title FROM chats WHERE id = ?').get(chat.id).custom_title,
    1,
  );
  assert.equal(store.autoTitleTarget(chat.id), null);

  const newer = new DatabaseSync(path.join(chatsDir, 'chats.sqlite'));
  newer.exec('PRAGMA user_version = 3');
  newer.close();
  assert.throws(() => new ChatStore(chatsDir), /newer schema/);
});
