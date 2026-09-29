const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {saveBindings} = require('./project-bindings.cjs');

function prepare(config) {
  if (fs.existsSync(path.join(config, 'projects.json'))) return;
  const project = path.join(config, 'chat-project'), other = path.join(config, 'other-project');
  fs.mkdirSync(project, {recursive: true}); fs.mkdirSync(other);
  saveBindings(config, {activeId: 'chat-test', projects: [{id: 'chat-test', name: 'Chat persistence test', path: fs.realpathSync(project), domain: 'chip'}, {id: 'other-test', name: 'Other project', path: fs.realpathSync(other), domain: 'chip'}]});
}
// SDK seam for desktop lifecycle tests; the separate integration test exercises the real pinned SDK/CLI.
function createSession(options) {
  const sessionDir = path.join(options.shareDir, 'sessions', crypto.createHash('md5').update(options.workDir).digest('hex'), options.sessionId);
  fs.mkdirSync(sessionDir, {recursive: true});
  const context = path.join(sessionDir, 'context.jsonl');
  return {sessionId: options.sessionId, close: async () => {}, prompt(task) {
    const count = fs.existsSync(context) ? fs.readFileSync(context, 'utf8').trim().split('\n').length : 0;
    fs.appendFileSync(context, JSON.stringify({role: 'user', content: task})+'\n');
    return {result: Promise.resolve({status: 'finished'}), async *[Symbol.asyncIterator]() {
      yield {type: 'ContentPart', payload: {type: 'text', text: `Remembered turn ${count + 1}.`}};
      yield {type: 'ApprovalRequest', payload: {id: `expired-${count}`, action: 'unused request', description: 'Historical approval'}};
      await new Promise(resolve => setTimeout(resolve, 150));
    }};
  }};
}
async function run(window, store) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 50));}
    throw Error(`Chat UI timed out: ${script}`);
  }
  async function send(task, count) {
    await evaluate(`(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(task)});area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(`document.querySelectorAll('.ia-chat-turn').length===${count}&&document.querySelectorAll('.ia-agent-minor').length>0&&!document.querySelector('.ia-composer textarea').disabled`);
    await wait(`!document.querySelector('.ia-approval button')`);
  }
  const stage = process.env.INDUSTRIAL_CHAT_SELFTEST_STAGE || 'first';
  try {
    await wait(`document.querySelector('.ia-chat-header b')?.innerText==='Chat persistence test'`);
    if (stage === 'first') {
      await send('Inspect netlist first turn', 1); await send('Inspect netlist second turn', 2);
      assert.ok(await evaluate(`document.querySelector('.ia-chat-scroll').innerText.includes('Remembered turn 2')`));
      await window.webContents.reload();
      await wait(`document.querySelectorAll('.ia-chat-turn').length===2`);
      assert.equal(await evaluate(`document.querySelectorAll('.ia-approval button').length`), 0);
    } else {
      await wait(`document.querySelectorAll('.ia-chat-turn').length===2`);
      assert.ok(await evaluate(`document.querySelector('.ia-chat-scroll').innerText.includes('first turn')`));
      await send('Inspect netlist third turn after app restart', 3);
      assert.ok(await evaluate(`document.querySelector('.ia-chat-scroll').innerText.includes('Remembered turn 3')`));
      const original = await evaluate(`window.viewerHost.chats().then(result=>result.activeId)`);
      await evaluate(`document.querySelector('.ia-new-chat').click()`);
      await wait(`document.querySelectorAll('.ia-chat-turn').length===0&&document.querySelectorAll('.ia-sidebar-chat').length===2`);
      const draft = await evaluate(`window.viewerHost.chats().then(result=>result.activeId)`);
      assert.equal(await evaluate(`document.querySelector('.ia-new-chat').disabled`), true, 'an empty active chat disables New chat');
      fs.writeFileSync(path.join(store.directory, 'desktop-empty-chat.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate(`Array.from({length:20},()=>document.querySelector('.ia-new-chat').click())`);
      assert.equal(await evaluate(`window.viewerHost.chats().then(result=>result.chats.length)`), 2);
      const repeated = await evaluate(`Promise.all(Array.from({length:20},()=>window.viewerHost.newChat())).then(results=>results.map(result=>result.chat.id))`);
      assert.deepEqual([...new Set(repeated)], [draft], 'IPC requests also reuse the draft');
      await window.webContents.reload();
      await wait(`document.querySelectorAll('.ia-chat-turn').length===0&&document.querySelectorAll('.ia-sidebar-chat').length===2`);
      // Returning from the project page to the same empty chat keeps the unsent draft.
      await evaluate(`(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'Unsent draft');area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(`document.querySelector('.ia-composer textarea').value==='Unsent draft'`);
      await evaluate(`document.querySelector('.ia-project-row').click()`);
      await wait(`Boolean(document.querySelector('.ia-project-page'))`);
      await evaluate(`document.querySelector('.ia-project-start').click()`);
      await wait(`document.querySelector('.ia-composer textarea')?.value==='Unsent draft'`);
      await evaluate(`Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(item=>item.innerText.includes('first turn')).click()`);
      await wait(`document.querySelectorAll('.ia-chat-turn').length===3`);
      await evaluate(`Array.from({length:20},()=>document.querySelector('.ia-new-chat').click())`);
      await wait(`document.querySelectorAll('.ia-chat-turn').length===0&&!document.querySelector('.ia-composer textarea').value&&document.querySelectorAll('.ia-sidebar-chat').length===2`);
      assert.equal(await evaluate(`window.viewerHost.chats().then(result=>result.activeId)`), draft, 'reuse the existing draft from history');
      await evaluate(`Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(item=>item.innerText.includes('first turn')).click()`);
      await wait(`document.querySelectorAll('.ia-chat-turn').length===3`);
      const project = await evaluate(`window.viewerHost.projectBindings().then(result=>result.projectDir)`);
      const chat = store.create(project, 'chip');
      for (let index = 0; index < 12; index++) {const turn = store.beginTurn(chat.id, `Archived message ${index}`, null, false); store.append(turn, {type: 'text', text: `Historical response ${index}`}); store.finish(turn, 'finished');}
      await evaluate(`window.viewerHost.selectChat(${JSON.stringify(chat.id)})`);
      await window.webContents.reload();
      await wait(`document.querySelectorAll('.ia-chat-turn').length===10&&Boolean(document.querySelector('.ia-history-more'))`);
      await evaluate(`document.querySelector('.ia-history-more').click()`);
      await wait(`document.querySelectorAll('.ia-chat-turn').length===12&&!document.querySelector('.ia-history-more')`);
      await evaluate(`window.viewerHost.selectChat(${JSON.stringify(original)})`);
      await window.webContents.reload(); await wait(`document.querySelectorAll('.ia-chat-turn').length===3`);
      await evaluate(`Array.from(document.querySelectorAll('.ia-project-row')).find(item=>item.innerText.includes('Other project')).click()`);
      await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Other project'`);
      assert.equal(await evaluate(`window.viewerHost.chatHistory({id:${JSON.stringify(original)}}).then(()=>false,()=>true)`), true, 'cross-project history rejected');
      assert.equal(await evaluate(`window.viewerHost.deleteChat(${JSON.stringify(original)}).then(()=>false,()=>true)`), true, 'cross-project deletion rejected');
      await evaluate(`Array.from(document.querySelectorAll('.ia-project-row')).find(item=>item.innerText.includes('Chat persistence')).click()`);
      await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Chat persistence test'`);
      await wait(`Array.from(document.querySelectorAll('.ia-sidebar-chat')).some(item=>item.innerText.includes('first turn')&&!item.disabled)`);
      await evaluate(`Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(item=>item.innerText.includes('first turn')).click()`);
      await wait(`document.querySelectorAll('.ia-chat-turn').length===3`);
      await evaluate(`document.querySelector('button[aria-label="Delete chat New chat"]').click()`);
      await wait(`document.querySelectorAll('.ia-sidebar-chat').length===2`);
      // A historical scope must not restore resources disabled since the last turn.
      await evaluate(`window.viewerHost.resourceSet({projectId:'chat-test',kind:'skill',id:'chip.netlist.inspect',mode:'disabled'})`);
      await evaluate(`window.viewerHost.selectChat(${JSON.stringify(original)})`);
      await evaluate(`window.viewerHost.runAgent('Inspect netlist third turn after app restart')`);
      await wait(`window.viewerHost.chatHistory({id:${JSON.stringify(original)}}).then(history=>history.turns.length===4&&history.turns.at(-1).status==='finished')`);
      const restored = await evaluate(`window.viewerHost.chatHistory({id:${JSON.stringify(original)}})`);
      assert.deepEqual(restored.turns.at(-1).broker.scope.skills, []);
      assert.ok(restored.turns.at(-1).events.some(event=>event.type==='text'&&event.text==='Remembered turn 1.'));
      await window.webContents.reload(); await wait(`document.querySelectorAll('.ia-chat-turn').length===4`);
    }
    assert.ok(await evaluate(`document.querySelector('.ia-sidebar-chat span').getBoundingClientRect().width>60`), 'sidebar chat title remains visible');
    const evidence = path.join(store.directory, `desktop-chat-${stage}.png`);
    fs.writeFileSync(evidence, (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ok: true, stage, desktopRestart: stage === 'second', history: true, approvalsExpired: true, evidence}));
  } catch (error) {fs.writeFileSync(path.join(store.directory, 'desktop-chat-failure.png'), (await window.webContents.capturePage()).toPNG()); throw error;}
}
module.exports = {prepare, createSession, run};
