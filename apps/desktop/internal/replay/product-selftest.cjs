'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setLanguage } = require('../../electron/selftest-language.cjs');
const {
  verifyNavigation,
  verifyWheel,
  waitForFittedView,
} = require('../../electron/navigation-selftest.cjs');

async function run(window, backend, calls) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(check, message, timeoutMs = 45000) {
    const end = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < end) {
      try {
        if (await check()) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
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
  async function click(selector) {
    await wait(
      () =>
        evaluate(
          `(() => { const button=document.querySelector(${JSON.stringify(selector)}); if(!button || button.disabled)return false;button.click();return true;})()`,
        ),
      `Product control unavailable: ${selector}`,
    );
  }
  async function showFiles() {
    await evaluate(`(() => {
      const button=document.querySelector('button[aria-label="Show workspace"]') || document.querySelector('button[aria-label="Open project files"]');
      button?.click();
    })()`);
    await wait(
      () => evaluate(`Boolean(document.querySelector('.ia-workspace-actions'))`),
      'Product workspace did not open',
    );
    await evaluate(`document.querySelector('button[aria-label="Show file tree"]')?.click()`);
    await click('button[aria-label="Refresh file list"]');
    await wait(
      () =>
        evaluate(
          `Boolean(document.querySelector('.ia-file-list button[title="board.kicad_pcb"]'))`,
        ),
      'Recorded native board is absent from the product file tree',
    );
  }
  async function closeBoard() {
    await evaluate(`(() => {
      const close=document.querySelector('button[aria-label="Close tab board.kicad_pcb"]') || document.querySelector('button[aria-label="Close file"]');
      close?.click();
    })()`);
    await wait(
      () => evaluate(`!document.querySelector('.ia-file-view[data-file-path="board.kicad_pcb"]')`),
      'Product did not release the previous native file tab',
    );
  }
  async function openBoard() {
    await showFiles();
    await click('.ia-file-list button[title="board.kicad_pcb"]');
    await wait(
      () =>
        evaluate(
          `document.querySelector('.ia-file-view:not([hidden]) .rp-kicad-toolbar strong')?.textContent==='board.kicad_pcb' && document.querySelector('.ia-file-view:not([hidden]) button[aria-label="3D PCB"]')?.disabled===false`,
        ),
      'Production KiCad Viewer did not become ready',
    );
    const url = await evaluate(`document.querySelector('.ia-file-view:not([hidden]) iframe').src`);
    assert.match(url, /^app:\/\/kicad\/[^/]+\/index\.html$/);
    const frame = window.webContents.mainFrame.frames.find(candidate => candidate.url === url);
    assert.ok(frame, 'Native PCB uses the production isolated iframe');
    await click('.ia-file-view:not([hidden]) button[aria-label="3D PCB"]');
    await wait(
      () =>
        frame.executeJavaScript(
          `document.body.dataset.pcb3d==='ready' && document.body.dataset.pcbMode==='3d'`,
        ),
      'Native WebGL PCB scene did not become ready',
    );
    await wait(
      () =>
        evaluate(
          `document.querySelector('.ia-file-view:not([hidden]) button[aria-label="3D PCB"]')?.getAttribute('aria-pressed')==='true' && Boolean(document.querySelector('.ia-file-view:not([hidden]) .rp-pcb3d-panel')) && !document.querySelector('.ia-file-view:not([hidden]) .rp-kicad-status')`,
        ),
      'The production KiCad controls did not finish their native scene transition',
    );
    const canvasState = () =>
      frame.executeJavaScript(`(() => {
      const canvas=document.querySelector('.pcb3d-scene canvas');
      return canvas ? {...canvas.dataset,width:canvas.width,height:canvas.height,
        clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight,
        webgl:Boolean(canvas.getContext('webgl2')||canvas.getContext('webgl'))} : null;
    })()`);
    await wait(
      async () => Number((await canvasState())?.pcb3dDrawCalls) > 0,
      'Native WebGL did not draw geometry',
    );
    const state = await canvasState();
    assert.ok(
      state.webgl && state.width > 100 && state.height > 100,
      'A real native WebGL canvas is visible',
    );
    assert.ok(Number(state.pcb3dTriangles) > 0, 'The native board contains rendered triangles');
    assert.ok(Number(state.pcb3dRenderedModels) > 0, 'Recorded component models are rendered');
    await click('button[aria-label="Fit viewer"]');
    await waitForFittedView(
      async () => {
        const view = await canvasState();
        return {
          scale: Number(view.pcb3dPercent),
          ready: view.pcb3dReady === 'true',
          layoutKey: [view.width, view.height, view.clientWidth, view.clientHeight],
        };
      },
      () => click('button[aria-label="Fit viewer"]'),
    );
    return { url, frame, canvasState, state };
  }
  const productUrl = new URL(window.webContents.getURL());
  assert.equal(productUrl.protocol, 'app:');
  assert.equal(productUrl.hostname, 'viewer');
  await wait(
    () => evaluate(`Boolean(document.querySelector('.ia-app .ia-chat'))`),
    'Complete production App did not mount',
  );
  assert.equal(
    await evaluate(`typeof window.viewerHost?.open==='function' && !window.replayHost`),
    true,
    'Only the production preload API is exposed in the product window',
  );
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('.ia-replay-stage-panel, .ia-replay-stage-canvas'))`,
    ),
    false,
    'The product workspace is not replaced with the previous replay shell',
  );
  await setLanguage(window, 'en');
  const metadata = backend.controller.metadata();
  const stages = metadata.replayStages || [];
  assert.ok(stages.length > 0, 'Native stage acceptance requires recorded native snapshots');
  const results = [];
  let previous;
  for (const [index, stage] of stages.entries()) {
    backend.control({ action: 'seek', value: stage.position });
    assert.equal(backend.viewer.snapshot().stageId, stage.id);
    if (previous) {
      assert.equal(
        (await backend.viewer.handleProtocol(new Request(previous.url))).status,
        404,
        'Historical stage changes release the preceding native token',
      );
      await closeBoard();
    }
    const opened = await openBoard();
    const source = await backend.viewer.handleProtocol(
      new Request(opened.url.replace('index.html', 'manifest.json')),
    );
    assert.equal(source.status, 200);
    const manifest = await source.json();
    assert.equal(manifest.boardSha256, backend.viewer.snapshot().sourceSha256);
    assert.ok(
      manifest.models.every(model => model.status === 'ready'),
      'All declared native models are available offline',
    );
    if (index === 0) {
      const measure = async () => Number((await opened.canvasState())?.pcb3dPercent);
      await verifyNavigation(window, measure, {
        snapshot: async () => {
          const state = await opened.canvasState();
          return {
            scale: Number(state.pcb3dPercent),
            ready: state.pcb3dReady === 'true',
            layoutKey: [state.width, state.height, state.clientWidth, state.clientHeight],
          };
        },
      });
      await verifyWheel(
        window,
        measure,
        (deltaY, ctrlKey) =>
          opened.frame.executeJavaScript(`(() => {
        const canvas=document.querySelector('.pcb3d-scene canvas'),r=canvas.getBoundingClientRect();
        return !canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},
          clientX:r.left+r.width*.6,clientY:r.top+r.height*.4,bubbles:true,cancelable:true}));
      })()`),
        { deltaY: -120 },
      );
      const before = await opened.frame.executeJavaScript(`window.pcb3dInspection.getState()`);
      await evaluate(
        `Array.from(document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-pcb3d-views button')).find(button=>button.textContent==='Top').click()`,
      );
      await wait(
        () =>
          opened.frame.executeJavaScript(`(() => {
        const {camera,target}=window.pcb3dInspection.getState(), z=camera[2]-target[2];
        return z>0 && Math.abs((camera[0]-target[0])/z)<0.0001;
      })()`),
        'Native Top preset did not change the rendered camera',
      );
      const top = await opened.frame.executeJavaScript(`window.pcb3dInspection.getState()`);
      assert.notDeepEqual(top.camera, before.camera);
      await click('button[aria-label="Fit viewer"]');
    }
    await wait(
      () => evaluate(`document.querySelectorAll('.ia-chat-turn').length>0`),
      'Recorded conversation is absent from the production chat',
    );
    await shot(`native-product-stage-${String(index + 1).padStart(2, '0')}`);
    const rendered = await opened.canvasState();
    results.push({
      stageId: stage.id,
      position: stage.position,
      sourceSha256: manifest.boardSha256,
      viewerOrigin: `${new URL(opened.url).protocol}//${new URL(opened.url).hostname}`,
      models: manifest.models.length,
      renderedModels: Number(rendered.pcb3dRenderedModels),
      triangles: Number(rendered.pcb3dTriangles),
      drawCalls: Number(rendered.pcb3dDrawCalls),
      sceneId: rendered.pcb3dSceneId,
    });
    previous = opened;
  }
  backend.control({ action: 'seek', value: stages[0].position });
  assert.equal((await backend.viewer.handleProtocol(new Request(previous.url))).status, 404);
  await closeBoard();
  const restored = await openBoard();
  assert.equal(
    backend.viewer.snapshot().sourceSha256,
    results[0].sourceSha256,
    'Backward seek restores the initial native board snapshot',
  );
  backend.control({ action: 'reset' });
  assert.equal(
    (await backend.viewer.handleProtocol(new Request(restored.url))).status,
    404,
    'Reset releases the active native Viewer',
  );
  assert.equal(backend.viewer.snapshot().stageId, null);
  await closeBoard();
  const report = {
    schema: 'product-native-replay-ui/1',
    renderer: window.webContents.getURL(),
    recordingId: metadata.manifest.recordingId,
    stages: results,
    checks: [
      'production-app',
      'production-preload',
      'product-file-tree',
      'registry-native-pcb',
      'native-webgl-3d',
      'recorded-models',
      'zoom-fit',
      'wheel-pinch',
      'fullscreen-retention',
      'native-camera-preset',
      'stage-token-release',
      'backward-native-snapshot',
      'reset-release',
    ],
    calls: { ...calls },
  };
  for (const [key, value] of Object.entries(calls))
    assert.equal(value, 0, `Replay attempted ${key}`);
  if (screenshots)
    fs.writeFileSync(
      path.join(screenshots, 'product-native-replay-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { run };
