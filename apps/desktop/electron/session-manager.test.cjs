const test = require('node:test');
const assert = require('node:assert/strict');
const {SessionManager} = require('./session-manager.cjs');
test('running chats remain bound to their own project and scope across navigation; settings affect only their project', async () => {
  const manager = new SessionManager();
  const projectA = {id: 'a', path: '/project/a', domain: 'example'};
  const projectB = {id: 'b', path: '/project/b', domain: 'example'};
  const a1 = manager.get(projectA, 'a1'), a2 = manager.get(projectA, 'a2'), b = manager.get(projectB, 'b');
  a1.scope = {tools: ['a.tool']}; a2.scope = {tools: ['a.other']}; b.scope = {tools: ['b.tool']};
  a1.agent = {running: true}; a2.release = () => {};
  assert.equal(manager.running().length, 2);
  assert.equal(manager.get(projectA, 'a1'), a1);
  assert.throws(() => manager.get(projectB, 'a1'), /another project/);
  assert.deepEqual(a1.scope.tools, ['a.tool']); assert.deepEqual(a2.scope.tools, ['a.other']);
  await assert.rejects(manager.remove(projectA, 'a1'), /Stop this chat/);
  await assert.rejects(manager.reset('a'), /running chats/);
  await manager.reset('b'); assert.equal(manager.entries.has('b'), false);
  assert.equal(manager.entries.has('a1'), true);
  a1.agent.running = false; a1.agent.close = async () => {}; a2.release = undefined;
  await manager.reset(); assert.equal(manager.entries.size, 0);
});
test('shutdown closes and releases every session even when one close fails', async () => {
  const manager = new SessionManager();
  let released = 0;
  for (const id of ['one', 'two']) {const entry = manager.get({id: 'p', path: '/p', domain: 'example'}, id); entry.agent = {close: async () => {if (id === 'one') throw Error('shutdown failure');}}; entry.release = () => released++;}
  await assert.rejects(manager.close(), /shutdown failure/);
  assert.equal(released, 2);
});
test('deleting an idle chat reserves it until its native session has closed', async () => {
  const manager = new SessionManager();
  const project = {id: 'p', path: '/p', domain: 'example'};
  const entry = manager.get(project, 'chat');
  let finish;
  entry.agent = {close: () => new Promise(resolve => {finish = resolve;})};
  const removing = manager.remove(project, 'chat');
  assert.equal(manager.busy(entry), true);
  await assert.rejects(manager.remove(project, 'chat'), /Stop this chat/);
  finish(); await removing;
  assert.equal(manager.entries.has('chat'), false);
});
