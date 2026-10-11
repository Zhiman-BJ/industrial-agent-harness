const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { saveBindings } = require('./project-bindings.cjs');
const { createKimiPaths } = require('@industrial-agent-harness/agent-kimi/src/legacy-paths.cjs');
let evidence;
const turns = new Map();
let delayedHistory;
let releaseHistory;
let holdHistory = false;
function historyResponse(history) {
  if (
    holdHistory &&
    history.turns.at(-1)?.task === 'SESSION_LATE' &&
    history.turns.at(-1)?.status === 'running'
  ) {
    delayedHistory = history;
    return new Promise(resolve => {
      releaseHistory = () => {
        holdHistory = false;
        resolve(history);
      };
    });
  }
  return history;
}
function prepare(config) {
  evidence = path.dirname(config);
  const projects = ['parallel-a', 'parallel-b'].map(id => {
    const folder = path.join(config, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'project.v'), 'module project; endmodule\n');
    return {
      id,
      name: id === 'parallel-a' ? 'Parallel project A' : 'Parallel project B',
      path: fs.realpathSync(folder),
      domain: 'chip',
    };
  });
  saveBindings(config, { activeId: 'parallel-a', projects });
}
function createSession(options) {
  const sessionId = options.sessionId || crypto.randomUUID();
  const nativeDirectory = createKimiPaths(options.shareDir).sessionDir(options.workDir, sessionId);
  fs.mkdirSync(nativeDirectory, { recursive: true });
  let current;
  return {
    sessionId,
    close: async () => {
      current?.stop();
    },
    prompt(content) {
      const text = typeof content === 'string' ? content : content[0].text;
      const marker = /User task: (SESSION_[A-Z]+)/.exec(text)?.[1];
      assert.ok(marker);
      let resume, end;
      const approval = new Promise(resolve => {
        resume = resolve;
      });
      const finish = new Promise(resolve => {
        end = resolve;
      });
      const state = {
        marker,
        workDir: options.workDir,
        approvalMode: options.yoloMode ? 'auto' : 'ask',
        approved: false,
        stopped: false,
        interrupts: 0,
        stop: () => {
          state.stopped = true;
          resume();
          end();
        },
        finish: () => end(),
      };
      current = state;
      turns.set(marker, state);
      fs.appendFileSync(
        path.join(nativeDirectory, 'context.jsonl'),
        JSON.stringify({ role: 'user', content: text }) + '\n',
      );
      return {
        result: finish.then(() => ({ status: state.stopped ? 'cancelled' : 'finished' })),
        interrupt: async () => {
          state.interrupts++;
          state.stop();
        },
        approve: async (id, response) => {
          assert.equal(id, 'same-approval-id');
          assert.equal(response, 'approve');
          state.approved = true;
          resume();
        },
        respondQuestion: async (rpcId, id, answers) => {
          assert.equal(id, 'same-question-id');
          assert.equal(answers[marker], 'Continue');
          state.approved = true;
          resume();
        },
        async *[Symbol.asyncIterator]() {
          if (marker === 'SESSION_AUTO') {
            assert.equal(options.yoloMode, true, 'this chat passes its own mode to the kernel');
            resume();
          } else
            yield marker === 'SESSION_THETA'
              ? {
                  type: 'QuestionRequest',
                  payload: {
                    id: 'same-question-id',
                    tool_call_id: 'question',
                    questions: [
                      {
                        question: marker,
                        header: 'Test',
                        multi_select: false,
                        options: [
                          { label: 'Continue', description: 'Continue this chat' },
                          { label: 'Wait', description: 'Keep waiting' },
                        ],
                      },
                    ],
                  },
                }
              : {
                  type: 'ApprovalRequest',
                  payload: { id: 'same-approval-id', action: 'test approval', description: marker },
                };
          await approval;
          if (!state.stopped)
            yield { type: 'ContentPart', payload: { type: 'text', text: `${marker}_ONLY` } };
          await finish;
        },
      };
    },
  };
}
async function run(window) {
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw Error(`Parallel UI evaluation failed: ${script}`, { cause: error });
    }
  };
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Parallel UI timed out: ${script}`);
  }
  async function submit(marker) {
    await evaluate(
      `(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'${marker}');area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(
      `document.querySelector('.ia-approval,.ia-question')?.innerText.includes('${marker}')`,
    );
    await wait(`!document.querySelector('.ia-new-chat').disabled`);
  }
  async function newChat() {
    await evaluate(`document.querySelector('.ia-new-chat').click()`);
    await wait(
      `document.querySelector('.ia-composer textarea')&&!document.querySelector('.ia-approval')&&!document.querySelector('.ia-composer textarea').disabled`,
    );
  }
  async function openChat(marker) {
    await wait(
      `Array.from(document.querySelectorAll('.ia-sidebar-chat')).some(button=>button.innerText.includes('${marker}')&&!button.disabled)`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(button=>button.innerText.includes('${marker}')).click()`,
    );
    await wait(`document.querySelector('.ia-approval')?.innerText.includes('${marker}')`);
  }
  try {
    await wait(`document.querySelector('.ia-chat-header b')?.innerText==='Parallel project A'`);
    await submit('SESSION_ALPHA');
    const alphaId = await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`);
    assert.equal(turns.get('SESSION_ALPHA').approvalMode, 'ask');
    await evaluate(`document.querySelector('.ia-layout-toggle').click()`);
    await wait(`Boolean(document.querySelector('.layout-tabs'))`);
    await evaluate(`document.querySelector('.ia-tab-add').click()`);
    await wait(`Boolean(document.querySelector('.ia-file-list button[title="project.v"]'))`);
    await evaluate(`document.querySelector('.ia-file-list button[title="project.v"]').click()`);
    await wait(`Boolean(document.querySelector('.ia-source-panel pre'))`);
    await wait(
      `document.querySelector('#tab-chat [role="status"]')?.getAttribute('aria-label') === 'Awaiting approval'`,
    );
    assert.equal(await evaluate(`document.querySelector('.ia-chat').hidden`), true);
    assert.equal(
      turns.get('SESSION_ALPHA').approved,
      false,
      'Viewing a file must not approve or interrupt a task',
    );
    await evaluate(`document.getElementById('tab-chat').click()`);
    await wait(
      `!document.querySelector('.ia-chat').hidden && document.querySelector('.ia-approval')?.innerText.includes('SESSION_ALPHA')`,
    );

    assert.equal(await evaluate(`document.querySelector('.ia-new-chat').disabled`), false);
    await newChat();
    await submit('SESSION_BETA');
    const betaId = await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`);
    assert.equal(await evaluate(`document.querySelector('.ia-chat-approval-mode').disabled`), true);
    assert.equal(
      await evaluate(
        `window.viewerHost.setChatApprovalMode({projectId:'parallel-a',chatId:${JSON.stringify(betaId)},mode:'auto'}).then(()=>false,()=>true)`,
      ),
      true,
      'running chat approval mode cannot change',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.setChatApprovalMode({projectId:'parallel-a',chatId:${JSON.stringify(alphaId)},mode:'auto'}).then(()=>false,()=>true)`,
      ),
      true,
      'stale approval setting cannot target a background chat',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.runAgent({task:'SESSION_BETA',chatId:${JSON.stringify(betaId)}}).then(()=>false,()=>true)`,
      ),
      true,
      'one chat cannot start an overlapping turn',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.deleteChat(${JSON.stringify(betaId)}).then(()=>false,()=>true)`,
      ),
      true,
      'deleting a running chat is rejected',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.interruptAgent(${JSON.stringify(alphaId)}).then(()=>false,()=>true)`,
      ),
      true,
      'stale Stop cannot interrupt a background chat',
    );
    await wait(`document.querySelectorAll('.ia-session-running.awaiting-approval').length===2`);
    assert.equal(
      await evaluate(
        `window.viewerHost.approveAgent('same-approval-id','approve',${JSON.stringify(alphaId)}).then(()=>false,()=>true)`,
      ),
      true,
      'stale chat approval is rejected',
    );
    assert.equal(turns.size, 2);
    assert.equal(turns.get('SESSION_ALPHA').approved, false);
    assert.equal(turns.get('SESSION_BETA').approved, false);
    await openChat('SESSION_ALPHA');
    await evaluate(`document.querySelector('.ia-approval button').click()`);
    await wait(
      `document.querySelector('.ia-agent-flow')?.innerText.includes('SESSION_ALPHA_ONLY')`,
    );
    assert.equal(turns.get('SESSION_ALPHA').approved, true);
    assert.equal(turns.get('SESSION_BETA').approved, false, 'same approval ID is isolated by chat');
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.innerText.includes('Parallel project B')).click()`,
    );
    await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Parallel project B'`);
    assert.equal(
      await evaluate(`document.querySelectorAll('.ia-file-view').length`),
      0,
      'Project navigation must release all previous file sessions',
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('.ia-workbench-tabbar [role="tab"]').length`),
      1,
    );
    await evaluate(`document.querySelector('.ia-project-start').click()`);
    await wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
    await submit('SESSION_GAMMA');
    assert.equal(
      await evaluate(
        `window.viewerHost.chatHistory({id:${JSON.stringify(alphaId)}}).then(()=>false,()=>true)`,
      ),
      true,
      'history remains project scoped',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.runAgent({task:'SESSION_ALPHA',chatId:${JSON.stringify(alphaId)}}).then(()=>false,()=>true)`,
      ),
      true,
      'forged run cannot target another chat',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.resourceSet({projectId:'parallel-b',kind:'skill',id:'chip.netlist.inspect',mode:'disabled'}).then(()=>false,()=>true)`,
      ),
      true,
      'running project resource policy cannot change',
    );
    assert.notEqual(turns.get('SESSION_GAMMA').workDir, turns.get('SESSION_ALPHA').workDir);
    assert.equal(
      await evaluate(
        `window.viewerHost.modelGet().then(profile=>window.viewerHost.modelSave(profile)).then(()=>false,()=>true)`,
      ),
      true,
      'global model change blocks while any chat runs',
    );
    await evaluate(`document.querySelector('button[title="Stop agent"]').click()`);
    await wait(
      `document.querySelector('.ia-agent-flow')?.innerText.includes('cancelled')&&!document.querySelector('button[title="Stop agent"]')`,
    );
    assert.equal(turns.get('SESSION_GAMMA').stopped, true);
    assert.equal(turns.get('SESSION_ALPHA').stopped, false);
    assert.equal(turns.get('SESSION_BETA').stopped, false);
    assert.equal(
      await evaluate(
        `window.viewerHost.resourceSet({projectId:'parallel-b',kind:'skill',id:'chip.netlist.inspect',mode:'disabled'}).then(()=>true,()=>false)`,
      ),
      true,
      'idle project settings can change while another project runs',
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.innerText.includes('Parallel project A')).click()`,
    );
    await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Parallel project A'`);
    await openChat('SESSION_BETA');
    await evaluate(`document.querySelector('.ia-approval button').click()`);
    await wait(`document.querySelector('.ia-agent-flow')?.innerText.includes('SESSION_BETA_ONLY')`);
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-chat-scroll').innerText.includes('SESSION_ALPHA_ONLY')`,
      ),
      false,
      'other chat output does not leak',
    );
    fs.writeFileSync(
      path.join(evidence, 'parallel-sessions.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    turns.get('SESSION_BETA').finish();
    turns.get('SESSION_ALPHA').finish();
    await wait(
      `window.viewerHost.chats().then(list=>!list.sessions.some(session=>session.running))`,
    );
    await wait(`Boolean(document.querySelector('.ia-chat-approval-mode:not(:disabled)'))`);
    await evaluate(
      `(() => {const select=document.querySelector('.ia-chat-approval-mode');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'auto');select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(
      `window.viewerHost.chats().then(list=>list.chats.find(chat=>chat.id===${JSON.stringify(betaId)})?.approvalMode==='auto')`,
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.chatHistory({id:${JSON.stringify(alphaId)}}).then(history=>history.chat.approvalMode)`,
      ),
      'ask',
    );
    await window.webContents.reload();
    await wait(`document.querySelector('.ia-chat-approval-mode')?.value==='auto'`);
    await evaluate(`window.viewerHost.resolve({task:'SESSION_AUTO'})`);
    await evaluate(`window.viewerHost.runAgent('SESSION_AUTO')`);
    await wait(
      `window.viewerHost.chatHistory({id:${JSON.stringify(betaId)}}).then(history=>history.turns.at(-1)?.events.some(event=>event.type==='text'&&event.text.includes('SESSION_AUTO_ONLY')))`,
    );
    assert.equal(turns.get('SESSION_AUTO').approvalMode, 'auto');
    assert.equal(await evaluate(`Boolean(document.querySelector('.ia-approval'))`), false);
    turns.get('SESSION_AUTO').finish();
    await wait(
      `window.viewerHost.chats().then(list=>!list.sessions.some(session=>session.running))`,
    );
    await evaluate(`window.viewerHost.selectChat(${JSON.stringify(alphaId)})`);
    await window.webContents.reload();
    await wait(`document.querySelector('.ia-chat-approval-mode:not(:disabled)')?.value==='ask'`);
    await newChat();
    assert.equal(await evaluate(`document.querySelector('.ia-chat-approval-mode').value`), 'ask');
    // A persisted running turn without a local native actor is controlled by
    // its original window. Restoring its history cannot resurrect approvals.
    const { ChatStore } = require('@industrial-agent-harness/harness-core');
    const store = new ChatStore(path.join(evidence, 'chats'));
    const binding = await evaluate(
      `window.viewerHost.projectBindings().then(list=>list.projects.find(project=>project.id===list.activeId))`,
    );
    const external = store.create(binding.path, binding.domain);
    const release = store.acquire(external.id);
    try {
      const externalTurn = store.beginTurn(external.id, 'OTHER_WINDOW_TASK');
      store.append(externalTurn, {
        type: 'approval',
        id: 'external',
        action: 'external approval',
        description: 'OTHER_WINDOW_APPROVAL',
      });
      await evaluate(`window.viewerHost.selectChat(${JSON.stringify(external.id)})`);
      await window.webContents.reload();
      await wait(
        `document.querySelector('.ia-chat-scroll')?.innerText.includes('OTHER_WINDOW_TASK')`,
      );
      assert.equal(
        await evaluate(
          `Boolean(document.querySelector('.ia-approval')||document.querySelector('button[title="Stop agent"]'))`,
        ),
        false,
        'historical approvals and Stop belong to the original window',
      );
      assert.equal(
        await evaluate(`document.querySelector('.ia-composer textarea').disabled`),
        true,
      );
      store.finish(externalTurn, 'cancelled');
      release();
      await wait(`!document.querySelector('.ia-composer textarea').disabled`);
    } finally {
      release();
      store.close();
    }
    // Deliberately interleave real renderer actions, main-process IPC, held SDK
    // turns, resource rejection, old history replies and a renderer reload.
    const markers = ['SESSION_DELTA', 'SESSION_EPSILON', 'SESSION_ZETA', 'SESSION_THETA'];
    const ids = new Map();
    for (const marker of markers) {
      await newChat();
      await submit(marker);
      ids.set(marker, await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`));
    }
    await wait(`document.querySelectorAll('.ia-session-running').length===4`);
    await newChat();
    await evaluate(
      `(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'SESSION_IOTA');area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(
      `document.querySelector('.ia-chat-scroll')?.innerText.includes('shared limit of 4')&&!document.querySelector('.ia-composer textarea').disabled`,
    );
    assert.equal(turns.has('SESSION_IOTA'), false, 'fifth task never reaches the kernel');
    let switches = 0;
    for (let index = 0; index < 160; index++) {
      const marker = markers[index % markers.length];
      const next = markers[(index + 1) % markers.length];
      await wait(`!document.querySelector('.ia-sidebar-chat').disabled`);
      // Both clicks happen before React can render the disabled state.
      await evaluate(
        `(() => {const buttons=Array.from(document.querySelectorAll('.ia-sidebar-chat'));buttons.find(button=>button.innerText.includes('${marker}')).click();buttons.find(button=>button.innerText.includes('${next}')).click();})()`,
      );
      await wait(
        `document.querySelector('.ia-sidebar-chat[aria-current="page"]')?.innerText.includes('${marker}')&&document.querySelector('.ia-approval,.ia-question')?.innerText.includes('${marker}')&&!document.querySelector('.ia-sidebar-chat').disabled`,
      );
      assert.equal(
        await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`),
        ids.get(marker),
      );
      assert.equal(
        await evaluate(
          `window.viewerHost.chats().then(list=>list.sessions.filter(item=>item.running).length)`,
        ),
        4,
      );
      switches++;
      if (index % 8 === 0) {
        await evaluate(
          `Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.innerText.includes('Parallel project B')).click()`,
        );
        await wait(
          `document.querySelector('.ia-project-page h1')?.innerText==='Parallel project B'&&!document.querySelector('.ia-project-row').disabled`,
        );
        await evaluate(
          `Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.innerText.includes('Parallel project A')).click()`,
        );
        await wait(
          `document.querySelector('.ia-project-page h1')?.innerText==='Parallel project A'&&!document.querySelector('.ia-project-row').disabled`,
        );
        switches += 2;
      }
    }
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(button=>button.innerText.includes('SESSION_THETA')).click()`,
    );
    await wait(
      `document.querySelector('.ia-question')?.innerText.includes('SESSION_THETA')&&!document.querySelector('.ia-sidebar-chat').disabled`,
    );
    await window.webContents.reload();
    await wait(
      `document.querySelector('.ia-question')?.innerText.includes('SESSION_THETA')&&Boolean(document.querySelector('button[title="Stop agent"]'))`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-question label')).find(label=>label.innerText.includes('Continue')).querySelector('input').click()`,
    );
    await wait(`!document.querySelector('.ia-question button[type="submit"]').disabled`);
    await evaluate(`document.querySelector('.ia-question button[type="submit"]').click()`);
    await wait(
      `document.querySelector('.ia-question-resolved')?.innerText.includes('Question answered')`,
    );
    assert.equal(turns.get('SESSION_DELTA').approved, false);
    for (const marker of markers) {
      await evaluate(
        `Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(button=>button.innerText.includes('${marker}')).click()`,
      );
      await wait(
        `document.querySelector('.ia-sidebar-chat[aria-current="page"]')?.innerText.includes('${marker}')&&!document.querySelector('.ia-sidebar-chat').disabled`,
      );
      await evaluate(
        `(() => {const button=document.querySelector('button[title="Stop agent"]');button.click();button.click();})()`,
      );
      await wait(
        `!document.querySelector('button[title="Stop agent"]')&&!document.querySelector('.ia-composer textarea').disabled`,
      );
      assert.equal(turns.get(marker).interrupts, 1);
    }
    // Hold the snapshot captured while running, finish the turn, then deliver
    // that obsolete snapshot after the final live events have reached React.
    await newChat();
    holdHistory = true;
    await evaluate(
      `(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'SESSION_LATE');area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(`document.querySelector('.ia-approval')?.innerText.includes('SESSION_LATE')`);
    const historyDeadline = Date.now() + 15000;
    while (!delayedHistory && Date.now() < historyDeadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(delayedHistory);
    await evaluate(`document.querySelector('.ia-approval button').click()`);
    turns.get('SESSION_LATE').finish();
    await wait(`document.querySelector('.ia-chat-scroll')?.innerText.includes('finished')`);
    releaseHistory();
    await wait(
      `!document.querySelector('.ia-new-chat').disabled&&!document.querySelector('.ia-composer textarea').disabled`,
    );
    assert.equal(
      await evaluate(
        `Boolean(document.querySelector('.ia-approval')||document.querySelector('button[title="Stop agent"]'))`,
      ),
      false,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-chat-scroll').innerText.split('SESSION_LATE_ONLY').length-1`,
      ),
      1,
    );
    const lateId = await evaluate(`window.viewerHost.chats().then(list=>list.activeId)`);
    await evaluate(`window.viewerHost.deleteChat(${JSON.stringify(lateId)})`);
    await newChat();
    await submit('SESSION_FINAL');
    // Leave one active approval for the normal app shutdown path to clean up.
    console.log(
      JSON.stringify({
        ok: true,
        sameProjectOverlap: true,
        crossProjectOverlap: true,
        backgroundApproval: true,
        approvalIdIsolation: true,
        stopIsolation: true,
        streamIsolation: true,
        globalModelGuard: true,
        restoredOwnerBoundary: true,
        navigationSwitches: switches,
        sameFrameDoubleClicks: 160,
        capacityRejection: true,
        rendererReloadWithFourActiveTurns: true,
        questionIsolation: true,
        repeatedStop: true,
        lateHistoryAndLiveEvents: true,
        activeShutdown: true,
        evidence,
      }),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, 'parallel-failure.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    throw error;
  }
}
module.exports = { prepare, createSession, run, historyResponse };
