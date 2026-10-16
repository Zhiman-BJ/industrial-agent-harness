const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const {
  verifyNavigation,
  verifyWheel,
  transitionFullscreen,
} = require('./navigation-selftest.cjs');
const { createProjectRuntime } = require('@industrial-agent-harness/harness-core');
let project;
async function prepare(config) {
  project = path.join(config, 'cad-project');
  fs.mkdirSync(project, { recursive: true });
  const { runtime } = createProjectRuntime({ projectDir: project, domain: 'cad' });
  try {
    const state = await runtime.inspect();
    const out = await runtime.execute(
      {
        toolId: 'cad.freecad.build',
        inputs: {
          recipe: {
            features: [
              {
                id: 'Plate',
                op: 'sketch_pad',
                profile: 'rectangle',
                length: 40,
                width: 20,
                height: 5,
              },
              {
                id: 'Drilled',
                op: 'hole',
                base: 'Plate',
                radius: 2,
                height: 5,
                origin: [10, 10, 0],
              },
            ],
            result: 'Drilled',
          },
          expect: { volume: 4000 - 20 * Math.PI, solids: 1 },
        },
        expectedStateId: state.id,
      },
      {
        scope: {
          domain: 'cad',
          projectId: state.projectId,
          stateId: state.id,
          tools: ['cad.freecad.build'],
        },
        approval: true,
      },
    );
    assert.equal(out.verification.status, 'passed', JSON.stringify(out.action));
    for (const name of [
      'model.FCStd',
      'model.step',
      'model.stl',
      'model.brep',
      'model.recipe.json',
      'model.cad-preview.json',
      'model.cad-sketches.json',
    ]) {
      const file = out.artifacts.find(a => path.basename(a.relativePath) === name);
      fs.copyFileSync(path.join(project, file.relativePath), path.join(project, name));
    }
  } finally {
    runtime.close();
  }
  fs.writeFileSync(path.join(project, 'bad.stl'), 'invalid');
  saveBindings(config, {
    activeId: 'cad-selftest',
    projects: [
      {
        id: 'cad-selftest',
        name: 'FreeCAD project',
        path: fs.realpathSync(project),
        domain: 'cad',
      },
    ],
  });
}
async function run(window) {
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw Error('CAD selftest renderer script failed: ' + script, { cause: error });
    }
  };
  async function wait(script) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(
      'CAD selftest timed out: ' +
        script +
        '; UI=' +
        (await evaluate(`document.body.innerText.slice(-2000)`)),
    );
  }
  await wait(`document.querySelector('.ia-domain-pill')?.innerText.includes('CAD')`);
  const prompt = '修改零件的形状';
  await evaluate(
    `(()=>{const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(prompt)});area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await new Promise(resolve => setTimeout(resolve, 70));
  await evaluate(`document.querySelector('.ia-send').click()`);
  await wait(
    `document.querySelector('.ia-setup-banner')?.textContent.includes('Configure the Model API') && document.querySelector('.ia-setup-banner button')?.textContent === 'Open model settings'`,
  );
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').value`), prompt);
  assert.equal(await evaluate(`document.querySelector('.ia-composer textarea').disabled`), false);
  assert.equal(await evaluate(`document.querySelectorAll('.ia-chat-turn').length`), 0);

  await evaluate(`document.querySelector('[data-testid="workspace-toggle"]').click()`);
  await wait(`Boolean(document.querySelector('.ia-file-tree-toggle'))`);
  await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
  async function open(name) {
    await wait(
      `Boolean(document.querySelector('.ia-file-list button[title=${JSON.stringify(name)}]'))`,
    );
    await evaluate(
      `document.querySelector('.ia-file-list button[title=${JSON.stringify(name)}]').click()`,
    );
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad strong')?.textContent===${JSON.stringify(name)} && Number(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas')?.dataset.renderedTriangles)>20 && document.querySelector('.ia-viewer-footer')?.innerText.includes('CAD · Ready')`,
    );
  }
  await open('model.FCStd');
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas').dataset.geometry`,
    ),
    'brep',
  );
  assert.match(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas').dataset.engine`,
    ),
    /OCCT.*AIS\/V3d/,
  );
  const measure = () =>
    evaluate(
      `Number(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.zoom)`,
    );
  await verifyNavigation(window, measure);
  await verifyWheel(window, measure, (delta, ctrl) =>
    evaluate(
      `(()=>{const event=new WheelEvent('wheel',{deltaY:${delta},ctrlKey:${ctrl},cancelable:true});document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad-viewport').dispatchEvent(event);return event.defaultPrevented;})()`,
    ),
  );
  // React publishes the camera attributes before its effect schedules the
  // native pose update. Let the fitted view paint, then compare only canvas
  // pixels so unrelated UI updates cannot satisfy the redraw assertion.
  await evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
  const canvasRect = await evaluate(`(() => {
    const r = document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas').getBoundingClientRect();
    return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
  })()`);
  const captureCanvas = async () => (await window.webContents.capturePage(canvasRect)).toPNG();
  const beforeRotation = await captureCanvas();
  const yaw = await evaluate(
    `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw`,
  );
  await evaluate(
    `(()=>{const node=document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad-viewport');node.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:100,clientY:100,bubbles:true}));node.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:145,clientY:120,bubbles:true}));node.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true}));})()`,
  );
  await wait(
    `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw!==${JSON.stringify(yaw)}`,
  );
  const redrawDeadline = Date.now() + 15000;
  let afterRotation = await captureCanvas();
  while (afterRotation.equals(beforeRotation) && Date.now() < redrawDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    afterRotation = await captureCanvas();
  }
  assert.notDeepEqual(
    afterRotation,
    beforeRotation,
    'OCCT must redraw pixels after camera rotation',
  );
  const rotated = await evaluate(
    `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw`,
  );
  await evaluate(
    `(()=>{const node=document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad-viewport');node.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:100,clientY:100,shiftKey:true,bubbles:true}));node.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:125,clientY:115,shiftKey:true,bubbles:true}));node.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true}));})()`,
  );
  await wait(
    `Number(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.panX)===25 && Number(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.panY)===15`,
  );
  await transitionFullscreen(window, true, () =>
    evaluate(`document.querySelector('button[aria-label="Fullscreen viewer"]').click()`),
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw`,
    ),
    rotated,
  );
  await transitionFullscreen(window, false, () => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw`,
    ),
    rotated,
  );
  fs.writeFileSync(
    path.join(project, 'cad-viewer.png'),
    (await window.webContents.capturePage()).toPNG(),
  );
  if (process.env.HARNESS_CAD_SELFTEST_OUTPUT)
    fs.copyFileSync(path.join(project, 'cad-viewer.png'), process.env.HARNESS_CAD_SELFTEST_OUTPUT);
  await require('./cad-inspection-selftest.cjs').verifyInspection(window, project);
  if (process.argv.includes('--cad-resize-selftest'))
    await require('./cad-resize-selftest.cjs').verifyResize(window, project);
  await open('model.step');
  await open('model.stl');
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])').querySelector('button[aria-label="Measurement"]').disabled`,
    ),
    true,
  );
  assert.match(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad-note').textContent`,
    ),
    /Mesh-only preview/,
  );
  // A real completed Runtime action must publish new files without reopening
  // the project. Relay its actual result through the production event channel.
  const { runtime } = createProjectRuntime({ projectDir: project, domain: 'cad' });
  let exported;
  try {
    const state = await runtime.inspect();
    exported = await runtime.execute(
      {
        toolId: 'cad.freecad.export',
        inputs: { file: 'model.FCStd', expect: { volume: 4000 - 20 * Math.PI } },
        expectedStateId: state.id,
      },
      {
        scope: {
          domain: 'cad',
          projectId: state.projectId,
          stateId: state.id,
          tools: ['cad.freecad.export'],
        },
        approval: true,
      },
    );
    assert.equal(exported.verification.status, 'passed');
  } finally {
    runtime.close();
  }
  window.webContents.send('agent:event', { type: 'industrial-result', ...exported });
  const created = exported.artifacts.find(item => item.kind === 'model.cad.fcstd').relativePath;
  await wait(
    `Boolean(document.querySelector('.ia-file-list button[title=${JSON.stringify(created)}]'))`,
  );
  await evaluate(`document.querySelector('.ia-file-list button[title="bad.stl"]').click()`);
  await wait(`document.body.innerText.includes('Unsupported STL encoding')`);
  assert.equal(
    await evaluate(
      `!document.querySelector('button[aria-label="Zoom in"]') || document.querySelector('button[aria-label="Zoom in"]').disabled`,
    ),
    true,
  );
  console.log(
    'FreeCAD native build → file tree → Registry → OCCT BREP → rotation/pan/zoom/wheel/Fit/fullscreen/Esc/new artifacts/failure passed:',
    project,
  );
}
module.exports = { prepare, run };
