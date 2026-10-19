// Real-app screenshot run for the remote execution UI (PR #201) against the
// local v1.1 mock service. Launched via `electron . --remote-ui-selftest` with:
//   INDUSTRIAL_REMOTE_SERVICE_URL=http://127.0.0.1:8787
//   INDUSTRIAL_REMOTE_CREDENTIAL_ENV=MOCK_REMOTE_TOKEN
//   MOCK_REMOTE_TOKEN=mock-token
//   INDUSTRIAL_UI_SCREENSHOTS=<output directory>
// With scripts/remote-ui-fixture.cjs, REMOTE_UI_FIXTURE_CONTROL=1 additionally
// checks controlled query failures and the error-details disclosure.
// The complete run still requires a remote artifact for the same bound project
// before step 6. Uploading to remote-ui-fixture.cjs does not create artifacts,
// and its control endpoint does not seed them; prepare that prerequisite
// separately. The control flag alone does not make this a standalone fixture run.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const { setLanguage } = require('./selftest-language.cjs');

let projectDir, chatStore;

function prepare(configDir, chats) {
  chatStore = chats;
  projectDir = path.join(configDir, 'chip-remote-demo');
  fs.mkdirSync(path.join(projectDir, 'rtl'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'rtl/top.v'), 'module top; endmodule\n');
  fs.writeFileSync(path.join(projectDir, 'rtl/tb_top.cpp'), '// verilator testbench fixture\n');
  fs.writeFileSync(path.join(projectDir, 'eda.yaml'), 'tool: verilator\ntop: top\n');
  fs.writeFileSync(path.join(projectDir, '.env'), 'MOCK_SHOULD_NEVER_UPLOAD=1\n');
  saveBindings(configDir, {
    activeId: 'chip-remote-demo',
    projects: [
      {
        id: 'chip-remote-demo',
        name: 'Chip 远程联调示例',
        path: fs.realpathSync(projectDir),
        domain: 'chip',
        disabledSkills: [],
        disabledMcpServers: [],
      },
    ],
  });
  // A finished chat mixing one local and one remote tool call, so the remote
  // badge can be reviewed next to an unbadged local call, plus a todo event so
  // the merged status card shows both blocks with a divider.
  const chat = chatStore.create(fs.realpathSync(projectDir), 'chip');
  const turn = chatStore.beginTurn(chat.id, '跑一次远程冒烟检查');
  chatStore.append(turn, { type: 'text', text: '好的，我先看本机环境，再调用远程沙箱。\n' });
  chatStore.append(turn, {
    type: 'todo',
    items: [
      { title: '读取布局与网表', status: 'done' },
      { title: '远程沙箱冒烟检查', status: 'in_progress' },
      { title: '汇总检查结论', status: 'pending' },
    ],
  });
  chatStore.append(turn, {
    type: 'tool',
    id: 'local-inspect',
    name: 'project.environment.inspect',
    arguments: '{}',
  });
  chatStore.append(turn, {
    type: 'tool-result',
    id: 'local-inspect',
    output: '{"node":"v24.15.0"}',
    message: '',
  });
  chatStore.append(turn, {
    type: 'tool',
    id: 'remote-smoke',
    name: 'chip.eda.smoke',
    arguments: '{"note":"ui 验证"}',
  });
  chatStore.append(turn, {
    type: 'tool-result',
    id: 'remote-smoke',
    output: '{"status":"passed","artifact":"smoke-report.json"}',
    message: '',
  });
  chatStore.append(turn, { type: 'text', text: '远程冒烟检查通过，报告已生成。' });
  chatStore.finish(turn, 'completed');
}

async function runInner(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw Error(`remote-ui-selftest timed out: ${script}`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (scope, text) =>
    evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(node => node.textContent.includes(${JSON.stringify(text)}))?.click()`,
    );
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
    console.log('[remote-ui-selftest] captured', name);
  }

  // Chinese UI for the design review.
  await setLanguage(window, 'zh-CN');

  // 1. Settings page: remote service card, then connect for real.
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(
    `Array.from(document.querySelectorAll('.ia-settings-row')).some(row => /MCP/.test(row.textContent))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(row => /MCP/.test(row.textContent)).querySelector('button').click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-capability'))`);
  await wait(`Boolean(document.querySelector('.ia-remote-service'))`);
  await capture('01-settings-service-card');
  await clickText('.ia-remote-service button', '检查连接');
  await wait(`document.querySelector('.ia-remote-service')?.textContent.includes('已连接')`);
  await capture('02-settings-connected');

  // 2. Project page: leave the capability view, then open the seeded project.
  await click('.ia-capability-header button');
  await new Promise(resolve => setTimeout(resolve, 400));
  if (!(await evaluate(`Boolean(document.querySelector('.ia-project-page'))`))) {
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-project-row, .ia-welcome-actions button, button')).find(node => node.textContent.includes('Chip 远程联调示例'))?.click()`,
    );
  }
  await wait(`Boolean(document.querySelector('.ia-project-page'))`);
  await wait(`Boolean(document.querySelector('.ia-project-execution'))`);
  await click('.ia-execution-options button:last-child');
  await wait(`Boolean(document.querySelector('.ia-remote-project-body'))`);
  await capture('03-project-remote-toggle');

  // Before upload, the actual remote readiness gate blocks input. The composer
  // explains that state and takes the user back to project execution settings.
  await wait(`document.querySelector('.ia-project-start')?.disabled === false`);
  await click('.ia-project-start');
  await wait(`document.querySelector('.ia-composer textarea')?.disabled === true`);
  const remoteAgentAvailable = await evaluate(
    `window.viewerHost.agentStatus().then(s => s.available)`,
  );
  const blockedHint = remoteAgentAvailable
    ? '远程环境尚未就绪，请检查项目执行设置。'
    : '运行 Agent 任务需要 Kimi CLI';
  await wait(
    `document.querySelector('#ia-composer-status')?.textContent === ${JSON.stringify(blockedHint)}`,
  );
  assert.equal(await evaluate(`document.querySelector('.ia-send').disabled`), true);
  if (remoteAgentAvailable) {
    assert.equal(
      await evaluate(`document.querySelector('.ia-composer-status-action').textContent.trim()`),
      '执行设置',
    );
    await capture('03b-chat-remote-not-ready');
    await click('.ia-composer-status-action');
  } else {
    // UI-only runs need not have Kimi installed. Preserve that higher-priority
    // blocker rather than claiming the runtime is available for this fixture.
    assert.equal(
      await evaluate(`Boolean(document.querySelector('.ia-composer-status-action'))`),
      false,
    );
    await click('.ia-composer-project');
  }
  await wait(`Boolean(document.querySelector('.ia-project-execution'))`);
  assert.equal(
    await evaluate(`(() => {
      const dock = document.querySelector('.ia-status-dock');
      return Boolean(dock?.hidden) && dock.getClientRects().length === 0;
    })()`),
    true,
    'Returning from the blocked composer hides the status card on project settings',
  );
  await wait(`Boolean(document.querySelector('.ia-remote-project-body'))`);

  // 3. Connect from the project panel if needed, then open the file picker.
  if (
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-remote-project-body button')).some(b => b.textContent.includes('连接') || b.textContent.includes('Connect'))`,
    )
  ) {
    await clickText('.ia-remote-project-body button', '连接');
    await wait(`document.querySelector('.ia-remote-project-body')?.textContent.includes('已连接')`);
  }
  await clickText('.ia-remote-project-body button', '选择同步文件');
  await wait(`Boolean(document.querySelector('.ia-remote-file-picker'))`);
  await capture('04-file-picker');

  // 4. Select all eligible files, review the upload manifest.
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-remote-file-picker input[type="checkbox"]:not(:checked)')).forEach(box => box.click())`,
  );
  await clickText('.ia-remote-file-picker button', '查看上传清单');
  await wait(`Boolean(document.querySelector('.ia-remote-sync-review'))`);
  await capture('05-upload-review');

  // 5. Confirm and sync for real (mock service receives the snapshot upload).
  await clickText('.ia-remote-sync-review button', '确认并同步');
  await wait(`document.querySelector('.ia-remote-project-body')?.textContent.includes('已同步')`);
  await capture('06-synced');

  // 6. Browse remote artifacts and download one into the project.
  await clickText('.ia-remote-project-body button, .ia-project-execution button', '浏览远程产物');
  await wait(
    `Array.from(document.querySelectorAll('.ia-project-execution button')).some(b => b.textContent.includes('下载到项目'))`,
  );
  await capture('07-remote-artifacts');
  await clickText('.ia-project-execution button', '下载到项目');
  await wait(
    `document.querySelector('.ia-project-execution')?.textContent.includes('已下载') || document.querySelector('.ia-project-execution')?.textContent.includes('Downloaded')`,
  );
  await capture('08-artifact-downloaded');

  // 7. Chat page: status pill top-right (card collapsed, conversation centered)
  // with an enabled composer; opening the card shifts the conversation left.
  await wait(`document.querySelector('.ia-project-start')?.disabled === false`);
  await click('.ia-project-start');
  await wait(`document.querySelector('.ia-status-dock')?.textContent.includes('远程就绪')`);
  await wait(`document.querySelector('.ia-composer textarea')?.disabled === false`);
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.ia-composer-status-action'))`),
    false,
    'The remote setup prompt disappears only after the actual readiness gate clears',
  );
  await capture('09-chat-status-pill');
  await click('.ia-status-pill');
  await wait(`Boolean(document.querySelector('.ia-status-dock.open .ia-status-card'))`);
  await capture('09b-status-card-open-shifts-chat');
  await click('.ia-status-dock.open .ia-status-head');
  await wait(`Boolean(document.querySelector('.ia-status-dock .ia-status-body:not([hidden])'))`);
  await capture('09c-status-card-expanded');

  if (process.env.REMOTE_UI_FIXTURE_CONTROL === '1') {
    const fixtureUrl = new URL(process.env.INDUSTRIAL_REMOTE_SERVICE_URL);
    assert.equal(fixtureUrl.protocol, 'http:');
    assert.equal(fixtureUrl.hostname, '127.0.0.1');
    const credential = process.env[process.env.INDUSTRIAL_REMOTE_CREDENTIAL_ENV];
    assert.ok(credential, 'The optional fixture control requires its test token');
    const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
    const info = await fetch(new URL('/v1/service-info', fixtureUrl), { headers }).then(r =>
      r.json(),
    );
    assert.equal(info.fixture, true, 'Fault controls must target the explicit UI fixture');
    assert.equal(info.engineeringExecution, false);
    const queryFailure = async value => {
      const response = await fetch(new URL('/__fixture/state', fixtureUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ queryFailure: value }),
      });
      assert.equal(response.ok, true, 'Fixture query-failure control must succeed');
    };
    try {
      await queryFailure(true);
      await wait(`Boolean(document.querySelector('.ia-status-error-details'))`);
      assert.equal(
        await evaluate(`document.querySelector('.ia-composer textarea').disabled`),
        true,
      );
      assert.equal(
        await evaluate(`document.querySelector('.ia-status-error [role="alert"]').textContent`),
        '暂时无法更新远程状态，请稍后重试。',
        'The visible failure explains recovery without exposing IPC diagnostics',
      );
      assert.equal(
        await evaluate(`document.querySelector('.ia-status-error-details summary').textContent`),
        '错误详情',
      );
      assert.equal(
        await evaluate(`document.querySelector('.ia-status-error-details').open`),
        false,
        'Error diagnostics are collapsed by default',
      );
      const rawReason = await evaluate(
        `document.querySelector('.ia-status-error-reason').textContent`,
      );
      assert.match(rawReason, /UI_FIXTURE_QUERY_FAILED/);
      assert.match(rawReason, /remote:session/);
      await capture('09d-remote-query-failed');
      await click('.ia-status-error-details summary');
      await wait(`document.querySelector('.ia-status-error-details').open`);
      assert.equal(
        await evaluate(`document.querySelector('.ia-status-error-reason').textContent`),
        rawReason,
        'Expanding diagnostics retains the original failure reason',
      );
    } finally {
      await queryFailure(false);
    }
    await wait(
      `!document.querySelector('.ia-status-error') && document.querySelector('.ia-composer textarea')?.disabled === false`,
    );
  }

  // 8. Open the seeded chat: the remote sandbox tool call carries a green
  // badge while the local call does not. Tool identities arrive through the
  // status-bar poll, so wait for the badge rather than assuming timing.
  await clickText('.ia-sidebar-chat', '跑一次远程冒烟检查');
  await wait(`Boolean(document.querySelector('.ia-agent-tool .ia-remote-badge'))`);
  await capture('10-chat-remote-tool-badge');

  // 9. The card on this chat carries both blocks (remote + tasks); blocks are
  // mutually exclusive (accordion): expanding tasks collapses the remote body,
  // keeping the card compact. The dock keeps its state across chats.
  await evaluate(`document.querySelector('.ia-status-pill')?.click()`);
  await wait(`document.querySelectorAll('.ia-status-dock .ia-status-head').length === 2`);
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-status-dock .ia-status-head')).find(head => head.textContent.includes('任务')).click()`,
  );
  await wait(
    `Boolean(document.querySelector('.ia-status-dock .ia-status-todo:not([hidden])')) && !document.querySelector('.ia-status-dock .ia-status-body:not(.ia-status-todo):not([hidden])')`,
  );
  await capture('10b-status-card-todo-expanded');

  // The real renderer must keep the composer clear at both sides of the
  // chat-column breakpoint, including the minimum supported native window.
  const originalBounds = window.getBounds();
  async function layout(name, width, height) {
    window.setSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 150));
    const metrics = await evaluate(`(() => {
      const card = document.querySelector('.ia-status-card');
      const chat = document.querySelector('.ia-chat');
      const composer = document.querySelector('.ia-composer');
      const flow = document.querySelector('.ia-chat-scroll-area');
      const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width }; };
      const close = card.querySelector('.ia-status-card-head button');
      const c = close.getBoundingClientRect();
      return { card:rect(card), chat:rect(chat), composer:rect(composer), flow:rect(flow), overflow:card.scrollWidth > card.clientWidth + 1,
        clickable: close.contains(document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)) };
    })()`);
    assert.equal(metrics.overflow, false, `${name}: no horizontal card overflow`);
    assert.equal(metrics.clickable, true, `${name}: conversation cannot intercept card controls`);
    assert.ok(
      metrics.card.left >= metrics.chat.left && metrics.card.right <= metrics.chat.right,
      `${name}: card stays inside the chat column`,
    );
    assert.ok(metrics.composer.width >= 240, `${name}: composer keeps a usable width`);
    assert.ok(
      metrics.flow.bottom <= metrics.composer.top,
      `${name}: transcript stays above the composer`,
    );
    assert.ok(
      metrics.card.right <= metrics.composer.left ||
        metrics.card.left >= metrics.composer.right ||
        metrics.card.bottom <= metrics.composer.top ||
        metrics.card.top >= metrics.composer.bottom,
      `${name}: card never covers the composer`,
    );
    if (metrics.chat.width < 960)
      assert.ok(
        metrics.card.bottom <= metrics.flow.top + 1,
        `${name}: narrow card reserves space above conversation`,
      );
    else
      assert.ok(
        metrics.card.left >= metrics.composer.right,
        `${name}: wide card has a separate column`,
      );
    await capture(name);
  }
  await layout('11-status-wide-light', 1440, 900);
  await layout('12-status-medium-light', 1000, 700);
  await layout('13-status-minimum-light', 640, 480);
  await evaluate(`document.querySelector('.ia-app').classList.add('theme-dark')`);
  await layout('14-status-minimum-dark', 640, 480);
  await layout('15-status-wide-dark', 1440, 900);
  await setLanguage(window, 'en');
  await capture('16-status-wide-dark-en');

  // Escape closes the nonmodal card and returns keyboard focus to its trigger.
  await evaluate(`document.querySelector('.ia-status-card-head button').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(
    `!document.querySelector('.ia-status-dock.open') && document.activeElement === document.querySelector('.ia-status-pill')`,
  );
  assert.equal(
    await evaluate(`document.querySelector('.ia-status-pill').getAttribute('aria-expanded')`),
    'false',
  );
  assert.equal(await evaluate(`document.querySelector('.ia-status-card').hidden`), true);
  assert.equal(
    await evaluate(`(() => {
    const pill = document.querySelector('.ia-status-pill').getBoundingClientRect();
    const header = document.querySelector('.ia-chat-header').getBoundingClientRect();
    return pill.top - header.bottom >= 15 && pill.height >= 36;
  })()`),
    true,
    'Collapsed execution status has breathing room below the toolbar',
  );
  await capture('17-status-collapsed-dark-en');
  window.setBounds(originalBounds);

  console.log('[remote-ui-selftest] done');
}

async function run(window) {
  try {
    await runInner(window);
  } catch (error) {
    const directory = process.env.INDUSTRIAL_UI_SCREENSHOTS;
    if (directory) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'zz-debug.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    throw error;
  }
}

module.exports = { prepare, run };
