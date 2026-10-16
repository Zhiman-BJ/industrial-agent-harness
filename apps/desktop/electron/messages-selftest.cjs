const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, clipboard, ClipboardItem } = require('electron');
const { saveBindings } = require('./project-bindings.cjs');
const { setLanguage } = require('./selftest-language.cjs');

let store, chat, turn, legacy;
const task = '怎么这次这么费劲';
const answer =
  '## 检查结果\n\n已读取工程文件。\n\n```verilog\nmodule sobel_filter;\nendmodule\n```';
const final = '下一步检查时序约束。\n\n- 保留输入文件\n- 查看验证结果';
function prepare(config, chats) {
  store = chats;
  const project = path.join(config, 'message-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'sobel_filter.v'), 'module sobel_filter;\nendmodule\n');
  saveBindings(config, {
    activeId: 'message-project',
    projects: [
      { id: 'message-project', name: 'Sobel edge detector', path: project, domain: 'chip' },
    ],
  });
  chat = store.create(project, 'chip');
  turn = store.beginTurn(chat.id, task);
  store.append(turn, { type: 'text', text: '<think>Internal test reasoning</think>\n' + answer });
  store.append(turn, { type: 'tool', id: 'inspect', name: 'ReadFile', arguments: '{}' });
  store.append(turn, {
    type: 'tool-result',
    id: 'inspect',
    output: 'module sobel_filter;',
    message: '',
  });
  store.append(turn, { type: 'text', text: final });
  store.finish(turn, 'completed');
  legacy = store.create(project, 'chip');
  const old = store.beginTurn(legacy.id, 'Legacy message');
  // An actual older row has no event receipt time; never substitute the page-load time.
  store.append(old, { type: 'text', text: 'Old reply without a recorded time.' });
  store
    .statement('UPDATE chat_events SET event_json = ? WHERE turn_id = ?')
    .run(JSON.stringify({ type: 'text', text: 'Old reply without a recorded time.' }), old);
  store.finish(old, 'completed');
}

async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error(`Message selftest timed out: ${script}`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function waitClipboard(expected) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await clipboard.readText()) === expected) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await clipboard.readText(), expected);
  }
  async function move(selector, revealOwner = false) {
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
    await wait(`document.hasFocus()`);
    if (selector)
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest' })`,
      );
    // Settle scrolling/layout before choosing coordinates in the native window.
    await evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    const point = selector
      ? await evaluate(
          `(() => { let node = document.querySelector(${JSON.stringify(selector)}); if (${revealOwner}) node = node.closest('.ia-message').querySelector('.ia-markdown, .ia-user-message'); const r = node.getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 20))}; })()`,
        )
      : { x: 2, y: 2 };
    window.webContents.sendInputEvent({ type: 'mouseEnter', ...point });
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    if (selector) {
      try {
        await wait(
          `document.querySelector(${JSON.stringify(selector)})${revealOwner ? ".closest('.ia-message')" : ''}.matches(':hover')`,
        );
        await wait(
          `(() => { const message = document.querySelector(${JSON.stringify(selector)}).closest('.ia-message'); return !message || (message.matches(':hover') && getComputedStyle(message.querySelector('.ia-message-actions')).opacity === '1'); })()`,
        );
      } catch (error) {
        const target = await evaluate(
          `JSON.stringify({ point: ${JSON.stringify(point)}, hit: document.elementFromPoint(${point.x}, ${point.y})?.outerHTML.slice(0, 500), hovered: Array.from(document.querySelectorAll(':hover')).map(node => node.className), focused: document.hasFocus(), actions: Array.from(document.querySelectorAll('.ia-message-actions')).map(node => ({ opacity: getComputedStyle(node).opacity, owner: node.parentElement.className, hovered: node.parentElement.matches(':hover') })), dialogs: Array.from(document.querySelectorAll('dialog[open]')).map(node => node.className) })`,
        );
        throw Error(`${error.message}; hit target=${target}`);
      }
    }
    await evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
  }
  const opacity = selector =>
    evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity`);
  async function capture(name) {
    const directory = process.env.INDUSTRIAL_UI_SCREENSHOTS;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  async function select(id) {
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(node => node.textContent.includes(${JSON.stringify(id === chat.id ? task : 'Legacy message')})).click()`,
    );
    await wait(
      `document.querySelector('.ia-user-message')?.textContent.includes(${JSON.stringify(id === chat.id ? task : 'Legacy message')})`,
    );
  }
  async function nativeCopy(selector, expected) {
    // Follow the real pointer path: hover the message before its hidden control.
    await move(selector, true);
    await move(selector);
    const point = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`,
    );
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait(
      `document.querySelector(${JSON.stringify(selector)}).parentElement.dataset.copyStatus === 'copied'`,
    );
    await waitClipboard(expected);
  }
  const user = '.ia-user-entry';
  const userActions = `${user} .ia-message-actions`;
  const userCopy = `${user} .ia-message-copy`;
  const reply = '.ia-agent-text';
  const replyActions = `${reply} .ia-message-actions`;
  const replyCopy = `${reply} .ia-message-copy`;
  window.focus();
  window.webContents.focus();
  // Preserve every native clipboard item, including non-text data, across this test.
  const savedClipboard = await Promise.all(
    (await clipboard.read()).map(
      async item =>
        new ClipboardItem(
          Object.fromEntries(
            await Promise.all(item.types.map(async type => [type, await item.getType(type)])),
          ),
        ),
    ),
  );
  try {
    await wait(`document.querySelectorAll('.ia-sidebar-chat').length === 2`);
    // A fresh packaged Core has no Domain packs. Close its real onboarding
    // dialog before testing message hit targets; this fixture runs no tools.
    const domains = await evaluate(`window.viewerHost.domainStatus()`);
    if (domains.managed && !domains.installed.length) {
      await wait(`Boolean(document.querySelector('.ia-domains-modal'))`);
      await click('.ia-domains-modal header button');
      await wait(`!document.querySelector('.ia-domains-modal')`);
    }
    await select(chat.id);
    await wait(`document.querySelectorAll('.ia-agent-text').length === 2`);
    await evaluate(`document.fonts.ready`);
    await move();
    await evaluate(`document.activeElement?.blur()`);
    assert.equal(await opacity(userActions), '0');
    assert.equal(await opacity(replyActions), '0');
    assert.equal(await evaluate(`document.querySelector('.ia-product-mark img').naturalWidth`), 64);
    assert.equal(
      await evaluate(`new URL(document.querySelector('link[rel="icon"]').href).pathname`),
      '/product-mark.png',
    );
    const times = await evaluate(
      `Array.from(document.querySelectorAll('.ia-message-actions time')).map(node => node.dateTime)`,
    );
    assert.equal(times.length, 3);
    await capture('messages-light-idle');
    const before = await evaluate(
      `document.querySelector('.ia-agent-text').getBoundingClientRect().top`,
    );
    await move(`${user} .ia-user-message`);
    assert.equal(await opacity(userActions), '1', 'hover reveals time and copy without clicking');
    assert.equal(await opacity(replyActions), '0', 'only the hovered message reveals its actions');
    assert.equal(
      await evaluate(`document.querySelector('.ia-agent-text').getBoundingClientRect().top`),
      before,
      'hover must not shift the conversation',
    );
    await capture('messages-light-user-hover');
    await nativeCopy(userCopy, task);
    await capture('messages-light-copied');
    await nativeCopy(replyCopy, answer);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(replyCopy)}).getAttribute('aria-label')`,
      ),
      'Message copied',
    );

    // Verify the real streaming display path preserves its first receipt time.
    const lastTime = times.at(-1);
    const event = store.append(turn, { type: 'text', text: '\nSTREAMED UPDATE' });
    window.webContents.send('agent:event', {
      ...event,
      chatId: chat.id,
      turnId: turn,
      eventRevision: 1,
    });
    await wait(
      `document.querySelectorAll('.ia-agent-text')[1].textContent.includes('STREAMED UPDATE')`,
    );
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.ia-agent-text time')).at(-1).dateTime`,
      ),
      lastTime,
    );
    await nativeCopy('.ia-agent-text:last-child .ia-message-copy', final + '\nSTREAMED UPDATE');

    await setLanguage(window, 'zh-CN');
    await click('.ia-settings-button');
    await click('.ia-settings-row button');
    await click('.ia-settings-title button');
    await move(`${reply} .ia-markdown`);
    assert.equal(await opacity(replyActions), '1');
    await capture('messages-dark-reply-hover');
    // Keyboard focus also reveals the control without a mouse click.
    await move();
    window.focus();
    window.webContents.focus();
    await evaluate(
      `document.activeElement?.blur(); document.querySelector(${JSON.stringify(userCopy)}).focus()`,
    );
    assert.equal(await opacity(userActions), '1');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(
      `document.querySelector(${JSON.stringify(userActions)}).dataset.copyStatus === 'copied'`,
    );
    await waitClipboard(task);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(userCopy)}).getAttribute('aria-label')`,
      ),
      '已复制消息',
    );

    // Permission/focus failure must be explicit, and the same button must allow retry.
    await evaluate(
      `window.originalWriteText = navigator.clipboard.writeText; navigator.clipboard.writeText = async () => { throw new DOMException('Test denial', 'NotAllowedError'); }; document.querySelector(${JSON.stringify(userCopy)}).click()`,
    );
    await wait(
      `document.querySelector(${JSON.stringify(userActions)}).dataset.copyStatus === 'error'`,
    );
    assert.equal(
      await evaluate(`document.querySelector('.ia-message-copy-error').textContent`),
      '复制失败，请重试。',
    );
    await evaluate(
      `navigator.clipboard.writeText = window.originalWriteText; delete window.originalWriteText`,
    );
    await nativeCopy(userCopy, task);

    await select(legacy.id);
    assert.equal(await evaluate(`Boolean(document.querySelector('.ia-agent-text time'))`), false);
    await nativeCopy(replyCopy, 'Old reply without a recorded time.');
    await select(chat.id);
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.ia-message-actions time')).map(node => node.dateTime)`,
      ),
      times,
    );
    // Reopen the renderer through actual persisted history, not the initial fixture.
    window.webContents.reload();
    await wait(`document.querySelectorAll('.ia-sidebar-chat').length === 2`);
    await select(chat.id);
    await wait(`document.querySelectorAll('.ia-message-actions time').length === 3`);
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.ia-message-actions time')).map(node => node.dateTime)`,
      ),
      times,
    );
    window.setSize(1000, 650);
    await click('[data-testid="workspace-toggle"]');
    await move(`${user} .ia-user-message`);
    assert.equal(await opacity(userActions), '1');
    const clipped = await evaluate(
      `Array.from(document.querySelectorAll('.ia-message-copy')).filter(node => { const r = node.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }).length`,
    );
    assert.equal(clipped, 0);
    await capture('messages-compact');
    console.log(
      'Message selftest passed: native hover, exact clipboard text, Markdown body, live/persisted timestamps, keyboard, retry, legacy history, languages, themes, compact layout, and brand assets.',
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    if (savedClipboard.length) await clipboard.write(savedClipboard);
    else clipboard.clear();
  }
}

module.exports = { prepare, run };
