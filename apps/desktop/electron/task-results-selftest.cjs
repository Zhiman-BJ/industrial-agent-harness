const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const { saveProfile } = require('./model-config.cjs');
const { startResultsModel } = require('../../../tests/integration/fixtures/task-results-model.cjs');
const { verifyNavigation, verifyWheel } = require('./navigation-selftest.cjs');
let model;
let projectDirectory;
async function prepare(config, modelDirectory) {
  const directory = path.join(config, 'result-project');
  projectDirectory = directory;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manual.txt'), 'Manually selected file.');
  saveBindings(config, {
    activeId: 'result-project',
    projects: [
      {
        id: 'result-project',
        name: 'Task results',
        path: fs.realpathSync(directory),
        domain: 'cad',
      },
    ],
  });
  model = await startResultsModel();
  process.env.INDUSTRIAL_MODEL_API_KEY = 'controlled-result-selftest';
  saveProfile(modelDirectory, {
    provider: 'openai_legacy',
    endpoint: model.endpoint,
    model: 'controlled-results',
    contextSize: 131072,
    thinking: false,
  });
}
async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script, timeout = 120000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await evaluate(
        `(()=>{const card=[...document.querySelectorAll('.ia-approval')].find(card=>!card.classList.contains('ia-approval-resolved'));const button=card?.querySelector('button');if(button&&!button.disabled)button.click();})()`,
      );
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(
      'Result selftest timed out: ' +
        script +
        '; UI=' +
        (await evaluate('document.body.innerText.slice(-3500)')),
    );
  }
  await wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
  await evaluate(
    `(()=>{const input=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Create a FreeCAD plate, modify its width twice, then inspect the final model');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  await evaluate(`document.querySelector('.ia-send').click()`);
  await wait(
    `document.querySelector('.ia-task-results')?.textContent.includes('Results ready') && Number(document.querySelector('.ia-file-view:not([hidden]) .rp-cad canvas')?.dataset.renderedTriangles)>=12`,
  );
  assert.equal(await evaluate(`document.querySelectorAll('.ia-result-card').length`), 7);
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-task-results > .ia-result-card').length`),
    1,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-result-supporting .ia-result-card').length`),
    4,
  );
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.ia-result-supporting').open)`),
    false,
  );
  const rowHeights = await evaluate(
    `[...document.querySelectorAll('.ia-result-card')].map(card=>card.getBoundingClientRect().height).filter(height=>height>0)`,
  );
  assert.ok(
    rowHeights.every(height => height <= 84),
    `Default result rows must stay compact: ${rowHeights}`,
  );
  console.log('Default result row heights:', rowHeights);
  await evaluate(`document.querySelector('.ia-result-checks summary').click()`);
  await wait(
    `Boolean(document.querySelector('.ia-result-checks[open] .ia-result-check-list p')?.textContent)`,
  );
  await evaluate(`document.querySelector('.ia-result-checks[open] summary').click()`);
  await evaluate(`document.querySelector('.ia-result-supporting > summary').click()`);
  await wait(`document.querySelector('.ia-result-supporting').open`);
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('.ia-result-supporting .ia-result-source')].map(node=>node.textContent)`,
    ),
    ['Step 1', 'Step 2', 'Step 3', 'Step 4'],
  );
  await evaluate(`document.querySelector('.ia-result-supporting > summary').click()`);

  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden]) .rp-cad canvas').dataset.geometry`,
    ),
    'brep',
  );
  const measure = () =>
    evaluate(`Number(document.querySelector('.ia-file-view:not([hidden]) .rp-cad').dataset.zoom)`);
  await verifyNavigation(window, measure);
  await verifyWheel(window, measure, (deltaY, ctrlKey) =>
    evaluate(
      `(()=>{const event=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('.ia-file-view:not([hidden]) .rp-cad-viewport').dispatchEvent(event);return event.defaultPrevented;})()`,
    ),
  );
  console.log('Native cards, automatic preview and Viewer navigation passed.');
  // Opening a report during a later request must suppress its automatic model preview.
  await evaluate(
    `(()=>{document.querySelector('.ia-result-files summary').click();const button=[...document.querySelectorAll('.ia-result-file')].find(button=>button.textContent==='readback.json');button?.click();})()`,
  );
  await wait(`Boolean(document.querySelector('.ia-file-view:not([hidden]) .rp-document'))`, 20000);
  await evaluate(
    `(()=>{const input=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Repeat the FreeCAD build and continuous edits');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  await evaluate(`document.querySelector('.ia-send').click()`);
  await wait(`Boolean(document.querySelector('button[aria-label="Stop agent"]'))`);
  await evaluate(
    `[...document.querySelectorAll('.ia-result-file')].find(button=>button.textContent==='readback.json')?.click()`,
  );
  await wait(
    `document.querySelectorAll('.ia-result-card').length===14 && [...document.querySelectorAll('.ia-task-results')].at(-1)?.textContent.includes('Results ready')`,
  );
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.ia-file-view:not([hidden]) .rp-document'))`),
    true,
    'completion preserves the manually opened report',
  );
  console.log('Manual report focus preserved after the second native request.');
  await evaluate(
    "(()=>{const input=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep this unfinished draft');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  fs.writeFileSync(path.join(projectDirectory, 'manual.txt'), 'External edit after verification.');
  await wait(
    'Boolean(document.querySelector(\'.ia-result-inputs[data-input-status="changed"]\'))',
    15000,
  );
  assert.equal(
    await evaluate("document.querySelector('.ia-composer textarea').value"),
    'Keep this unfinished draft',
  );
  assert.ok(
    await evaluate("document.body.textContent.includes('Recorded version passed verification')"),
  );
  fs.writeFileSync(path.join(projectDirectory, 'manual.txt'), 'Manually selected file.');
  console.log(
    'External input edits become visible without rewriting historical verdicts or clearing the draft.',
  );
  await window.webContents.reload();
  await wait(`document.querySelectorAll('.ia-result-card').length===14`);
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.ia-file-view:not([hidden]) .rp-cad canvas'))`),
    false,
    'history replay never opens a model',
  );
  await evaluate(
    `[...document.querySelectorAll('.ia-task-results')].at(-1)?.querySelector(':scope > .ia-result-card .ia-result-open')?.click()`,
  );
  await wait(
    `Number(document.querySelector('.ia-file-view:not([hidden]) .rp-cad canvas')?.dataset.renderedTriangles)>=12`,
  );
  console.log('History replay preserved cards without automatic opening.');
  const output =
    process.env.HARNESS_RESULT_SCREENSHOT ||
    path.join(require('node:os').tmpdir(), 'task-results-66.png');
  async function capture(file) {
    await evaluate(
      `(()=>{const result=[...document.querySelectorAll('.ia-task-results')].at(-1);const scroller=result.closest('.ia-chat-scroll');scroller.scrollTop+=result.getBoundingClientRect().top-scroller.getBoundingClientRect().top-Math.max(0,(scroller.clientHeight-result.getBoundingClientRect().height)/2);})()`,
    );
    assert.ok(
      await evaluate(`document.querySelector('.ia-chat-header').getBoundingClientRect().top>=0`),
      'capturing results must not scroll the chat header out of view',
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  await capture(output);
  const supportingSummary = `[...document.querySelectorAll('.ia-result-supporting')].at(-1)`;
  await evaluate(`${supportingSummary}.querySelector('summary').click()`);
  await wait(`${supportingSummary}.open`);
  await capture(output.replace(/\.png$/, '-details.png'));
  await evaluate(`${supportingSummary}.querySelector('summary').click()`);
  await wait(`!${supportingSummary}.open`);
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(`Boolean(document.querySelector('.ia-settings-popover'))`);
  await evaluate(`document.querySelector('.ia-settings-row button').click()`);
  await wait(`Boolean(document.querySelector('.theme-dark'))`);
  await evaluate(`document.querySelector('.ia-settings-title button').click()`);
  await wait(`!document.querySelector('.ia-settings-popover')`);
  await capture(output.replace(/\.png$/, '-dark.png'));
  const originalSize = window.getSize();
  window.webContents.setZoomFactor(1);
  window.setSize(640, 640);
  console.log(
    'Narrow result layout:',
    window.getSize(),
    await evaluate('({width:innerWidth, zoom:devicePixelRatio})'),
  );
  await wait(`Boolean(document.querySelector('.layout-tabs'))`, 20000);
  assert.equal(window.getSize()[0], 640);
  await wait(`Boolean(document.querySelector('#tab-chat'))`);
  await evaluate(`document.querySelector('#tab-chat').click()`);
  await wait(
    `document.querySelector('#tab-chat')?.getAttribute('aria-selected')==='true' && document.querySelector('.ia-chat-scroll').getBoundingClientRect().width>0`,
  );
  const overflow = await evaluate(
    `[...document.querySelectorAll('.ia-result-card')].some(card=>{const row=card.querySelector('.ia-result-main');return row.scrollWidth>row.clientWidth+1})`,
  );
  assert.equal(overflow, false, 'result titles and actions must fit the narrow layout');
  await capture(output.replace(/\.png$/, '-narrow.png'));
  window.setSize(...originalSize);
  console.log(
    'Compact result rows, expandable files/checks, themes, narrow layout, native preview, focus and history passed:',
    output,
  );
  model.close();
}
module.exports = { prepare, run };
