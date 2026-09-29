const assert = require('node:assert/strict');
async function verifyNavigation(window, measure, {percent = true} = {}) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(check) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Viewer navigation did not affect the rendered view.');
  }
  const click = label => evaluate(`document.querySelector('button[aria-label="${label}"]').click()`);
  await wait(() => evaluate(`document.querySelector('button[aria-label="Zoom in"]')?.disabled === false`));
  await click('Fit viewer');
  if (percent) await wait(() => evaluate(`document.querySelector('output[aria-label="Viewer zoom"]')?.innerText === '100%'`));
  const fitted = await measure();
  assert.ok(Number.isFinite(fitted) && fitted > 0, `Native fitted view: ${fitted}`);
  await click('Zoom in');
  await wait(async () => (await measure()) > fitted * 1.05);
  await click('Zoom out');
  await wait(async () => Math.abs((await measure()) / fitted - 1) < 0.01);
  await click('Zoom in');
  await click('Fit viewer');
  await wait(async () => Math.abs((await measure()) / fitted - 1) < 0.01);
  await click('Fullscreen viewer');
  await wait(() => evaluate(`Boolean(document.fullscreenElement?.classList.contains('ia-workspace'))`));
  assert.equal(await evaluate(`Boolean(document.querySelector('button[aria-label="Zoom in"]') && document.querySelector('.ia-viewer-footer'))`), true, 'fullscreen retains controls and status');
  await click('Exit viewer fullscreen');
  await wait(() => evaluate(`!document.fullscreenElement`));
  // Let the native canvas ResizeObserver settle before fitting the restored panel.
  await new Promise(resolve => setTimeout(resolve, 300));
  await click('Fit viewer');
}
async function verifyWheel(window, measure, dispatch) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  for (const ctrlKey of [false,true]) {
    await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const before = await measure();
    assert.equal(await dispatch(-60, ctrlKey), true, 'wheel is consumed by the view');
    const deadline = Date.now() + 15000;
    let changed = false;
    while (Date.now() < deadline) {
      if (await measure() > before * 1.05) {changed = true; break;}
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.ok(changed, `Wheel/pinch did not magnify native content (Ctrl=${ctrlKey})`);
  }
  await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
}
module.exports = {verifyNavigation, verifyWheel};
