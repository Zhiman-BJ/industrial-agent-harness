'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run(window, controller, calls) {
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  async function wait(source) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await evaluate(source)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Replay UI timeout: ${source}`);
  }
  const screenshots = process.env.INDUSTRIAL_UI_SCREENSHOTS;
  async function shot(name) {
    if (!screenshots) return;
    fs.mkdirSync(screenshots, { recursive: true });
    fs.writeFileSync(
      path.join(screenshots, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  await wait(`Boolean(document.querySelector('[data-control="play"]'))`);
  const initial = controller.metadata();
  assert.ok(initial.totalEvents > 0);
  assert.equal(await evaluate(`Boolean(window.viewerHost || window.harnessAccount)`), false);
  assert.equal(await evaluate(`document.querySelectorAll('textarea, form, iframe').length`), 0);
  await evaluate(`document.querySelector('[data-control="play"]').click()`);
  await wait(`document.querySelector('.ia-replay-progress').dataset.position !== '0'`);
  await evaluate(`document.querySelector('[data-control="play"]').click()`);
  await wait(`document.querySelector('[data-control="play"]').textContent.match(/Play|播放/)`);
  const paused = controller.snapshot().position;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(controller.snapshot().position, paused, 'pause stops advancement');
  await evaluate(
    `(() => { const select = document.querySelector('[data-control="speed"]'); select.value='4'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`,
  );
  await wait(`document.querySelector('[data-control="speed"]').value === '4'`);
  const middle = Math.floor(initial.totalEvents / 2);
  await evaluate(`(() => {
    const range = document.querySelector('[data-control="position"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '${middle}');
    range.dispatchEvent(new Event('input', {bubbles:true}));
    range.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await wait(`document.querySelector('.ia-replay-progress').dataset.position === '${middle}'`);
  await evaluate(`document.querySelector('[data-control="reset"]').click()`);
  await wait(`document.querySelector('.ia-replay-progress').dataset.position === '0'`);
  // Drive the complete ordinary playback path in a single large host tick;
  // cursor/display semantics are the same as the interval clock, without a
  // multi-hour real-time test. Every native record goes through engine.tick.
  controller.control({ action: 'play' });
  const end = controller.tick(Number.MAX_SAFE_INTEGER);
  assert.equal(end.position, initial.totalEvents);
  assert.equal(end.atEnd, true);
  await wait(
    `document.querySelector('.ia-replay-progress').dataset.position === '${initial.totalEvents}'`,
  );
  await shot('replay-complete');
  const coverage = [];
  for (const agent of end.agents) {
    await evaluate(
      `document.querySelector('[data-agent-filter=${JSON.stringify(agent.id)}]').click()`,
    );
    await wait(
      `document.querySelectorAll('.ia-replay-record').length > 0 && [...document.querySelectorAll('.ia-replay-record')].every(row => row.dataset.agent === ${JSON.stringify(agent.id)})`,
    );
    let count = 0;
    const positions = new Set();
    // Read all bounded pages through the exact renderer IPC API, including
    // raw source metadata. A UI page never silently drops remaining events.
    for (let offset = 0; offset < agent.totalEvents; offset += 100) {
      const page = await evaluate(
        `window.replayHost.page({agentId:${JSON.stringify(agent.id)},offset:${offset}})`,
      );
      for (const row of page.rows) {
        assert.ok(!positions.has(row.sourceIndex));
        positions.add(row.sourceIndex);
        count++;
      }
    }
    assert.equal(count, agent.totalEvents);
    coverage.push({ id: agent.id, events: count, reached: agent.reachedEvents });
  }
  const finalAgent = end.agents.at(-1);
  if (finalAgent.totalEvents > 100) {
    await evaluate(`document.querySelector('[data-control="previous"]').click()`);
    await wait(`!document.querySelector('[data-control="next"]').disabled`);
    await evaluate(`document.querySelector('[data-control="next"]').click()`);
    await wait(`document.querySelector('[data-control="next"]').disabled`);
  }
  await evaluate(`document.querySelector('.ia-replay-source').open = true`);
  await wait(`Boolean(document.querySelector('.ia-replay-source pre'))`);
  await shot('replay-agent-source');
  const report = {
    recordingId: initial.manifest.recordingId,
    totalEvents: initial.totalEvents,
    reachedEvents: end.position,
    agents: coverage,
    ...calls,
    checks: [
      'renderer-controls',
      'pause',
      'speed',
      'seek-slider',
      'reset',
      'full-engine-playback',
      'all-agent-pages',
      'source-record-inspection',
      'no-live-preload',
      'fail-on-call-live-dependencies',
    ],
  };
  assert.deepEqual(calls, { modelCalls: 0, toolCalls: 0, scriptCalls: 0, networkCalls: 0 });
  if (screenshots)
    fs.writeFileSync(path.join(screenshots, 'replay-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { run };
