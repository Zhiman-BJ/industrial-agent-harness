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
  const stageCoverage = [];
  if (initial.replayStages.length) {
    assert.equal(await evaluate(`document.querySelector('.ia-replay-ledger').open`), false);
    if (initial.manifest.demo?.constructed || initial.manifest.source?.kind === 'constructed-demo')
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-constructed-demo="true"]'))`),
        true,
      );
    for (const [index, stage] of initial.replayStages.entries()) {
      await evaluate(
        `document.querySelector('[data-stage-control=${JSON.stringify(stage.id)}]').click()`,
      );
      await wait(
        `document.querySelector('.ia-replay-progress').dataset.position === '${stage.position}' && document.querySelector('.ia-replay-stage-canvas').dataset.stageId === ${JSON.stringify(stage.id)} && document.querySelector('.ia-replay-stage-canvas').dataset.imageLoaded === 'true'`,
      );
      const image = await evaluate(`window.replayHost.image(${JSON.stringify(stage.assetId)})`);
      await wait(
        `Boolean(document.querySelector('.ia-replay-stage-canvas .rp-asset-canvas canvas')) && document.querySelector('.ia-chat-scroll').dataset.flowPosition === '${stage.position}'`,
      );
      assert.equal(
        await evaluate(
          `(() => {const canvas=document.querySelector('.rp-asset-canvas canvas'); return canvas.width > 0 && canvas.height > 0;})()`,
        ),
        true,
      );
      assert.ok(image.bytes > 0 && /^[0-9a-f]{64}$/.test(image.sha256));
      stageCoverage.push({
        id: stage.id,
        atSeq: stage.atSeq,
        assetId: stage.assetId,
        width: image.width,
        height: image.height,
      });
      await shot(`replay-stage-${String(index + 1).padStart(2, '0')}`);
    }
    assert.equal(
      await evaluate(`window.replayHost.image('../outside.png').then(() => false, () => true)`),
      true,
    );
    await evaluate(`document.querySelector('.ia-view-navigation button:nth-of-type(2)').click()`);
    await wait(`document.querySelector('.ia-view-navigation output').textContent === '125%'`);
    await evaluate(`document.querySelector('.ia-view-navigation button:nth-of-type(3)').click()`);
    await wait(`document.querySelector('.ia-view-navigation output').textContent === '100%'`);
    await evaluate(`document.querySelector('[data-control="reset"]').click()`);
    await wait(
      `document.querySelector('.ia-replay-progress').dataset.position === '0' && document.querySelector('.ia-replay-stage-canvas').dataset.stageId === ''`,
    );
  }
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
  await wait(
    `document.querySelector('.ia-chat-scroll').dataset.flowPosition === '${initial.totalEvents}'`,
  );
  if (initial.replayStages.length) {
    const finalStage = initial.replayStages.at(-1);
    await wait(
      `document.querySelector('.ia-replay-stage-canvas').dataset.stageId === ${JSON.stringify(finalStage.id)} && document.querySelector('.ia-replay-stage-canvas').dataset.imageLoaded === 'true'`,
    );
  }
  await shot('replay-complete');
  await evaluate(
    `document.querySelector('.ia-replay-diagnostics').open = true; document.querySelector('.ia-replay-ledger').open = true`,
  );
  const coverage = [];
  const flowCoverage = [];
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
    const firstFlow = await evaluate(
      `window.replayHost.flow({agentId:${JSON.stringify(agent.id)},turnOffset:0,blockOffset:0})`,
    );
    let blocks = 0;
    let pages = 0;
    for (let turnOffset = 0; turnOffset < firstFlow.totalTurns; turnOffset++) {
      let totalBlocks = 1;
      for (let blockOffset = 0; blockOffset < totalBlocks; blockOffset += 40) {
        const flow = await evaluate(
          `window.replayHost.flow({agentId:${JSON.stringify(agent.id)},turnOffset:${turnOffset},blockOffset:${blockOffset}})`,
        );
        totalBlocks = flow.turn.totalBlocks;
        pages++;
        blocks += Math.min(40, totalBlocks - blockOffset);
        const tools = new Set(
          flow.turn.events.filter(event => event.type === 'tool').map(event => event.id),
        );
        for (const event of flow.turn.events) {
          assert.notEqual(event.type, 'status');
          assert.notEqual(event.replayRole, 'user');
          if (event.type === 'tool-result')
            assert.ok(tools.has(event.id), `Flow page orphaned ${event.id}`);
        }
      }
    }
    flowCoverage.push({ id: agent.id, turns: firstFlow.totalTurns, pages, blocks });
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
  if (initial.replayStages.length)
    await evaluate(`document.querySelector('.ia-replay-ledger').scrollIntoView({block:'start'})`);
  await shot('replay-agent-source');
  const report = {
    recordingId: initial.manifest.recordingId,
    totalEvents: initial.totalEvents,
    reachedEvents: end.position,
    agents: coverage,
    conversation: flowCoverage,
    stages: stageCoverage,
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
      'production-AgentFlow',
      'bounded-conversation-pages',
      ...(stageCoverage.length
        ? ['production-ViewerCanvas', 'viewer-zoom-fit', 'all-stage-images']
        : []),
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
