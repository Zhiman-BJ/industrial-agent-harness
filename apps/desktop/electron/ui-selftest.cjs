const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const { setLanguage } = require('./selftest-language.cjs');

let project, chatStore;
const source =
  '// A source preview must preserve the project file.\nmodule sobel_filter;\nendmodule\n';
function prepare(config, chats) {
  chatStore = chats;
  project = path.join(config, 'sobel-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'sobel_filter.v'), source);
  fs.writeFileSync(
    path.join(project, 'acceptance.md'),
    '# Acceptance checklist\n\n- [x] RTL source available\n- [ ] Review timing constraints\n',
  );
  fs.writeFileSync(
    path.join(project, 'installation.txt'),
    'Local installation notes\n'.repeat(120),
  );
  saveBindings(config, { activeId: null, projects: [] });
}

async function run(window, dialog) {
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw Error(`UI selftest renderer script failed:\n${script}`, { cause: error });
    }
  };
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`UI selftest timed out: ${script}`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) =>
    evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const settle = () =>
    evaluate(
      `document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
    );
  async function shell(name) {
    await settle();
    const geometry = await evaluate(`(() => {
      const header = document.querySelector('.ia-desktop-header');
      const toggle = header.querySelector('[data-testid="sidebar-toggle"]');
      const rect = header.getBoundingClientRect(), button = toggle.getBoundingClientRect();
      const sidebar = document.querySelector('.ia-sidebar')?.getBoundingClientRect();
      const backdrop = document.querySelector('.ia-sidebar-backdrop')?.getBoundingClientRect();
      return {height:rect.height, bottom:rect.bottom, toggleLeft:button.left,
        toggles:document.querySelectorAll('[data-testid="sidebar-toggle"]').length,
        controls:document.querySelectorAll('.ia-window-controls').length,
        sidebar:sidebar && {top:sidebar.top,width:sidebar.width}, backdropTop:backdrop?.top,
        contentTop:document.querySelector('.ia-columns').getBoundingClientRect().top,
        documentWidth:document.documentElement.scrollWidth, documentHeight:document.documentElement.scrollHeight,
        width:innerWidth,heightAvailable:innerHeight};
    })()`);
    assert.equal(geometry.toggles, 1, `${name}: one primary sidebar toggle`);
    assert.ok(Math.abs(geometry.height - 58) <= 1, `${name}: 58 px global header`);
    assert.equal(
      geometry.controls,
      process.platform === 'darwin' ? 0 : 1,
      `${name}: one platform window-control owner`,
    );
    if (process.platform === 'darwin')
      assert.ok(geometry.toggleLeft >= 86, `${name}: native traffic-light space`);
    assert.ok(
      geometry.contentTop >= geometry.bottom - 1,
      `${name}: content starts below the header`,
    );
    if (geometry.sidebar) {
      assert.ok(Math.abs(geometry.sidebar.width - 228) <= 1, `${name}: 228 px sidebar`);
      assert.ok(
        geometry.sidebar.top >= geometry.bottom - 1,
        `${name}: sidebar starts below the header`,
      );
    }
    if (geometry.backdropTop !== undefined)
      assert.ok(
        geometry.backdropTop >= geometry.bottom - 1,
        `${name}: drawer backdrop leaves header accessible`,
      );
    assert.ok(
      geometry.documentWidth <= geometry.width + 1 &&
        geometry.documentHeight <= geometry.heightAvailable + 1,
      `${name}: shell must not scroll the whole window: ${JSON.stringify(geometry)}`,
    );
  }
  async function sidebarCycle(name) {
    const position = () =>
      evaluate(`(() => {
      const rect=document.querySelector('[data-testid="sidebar-toggle"]').getBoundingClientRect();
      return {left:rect.left,top:rect.top};
    })()`);
    const before = await position();
    const visible = await evaluate(`Boolean(document.querySelector('.ia-sidebar'))`);
    for (const expected of [!visible, visible]) {
      await click('[data-testid="sidebar-toggle"]');
      await wait(`Boolean(document.querySelector('.ia-sidebar')) === ${expected}`);
      await shell(name);
      const after = await position();
      assert.ok(
        Math.abs(before.left - after.left) <= 1 && Math.abs(before.top - after.top) <= 1,
        `${name}: sidebar toggle position must not move`,
      );
    }
  }
  async function context(location) {
    await wait(
      `document.querySelector('[data-testid="header-location"]')?.textContent === ${JSON.stringify(location)}`,
    );
    assert.equal(
      await evaluate(`document.querySelector('[data-testid="header-project"]').title`),
      'Sobel edge detector',
    );
    assert.equal(
      await evaluate(`document.querySelector('[data-testid="header-location"]').title`),
      location,
    );
  }
  async function aligned(name) {
    const rectangles =
      await evaluate(`['.ia-composer','.ia-composer-hint','.ia-remote-task-status'].map(selector => {
      const rect=document.querySelector(selector).getBoundingClientRect();
      return {selector,left:rect.left,right:rect.right,width:rect.width};
    })`);
    assert.ok(Math.abs(rectangles[0].width - 640) <= 1, `${name}: 640 px content width`);
    assert.ok(
      rectangles.every(
        rect =>
          Math.abs(rect.left - rectangles[0].left) <= 1 &&
          Math.abs(rect.right - rectangles[0].right) <= 1,
      ),
      `${name}: remote state, input and hint must align: ${JSON.stringify(rectangles)}`,
    );
  }
  async function quality(name) {
    await shell(name);
    const failures = await evaluate(`(() => {
      const samples = ['.ia-chat-welcome p', '.ia-composer textarea', '.ia-project-row.selected',
        '.ia-sidebar-chat[aria-current="page"]', '.ia-file-list button.selected', '.ia-source-panel pre', '.ia-chat-approval-mode', '.ia-setup-banner'];
      function rgba(color) { return color.match(/[\\d.]+/g).map(Number); }
      function background(node) {
        if (!node) return [255, 255, 255];
        const values = rgba(getComputedStyle(node).backgroundColor);
        const alpha = values[3] ?? 1;
        if (alpha === 1) return values.slice(0, 3);
        const under = background(node.parentElement);
        return under.map((channel, index) => values[index] * alpha + channel * (1 - alpha));
      }
      function luminance(channels) {
        const linear = channels.map(channel => { const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
        return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      }
      return samples.flatMap(selector => {
        const node = document.querySelector(selector);
        if (!node || (node.disabled && selector !== '.ia-chat-approval-mode')) return [];
        const foreground = luminance(rgba(getComputedStyle(node).color).slice(0, 3));
        const surface = luminance(background(node));
        const ratio = (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05);
        return ratio < 4.5 ? [{ selector, ratio }] : [];
      });
    })()`);
    assert.deepEqual(failures, [], `${name}: body and selected text contrast`);
    assert.equal(
      await evaluate(`document.querySelector('.ia-columns').scrollWidth <= innerWidth + 1`),
      true,
      `${name}: panels must fit the window`,
    );
    const clipped =
      await evaluate(`Array.from(document.querySelectorAll('.ia-desktop-header button, .ia-workspace-actions button, .ia-settings-button, .ia-send')).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1);
    }).map(node => node.getAttribute('aria-label') || node.title || node.textContent)`);
    assert.deepEqual(clipped, [], `${name}: essential controls must remain visible`);
    const settings = await evaluate(`(() => {
      const popup = document.querySelector('.ia-settings-popover');
      if (!popup) return null;
      const bounds = document.querySelector('.ia-columns').getBoundingClientRect();
      const rect = popup.getBoundingClientRect();
      const title = popup.querySelector('.ia-settings-title').getBoundingClientRect();
      const close = popup.querySelector('.ia-settings-title button');
      const button = close.getBoundingClientRect();
      const target = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
      return {
        inside: rect.top >= bounds.top && rect.bottom <= bounds.bottom &&
          rect.left >= bounds.left && rect.right <= bounds.right,
        titleVisible: title.top >= rect.top && title.bottom <= rect.bottom,
        closeReachable: close === target || close.contains(target),
        top: rect.top, availableTop: bounds.top, bottom: rect.bottom, availableBottom: bounds.bottom,
      };
    })()`);
    if (settings)
      assert.ok(
        settings.inside && settings.titleVisible && settings.closeReachable,
        `${name}: settings must fit below the header with an accessible close button: ${JSON.stringify(settings)}`,
      );
  }
  async function capture(name) {
    const directory = process.env.INDUSTRIAL_UI_SCREENSHOTS;
    if (!directory) return;
    await evaluate(
      `document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }

  await wait(`Boolean(document.querySelector('.ia-chat-welcome'))`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.ia-workspace'))`), false);
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.ia-send').disabled`), true);
  await capture('empty-light');
  await click('.ia-welcome-create');
  await wait(`Boolean(document.querySelector('.ia-create-project'))`);
  await capture('create-project');
  const original = dialog.showOpenDialog;
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    await click('.ia-folder-picker');
    await wait(`document.querySelector('.ia-folder-picker').textContent.includes('sobel-project')`);
  } finally {
    dialog.showOpenDialog = original;
  }
  await input('.ia-create-project input', 'Sobel edge detector');
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-domain-choice')).find(node => node.textContent.includes('Chip')).click()`,
  );
  await click('.ia-create-project .primary');
  await wait(`Boolean(document.querySelector('.ia-project-page'))`);
  await context('Project details');
  await shell('project-details');
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-project-start').getBoundingClientRect().bottom < innerHeight`,
    ),
    true,
    'New chat must be visible when arriving on project details',
  );
  await capture('project-details');
  await wait(
    `document.querySelector('.ia-execution-options button[aria-pressed="true"]')?.textContent.includes('This computer')`,
  );
  await click('.ia-execution-options button:last-child');
  await wait(
    `document.querySelector('.ia-remote-project-body')?.textContent.includes('Not configured') && document.querySelector('.ia-project-start').disabled`,
  );
  await wait(`!document.querySelector('.ia-project-resources')`);
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-project-execution input').length`),
    0,
    'Unknown deployment configuration must not ask users for a service name or URL.',
  );
  await capture('remote-unconfigured');
  await setLanguage(window, 'zh-CN');
  await capture('remote-unconfigured-zh');
  await setLanguage(window, 'en');
  await click('.ia-new-chat');
  await wait(
    `document.querySelector('.ia-remote-task-status')?.textContent.includes('Not configured')`,
  );
  await context('New chat');
  await aligned('remote-chat-expanded');
  await evaluate(`window.__remoteStatus = document.querySelector('.ia-remote-task-status')`);
  await sidebarCycle('remote-chat');
  await aligned('remote-chat-restored');
  assert.equal(
    await evaluate(`document.querySelector('.ia-remote-task-status') === window.__remoteStatus`),
    true,
    'Sidebar changes must retain the remote task status node',
  );
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.ia-send').disabled`), true);
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-tabs'))`);
  await click('.ia-tab-add');
  await wait(`document.querySelector('.ia-chat').hidden`);
  await click('#tab-chat');
  await wait(`!document.querySelector('.ia-chat').hidden`);
  assert.equal(
    await evaluate(`document.querySelector('.ia-remote-task-status') === window.__remoteStatus`),
    true,
    'Remote task status must stay mounted when browsing another tab',
  );
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.ia-send').disabled`), true);
  await click('[data-testid="workspace-toggle"]');
  await wait(`!document.querySelector('.ia-workspace').hidden`);
  await click('[data-testid="workspace-toggle"]');
  await wait(
    `!document.querySelector('.ia-workspace') || document.querySelector('.ia-workspace').hidden`,
  );
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-split'))`);
  await click('.ia-remote-task-status button');
  await wait(`Boolean(document.querySelector('.ia-project-page'))`);
  await click('.ia-settings-button');
  await wait(
    `Array.from(document.querySelectorAll('.ia-settings-row')).some(row => row.textContent.includes('MCP & Skills'))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(row => row.textContent.includes('MCP & Skills')).querySelector('button').click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-capability'))`);
  await context('Capability center');
  await shell('capability-center');
  await wait(
    `document.querySelector('.ia-remote-service')?.textContent.includes('Not configured')`,
  );
  assert.equal(
    await evaluate(`document.querySelector('.ia-remote-service button').disabled`),
    true,
  );
  assert.equal(
    await evaluate(`document.querySelector('.ia-external-mcp form') === null`),
    true,
    'The external MCP form stays collapsed until the add action opens it',
  );
  await capture('builtin-remote-service');
  await setLanguage(window, 'zh-CN');
  await capture('builtin-remote-service-zh');
  await setLanguage(window, 'en');
  await click('.ia-capability-header button');
  await wait(`Boolean(document.querySelector('.ia-project-page'))`);
  await click('.ia-execution-options button:first-child');
  await wait(`!document.querySelector('.ia-project-start').disabled`);
  await click('.ia-project-start');
  await wait(`Boolean(document.querySelector('.ia-chat-welcome'))`);
  const draft = 'Inspect the RTL and explain the timing constraints.\n检查 RTL 并解释时序约束。';
  await input('.ia-composer textarea', draft);
  const attachment = require('electron')
    .nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 })
    .toPNG()
    .toString('base64');
  await evaluate(`(() => {
    const file = new File([Uint8Array.from(atob(${JSON.stringify(attachment)}), c => c.charCodeAt(0))], 'layout.png', {type:'image/png'});
    const data = new DataTransfer(); data.items.add(file);
    const input = document.querySelector('input[aria-label="Image attachment files"]');
    input.files=data.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await wait(
    `Boolean(document.querySelector('.ia-composer .ia-image-attachments img')) && !document.querySelector('.ia-composer p[role="status"]')`,
  );
  await evaluate(
    `window.__shellDraft=document.querySelector('.ia-composer textarea'); window.__shellImage=document.querySelector('.ia-composer .ia-image-attachments img')`,
  );
  await sidebarCycle('draft-and-attachment');
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-tabs'))`);
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-split'))`);
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-composer textarea') === window.__shellDraft && document.querySelector('.ia-composer .ia-image-attachments img') === window.__shellImage`,
    ),
    true,
    'Sidebar and layout changes must retain the draft and attachment nodes',
  );
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), draft);
  await click('.ia-composer .ia-image-attachments figure button');
  await wait(`!document.querySelector('.ia-composer .ia-image-attachments img')`);
  await quality('chat-light');
  await capture('chat-light');
  await click('.ia-welcome-actions button:last-child');
  await wait(`Boolean(document.querySelector('.ia-workspace-tree'))`);
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), draft);
  await click('.ia-file-tree-toggle');
  await click('[data-testid="workspace-toggle"]');
  await click('[data-testid="workspace-toggle"]');
  await wait(`Boolean(document.querySelector('.ia-workspace'))`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.ia-workspace-tree'))`), false);
  await click('.ia-file-tree-toggle');
  await wait(`document.querySelectorAll('.ia-file-list button').length > 0`);
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-file-list button')).find(node => node.textContent.includes('sobel_filter.v')).click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-source-panel pre'))`);
  assert.equal(
    await evaluate(`document.querySelector('.ia-source-panel pre').textContent`),
    source,
  );
  await quality('workspace-light');
  await capture('workspace-light');
  await setLanguage(window, 'zh-CN');
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), draft);
  await click('.ia-settings-button');
  await evaluate(`document.querySelector('.ia-settings-row button').click()`);
  await click('.ia-settings-title button');
  await wait(`Boolean(document.querySelector('.theme-dark'))`);
  await quality('workspace-dark-zh');
  await capture('workspace-dark-zh');
  window.setSize(1000, 720);
  await quality('workspace-compact');
  await click('.ia-settings-button');
  assert.equal(
    await evaluate(
      `(() => { const rect = document.querySelector('.ia-settings-popover').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })()`,
    ),
    true,
    'Settings must fit the compact window',
  );
  await capture('settings-compact');
  await click('.ia-settings-title button');
  await capture('workspace-compact');
  window.setSize(1000, 650);
  await quality('workspace-minimum');
  window.setSize(1250, 800);
  await quality('workspace-medium');
  window.setSize(1440, 900);
  await setLanguage(window, 'en');
  await click('[data-testid="workspace-toggle"]');
  await wait(`document.querySelector('.ia-workspace').hidden`);
  window.focus();
  window.webContents.focus();
  await evaluate(`(() => {
    const node = document.querySelector('.ia-composer textarea');
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  })()`);
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('.ia-composer')).outlineStyle`),
    'solid',
    'The focused input must have a visible focus indicator',
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
  await wait(
    `document.querySelector('.ia-composer textarea').value === ${JSON.stringify(draft + '\n')}`,
  );
  await input('.ia-composer textarea', draft);
  await quality('chat-dark');
  await capture('chat-dark');
  await setLanguage(window, 'zh-CN');
  await input('.ia-composer textarea', '');
  await evaluate(`document.activeElement?.blur()`);
  await quality('empty-dark-zh');
  await capture('empty-dark-zh');
  await input('.ia-composer textarea', draft);
  await setLanguage(window, 'en');
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), draft);
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-tabs'))`);
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), draft);
  await click('.ia-tab-add');
  await wait(`Boolean(document.querySelector('.ia-workspace-tree'))`);
  await evaluate(
    `document.querySelector('.ia-workbench-tabbar [role="tab"]:not(#tab-chat)').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`,
  );
  await click('.ia-file-list button[title="acceptance.md"]');
  await wait(
    `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-markdown h1')?.textContent === 'Acceptance checklist'`,
  );
  await context('acceptance.md');
  await evaluate(
    `document.querySelector('.ia-workbench-tabbar [aria-selected="true"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`,
  );
  await wait(
    `!document.querySelector('.ia-workbench-tabbar [aria-selected="true"]').closest('.ia-tab-item').classList.contains('ia-tab-preview')`,
  );
  await quality('tabs-markdown');
  await capture('tabs-markdown');
  await click('.ia-file-list button[title="installation.txt"]');
  await wait(
    `document.querySelector('.ia-viewer-header b')?.textContent === 'installation.txt' && document.querySelector('.ia-viewer-footer')?.textContent.includes('Ready')`,
  );
  await click('.ia-file-list button[title="acceptance.md"]');
  await wait(`document.querySelector('.ia-viewer-header b')?.textContent === 'acceptance.md'`);
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-workbench-tabbar [role="tab"]').length`),
    4,
  );
  await click('.ia-file-list button[title="installation.txt"]');
  await wait(`document.querySelector('.ia-viewer-header b')?.textContent === 'installation.txt'`);
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-workbench-tabbar .ia-tab-preview').length`),
    1,
  );
  await evaluate(
    `window.__retainedDocument = document.querySelector('.ia-file-view:not([hidden])'); window.__retainedDraft = document.querySelector('.ia-composer textarea');`,
  );
  const selected = await evaluate(
    `document.querySelector('.ia-workbench-tabbar [aria-selected="true"]').id`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-workbench-tabbar [role="tab"]').length`),
    4,
  );
  await evaluate(
    `document.querySelector('.ia-workbench-tabbar [aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))`,
  );
  await wait(`!document.querySelector('.ia-chat').hidden`);
  await context('New chat');
  assert.equal(await evaluate(`document.activeElement.id`), 'tab-chat');
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), draft);
  await evaluate(`document.getElementById(${JSON.stringify(selected)}).click()`);
  await wait(`!document.querySelector('.ia-workspace').hidden`);
  await context('installation.txt');
  await sidebarCycle('mounted-document');
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])') === window.__retainedDocument`,
    ),
    true,
    'Tab switch must retain the document DOM',
  );
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-split'))`);
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])') === window.__retainedDocument`,
    ),
    true,
    'Layout switch must retain the document DOM',
  );
  window.setContentSize(800, 600);
  await wait(`Boolean(document.querySelector('.layout-tabs'))`);
  assert.equal(
    await evaluate(`localStorage.getItem('ia-layout-v1')`),
    'split',
    'Responsive fallback must preserve the chosen layout',
  );
  await quality('tabs-800');
  await capture('tabs-800');
  window.setSize(640, 480);
  await wait(`!document.querySelector('.ia-sidebar')`);
  await quality('tabs-minimum');
  await click('[data-testid="sidebar-toggle"]');
  await wait(`Boolean(document.querySelector('.ia-sidebar'))`);
  await click('.ia-settings-button');
  await quality('tabs-settings-minimum');
  await capture('tabs-settings-minimum');
  const settingsClose = await evaluate(`(() => {
    const rect = document.querySelector('.ia-settings-title button').getBoundingClientRect();
    return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
  })()`);
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...settingsClose,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...settingsClose,
  });
  await wait(`!document.querySelector('.ia-settings-popover')`);
  await click('.ia-sidebar-backdrop');
  await wait(`!document.querySelector('.ia-sidebar')`);
  await capture('tabs-minimum');
  await click('#tab-chat');
  await wait(`!document.querySelector('.ia-chat').hidden`);
  await quality('chat-minimum');
  assert.equal(
    await evaluate(`(() => {
      const title = document.querySelector('.ia-chat-welcome h1').getBoundingClientRect();
      const viewport = document.querySelector('.ia-chat-scroll').getBoundingClientRect();
      return title.top >= viewport.top && title.bottom <= viewport.bottom;
    })()`),
    true,
    'The empty-chat title must remain visible at the native minimum size',
  );
  await capture('chat-minimum');
  await evaluate(`document.getElementById(${JSON.stringify(selected)}).click()`);
  window.setContentSize(1440, 900);
  await wait(`Boolean(document.querySelector('.layout-split'))`);
  await click('.ia-layout-toggle');
  await wait(`Boolean(document.querySelector('.layout-tabs'))`);
  await setLanguage(window, 'zh-CN');
  await quality('tabs-dark-zh');
  await capture('tabs-dark-zh');
  await setLanguage(window, 'en');
  await evaluate(
    `(() => { const tab = document.querySelector('.ia-workbench-tabbar [aria-selected="true"]'); tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true})); })()`,
  );
  await wait(`document.querySelectorAll('.ia-workbench-tabbar [role="tab"]').length === 3`);
  await wait(`document.activeElement.getAttribute('aria-selected') === 'true'`);
  assert.equal(
    await evaluate(`document.activeElement.getAttribute('aria-selected')`),
    'true',
    'Closing a tab must return keyboard focus to the selected neighbor',
  );
  assert.equal(
    await evaluate(`document.querySelector('.ia-composer textarea') === window.__retainedDraft`),
    true,
  );
  assert.equal(await evaluate(`localStorage.getItem('ia-layout-v1')`), 'tabs');
  await window.webContents.reload();
  await wait(
    `Boolean(document.querySelector('.layout-tabs')) && Boolean(document.querySelector('.ia-composer textarea'))`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-file-view').length`),
    0,
    'File sessions are scoped to the current window, not restored into a different project',
  );
  assert.equal(fs.readFileSync(path.join(project, 'sobel_filter.v'), 'utf8'), source);
  await require('./message-rail-selftest.cjs').run(window, chatStore, project);
  console.log(
    'UI selftest passed: global header, fixed sidebar toggle, platform controls, page context, aligned remote state/input, builtin remote configuration states, onboarding, source preview, themes, contrast, languages, responsive tabs, minimum-window navigation, keyboard focus, retained documents, drafts and attachments.',
  );
}

module.exports = { prepare, run };
