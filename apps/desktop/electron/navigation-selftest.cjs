const assert = require('node:assert/strict');
const layoutSignature = view => JSON.stringify(view.layoutKey ?? null);
async function waitForFittedView(
  read,
  refit,
  { now = Date.now, pause = () => new Promise(resolve => setTimeout(resolve, 100)) } = {},
) {
  const deadline = now() + 15000;
  let previousScale,
    previousLayout,
    stable = 0,
    last,
    needsFit = false;
  while (now() < deadline) {
    last = await read();
    const layoutKey = layoutSignature(last);
    if (last.ready === false || !Number.isFinite(last.scale) || last.scale <= 0) {
      stable = 0;
      previousScale = undefined;
      needsFit = true;
    } else if (needsFit || (previousLayout !== undefined && layoutKey !== previousLayout)) {
      // Resize can leave the old zoom intact. Fit the new viewport before
      // establishing a baseline; an unchanged zoom alone is not readiness.
      await refit();
      stable = 0;
      previousScale = undefined;
      previousLayout = layoutKey;
      needsFit = false;
    } else {
      stable =
        Number.isFinite(previousScale) && Math.abs(last.scale / previousScale - 1) < 1e-6
          ? stable + 1
          : 0;
      previousScale = last.scale;
      previousLayout = layoutKey;
      if (stable >= 7) return { scale: last.scale, layoutKey };
    }
    await pause();
  }
  throw Error(`Viewer Fit baseline did not settle: ${JSON.stringify(last)}`);
}
async function measureStableLayout(read, baseline) {
  const view = await read();
  if (view.ready === false || layoutSignature(view) !== baseline.layoutKey)
    throw Error(
      `Viewer layout changed during navigation: baseline=${baseline.layoutKey}, current=${layoutSignature(view)}`,
    );
  return view.scale;
}
async function verifyNavigation(window, measure, { percent = true, snapshot } = {}) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(check) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Viewer navigation did not affect the rendered view.');
  }
  const click = async label => {
    // Fullscreen events can precede React's update of the button label.
    // Check readiness and click in one renderer task to avoid a stale selector.
    await wait(() =>
      evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`),
    );
  };
  await wait(() =>
    evaluate(`document.querySelector('button[aria-label="Zoom in"]')?.disabled === false`),
  );
  await click('Fit viewer');
  if (percent)
    await wait(() =>
      evaluate(`document.querySelector('output[aria-label="Viewer zoom"]')?.innerText === '100%'`),
    );
  // Ready navigation can precede the first canvas ResizeObserver paint.
  await wait(async () => {
    const value = await measure();
    return Number.isFinite(value) && value > 0;
  });
  const read = snapshot || (async () => ({ scale: await measure() }));
  const baseline = await waitForFittedView(read, () => click('Fit viewer'));
  const fitted = baseline.scale;
  const currentScale = () => measureStableLayout(read, baseline);
  assert.ok(Number.isFinite(fitted) && fitted > 0, `Native fitted view: ${fitted}`);
  await click('Zoom in');
  await wait(async () => (await currentScale()) > fitted * 1.05);
  await click('Zoom out');
  try {
    await wait(async () => Math.abs((await currentScale()) / fitted - 1) < 0.01);
  } catch (error) {
    throw Error(
      `Zoom out did not restore the fitted scale: fit=${fitted}, actual=${await currentScale()}`,
      { cause: error },
    );
  }
  await click('Zoom in');
  await click('Fit viewer');
  try {
    await wait(async () => Math.abs((await currentScale()) / fitted - 1) < 0.01);
  } catch (error) {
    throw Error(
      `Fit did not restore the fitted scale: fit=${fitted}, actual=${await currentScale()}`,
      {
        cause: error,
      },
    );
  }
  await transitionFullscreen(window, true, () => click('Fullscreen viewer'));
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('button[aria-label="Zoom in"]') && document.querySelector('.ia-viewer-footer'))`,
    ),
    true,
    'fullscreen retains controls and status',
  );
  await transitionFullscreen(window, false, () => click('Exit viewer fullscreen'));
  // Let the native canvas ResizeObserver settle before fitting the restored panel.
  await new Promise(resolve => setTimeout(resolve, 1000));
  await click('Fit viewer');
}
async function verifyWheel(window, measure, dispatch, { deltaY = -60 } = {}) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  for (const ctrlKey of [false, true]) {
    await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const before = await measure();
    assert.equal(await dispatch(deltaY, ctrlKey), true, 'wheel is consumed by the view');
    const deadline = Date.now() + 15000;
    let changed = false;
    while (Date.now() < deadline) {
      if ((await measure()) > before * 1.05) {
        changed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(changed, `Wheel/pinch did not magnify native content (Ctrl=${ctrlKey})`);
  }
  await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
}
// Text-like views (documents, engineering source/structure): a plain wheel must
// fall through to native scrolling, while the trackpad pinch (Ctrl+wheel) zooms.
async function verifyWheelScroll(window, measure, dispatch) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const before = await measure();
  assert.equal(await dispatch(-60, false), false, 'plain wheel must not be consumed');
  await new Promise(resolve => setTimeout(resolve, 300));
  const scrolled = await measure();
  assert.ok(
    Math.abs(scrolled / before - 1) < 0.01,
    `Plain wheel must not zoom text: before=${before}, after=${scrolled}`,
  );
  assert.equal(await dispatch(-60, true), true, 'pinch (Ctrl+wheel) is consumed by the view');
  const deadline = Date.now() + 15000;
  let changed = false;
  while (Date.now() < deadline) {
    if ((await measure()) > before * 1.05) {
      changed = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(changed, 'Pinch did not magnify text content');
  await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
}
// macOS emits HTML fullscreen before its native Space transition finishes.
// Tests must await both so the next real input is not sent during the animation.
async function transitionFullscreen(window, active, action) {
  let nativeSettled = process.platform !== 'darwin';
  const event = active ? 'enter-full-screen' : 'leave-full-screen';
  const settled = () => {
    nativeSettled = true;
  };
  window.once(event, settled);
  try {
    await action();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const html = await window.webContents.executeJavaScript(
        'Boolean(document.fullscreenElement)',
        true,
      );
      if (nativeSettled && html === active) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(
      `Fullscreen transition did not settle (active=${active}, native=${nativeSettled}).`,
    );
  } finally {
    window.removeListener(event, settled);
  }
}
module.exports = {
  verifyNavigation,
  verifyWheel,
  verifyWheelScroll,
  transitionFullscreen,
  waitForFittedView,
  measureStableLayout,
};
