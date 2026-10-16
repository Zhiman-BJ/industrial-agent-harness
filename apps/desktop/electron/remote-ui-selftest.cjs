// Real-app screenshot run for the remote execution UI (PR #201) against the
// local v1.1 mock service. Launched via `electron . --remote-ui-selftest` with:
//   INDUSTRIAL_REMOTE_SERVICE_URL=http://127.0.0.1:8787
//   INDUSTRIAL_REMOTE_CREDENTIAL_ENV=MOCK_REMOTE_TOKEN
//   MOCK_REMOTE_TOKEN=mock-token
//   INDUSTRIAL_UI_SCREENSHOTS=<output directory>
const fs = require('node:fs');
const path = require('node:path');
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
  // badge can be reviewed next to an unbadged local call.
  const chat = chatStore.create(fs.realpathSync(projectDir), 'chip');
  const turn = chatStore.beginTurn(chat.id, '跑一次远程冒烟检查');
  chatStore.append(turn, { type: 'text', text: '好的，我先看本机环境，再调用远程沙箱。\n' });
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

  // 7. Chat page: remote task status bar with an enabled composer.
  await click('.ia-new-chat');
  await wait(
    `document.querySelector('.ia-remote-task-status')?.textContent.includes('远程软件与沙箱')`,
  );
  await wait(`document.querySelector('.ia-composer textarea')?.disabled === false`);
  await capture('09-chat-remote-ready');

  // 8. Open the seeded chat: the remote sandbox tool call carries a green
  // badge while the local call does not. Tool identities arrive through the
  // status-bar poll, so wait for the badge rather than assuming timing.
  await clickText('.ia-sidebar-chat', '跑一次远程冒烟检查');
  await wait(`Boolean(document.querySelector('.ia-agent-tool .ia-remote-badge'))`);
  await capture('10-chat-remote-tool-badge');

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
