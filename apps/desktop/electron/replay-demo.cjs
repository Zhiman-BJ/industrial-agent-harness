'use strict';

// --replay-demo 的演示驱动：像用户一样在 composer 里输入当时的问题并发送，
// 重放的轨迹在真实产品 UI 里逐事件展开。跑完截图存证，不退出——窗口留给用户。
const fs = require('node:fs');

const PROMPTS = [
  '帮我把这版 Sobel 布局过一遍检查，重点看电源网络和 DRC。',
  '器件总数是多少？电源检查有什么异常吗？',
];
const SHOTS = '/tmp/zm-replay-demo/shots';

async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.error(`[replay-demo] 等待超时: ${script}`);
  }
  async function send(task) {
    await evaluate(`(() => {
      const area = document.querySelector('.ia-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(task)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    // 上一轮 operation 可能尚未完全 settle：撞上 already running 就等 2s 重试。
    for (let attempt = 0; attempt < 10; attempt++) {
      await evaluate(`document.querySelector('.ia-send').click()`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      const busy = await evaluate(`Boolean(document.querySelector('.ia-flow-error'))`);
      if (!busy) return;
      await evaluate(`document.querySelector('.ia-flow-error')?.remove()`);
    }
    throw Error('send kept failing: ' + task);
  }
  async function shot(name) {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(`${SHOTS}/${name}.png`, (await window.webContents.capturePage()).toPNG());
  }

  try {
    await wait(`!!document.querySelector('.ia-composer textarea')`);
    await wait(`!document.querySelector('.ia-composer textarea').disabled`, 30000);
    await new Promise(resolve => setTimeout(resolve, 1200));

    console.log('[replay-demo] 提交第 1 轮（对应录制 turn-1）');
    await send(PROMPTS[0]);
    await shot('turn1-mid');
    await wait(
      `document.querySelectorAll('.ia-chat-turn').length === 1 && !document.querySelector('.ia-composer textarea').disabled`,
    );
    await shot('turn1-done');

    await new Promise(resolve => setTimeout(resolve, 1500));
    console.log('[replay-demo] 提交第 2 轮（对应录制 turn-2）');
    await send(PROMPTS[1]);
    await wait(
      `document.querySelectorAll('.ia-chat-turn').length === 2 && !document.querySelector('.ia-composer textarea').disabled`,
    );
    await shot('turn2-done');
    console.log('[replay-demo] 重放完成：两轮轨迹已在真实产品 UI 中重演');
  } catch (error) {
    console.error('[replay-demo] 驱动失败:', error);
    await shot('failure');
  }
}

module.exports = { run };
