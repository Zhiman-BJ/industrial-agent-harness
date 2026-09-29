const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {saveBindings} = require('./project-bindings.cjs');
let evidence;
const turns = new Map();
function prepare(config) {
  evidence = path.dirname(config);
  const projects = ['parallel-a', 'parallel-b'].map(id => {const folder = path.join(config, id); fs.mkdirSync(folder, {recursive: true}); return {id, name: id === 'parallel-a' ? 'Parallel project A' : 'Parallel project B', path: folder, domain: 'chip'};});
  saveBindings(config, {activeId: 'parallel-a', projects});
}
function createSession(options) {
  return {sessionId: options.sessionId || crypto.randomUUID(), close: async () => {}, prompt(content) {
    const text = typeof content === 'string' ? content : content[0].text;
    const marker = /User task: (SESSION_[A-Z]+)/.exec(text)?.[1];
    assert.ok(marker);
    let resume, end;
    const approval = new Promise(resolve => {resume = resolve;});
    const finish = new Promise(resolve => {end = resolve;});
    const state = {marker, workDir: options.workDir, approved: false, stopped: false, finish: () => end()};
    turns.set(marker, state);
    return {result: finish.then(() => ({status: state.stopped ? 'cancelled' : 'finished'})), interrupt: async () => {state.stopped = true; resume(); end();}, approve: async (id, response) => {assert.equal(id, 'same-approval-id'); assert.equal(response, 'approve'); state.approved = true; resume();}, async *[Symbol.asyncIterator]() {
      yield {type: 'ApprovalRequest', payload: {id: 'same-approval-id', action: 'test approval', description: marker}};
      await approval;
      if (!state.stopped) yield {type: 'ContentPart', payload: {type: 'text', text: `${marker}_ONLY`}};
      await finish;
    }};
  }};
}
async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {const deadline = Date.now() + 15000; while (Date.now() < deadline) {if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 100));} throw Error(`Parallel UI timed out: ${script}`);}
  async function submit(marker) {
    await evaluate(`(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'${marker}');area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(`document.querySelector('.ia-approval')?.innerText.includes('${marker}')`);
  }
  async function newChat() {await evaluate(`document.querySelector('.ia-new-chat').click()`); await wait(`document.querySelector('.ia-composer textarea')&&!document.querySelector('.ia-approval')&&!document.querySelector('.ia-composer textarea').disabled`);}
  async function openChat(marker) {await wait(`Array.from(document.querySelectorAll('.ia-sidebar-chat')).some(button=>button.innerText.includes('${marker}')&&!button.disabled)`); await evaluate(`Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(button=>button.innerText.includes('${marker}')).click()`); await wait(`document.querySelector('.ia-approval')?.innerText.includes('${marker}')`);}
  try {
    await wait(`document.querySelector('.ia-chat-header b')?.innerText==='Parallel project A'`);
    await submit('SESSION_ALPHA');
    const alphaId = await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`);
    assert.equal(await evaluate(`document.querySelector('.ia-new-chat').disabled`), false);
    await newChat(); await submit('SESSION_BETA');
    const betaId = await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`);
    assert.equal(await evaluate(`window.viewerHost.runAgent({task:'SESSION_BETA',chatId:${JSON.stringify(betaId)}}).then(()=>false,()=>true)`), true, 'one chat cannot start an overlapping turn');
    assert.equal(await evaluate(`window.viewerHost.deleteChat(${JSON.stringify(betaId)}).then(()=>false,()=>true)`), true, 'deleting a running chat is rejected');
    assert.equal(await evaluate(`window.viewerHost.interruptAgent(${JSON.stringify(alphaId)}).then(()=>false,()=>true)`), true, 'stale Stop cannot interrupt a background chat');
    await wait(`document.querySelectorAll('.ia-session-running.awaiting-approval').length===2`);
    assert.equal(await evaluate(`window.viewerHost.approveAgent('same-approval-id','approve',${JSON.stringify(alphaId)}).then(()=>false,()=>true)`), true, 'stale chat approval is rejected');
    assert.equal(turns.size, 2);
    assert.equal(turns.get('SESSION_ALPHA').approved, false);
    assert.equal(turns.get('SESSION_BETA').approved, false);
    await openChat('SESSION_ALPHA');
    await evaluate(`document.querySelector('.ia-approval button').click()`);
    await wait(`document.querySelector('.ia-agent-flow')?.innerText.includes('SESSION_ALPHA_ONLY')`);
    assert.equal(turns.get('SESSION_ALPHA').approved, true);
    assert.equal(turns.get('SESSION_BETA').approved, false, 'same approval ID is isolated by chat');
    await evaluate(`Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.innerText.includes('Parallel project B')).click()`);
    await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Parallel project B'`);
    await evaluate(`document.querySelector('.ia-project-start').click()`);
    await wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
    await submit('SESSION_GAMMA');
    assert.equal(await evaluate(`window.viewerHost.chatHistory({id:${JSON.stringify(alphaId)}}).then(()=>false,()=>true)`), true, 'history remains project scoped');
    assert.equal(await evaluate(`window.viewerHost.runAgent({task:'SESSION_ALPHA',chatId:${JSON.stringify(alphaId)}}).then(()=>false,()=>true)`), true, 'forged run cannot target another chat');
    assert.equal(await evaluate(`window.viewerHost.resourceSet({projectId:'parallel-b',kind:'skill',id:'chip.netlist.inspect',mode:'disabled'}).then(()=>false,()=>true)`), true, 'running project resource policy cannot change');
    assert.notEqual(turns.get('SESSION_GAMMA').workDir, turns.get('SESSION_ALPHA').workDir);
    assert.equal(await evaluate(`window.viewerHost.modelGet().then(profile=>window.viewerHost.modelSave(profile)).then(()=>false,()=>true)`), true, 'global model change blocks while any chat runs');
    await evaluate(`document.querySelector('button[title="Stop agent"]').click()`);
    await wait(`document.querySelector('.ia-agent-flow')?.innerText.includes('cancelled')&&!document.querySelector('button[title="Stop agent"]')`);
    assert.equal(turns.get('SESSION_GAMMA').stopped, true);
    assert.equal(turns.get('SESSION_ALPHA').stopped, false);
    assert.equal(turns.get('SESSION_BETA').stopped, false);
    assert.equal(await evaluate(`window.viewerHost.resourceSet({projectId:'parallel-b',kind:'skill',id:'chip.netlist.inspect',mode:'disabled'}).then(()=>true,()=>false)`), true, 'idle project settings can change while another project runs');
    await evaluate(`Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.innerText.includes('Parallel project A')).click()`);
    await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Parallel project A'`);
    await openChat('SESSION_BETA');
    await evaluate(`document.querySelector('.ia-approval button').click()`);
    await wait(`document.querySelector('.ia-agent-flow')?.innerText.includes('SESSION_BETA_ONLY')`);
    assert.equal(await evaluate(`document.querySelector('.ia-chat-scroll').innerText.includes('SESSION_ALPHA_ONLY')`), false, 'other chat output does not leak');
    fs.writeFileSync(path.join(evidence, 'parallel-sessions.png'), (await window.webContents.capturePage()).toPNG());
    turns.get('SESSION_BETA').finish(); turns.get('SESSION_ALPHA').finish();
    await wait(`window.viewerHost.chats().then(list=>!list.sessions.some(session=>session.running))`);
    // A persisted running turn without a local native actor is controlled by
    // its original window. Restoring its history cannot resurrect approvals.
    const {ChatStore} = require('@industrial-agent-harness/harness-core');
    const store = new ChatStore(path.join(evidence, 'chats'));
    const binding = await evaluate(`window.viewerHost.projectBindings().then(list=>list.projects.find(project=>project.id===list.activeId))`);
    const external = store.create(binding.path, binding.domain);
    const release = store.acquire(external.id);
    try {
      const externalTurn = store.beginTurn(external.id, 'OTHER_WINDOW_TASK');
      store.append(externalTurn, {type: 'approval', id: 'external', action: 'external approval', description: 'OTHER_WINDOW_APPROVAL'});
      await evaluate(`window.viewerHost.selectChat(${JSON.stringify(external.id)})`);
      await window.webContents.reload();
      await wait(`document.querySelector('.ia-chat-scroll')?.innerText.includes('OTHER_WINDOW_TASK')`);
      assert.equal(await evaluate(`Boolean(document.querySelector('.ia-approval')||document.querySelector('button[title="Stop agent"]'))`), false, 'historical approvals and Stop belong to the original window');
      assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').disabled`), true);
      store.finish(externalTurn, 'cancelled'); release();
      await wait(`!document.querySelector('.ia-composer textarea').disabled`);
    } finally {release(); store.close();}
    console.log(JSON.stringify({ok: true, sameProjectOverlap: true, crossProjectOverlap: true, backgroundApproval: true, approvalIdIsolation: true, stopIsolation: true, streamIsolation: true, globalModelGuard: true, restoredOwnerBoundary: true, evidence}));
  } catch (error) {fs.writeFileSync(path.join(evidence, 'parallel-failure.png'), (await window.webContents.capturePage()).toPNG()); throw error;}
}
module.exports = {prepare, createSession, run};
