const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transitionFullscreen } = require('./navigation-selftest.cjs');
const { viewportRect, captureSettled } = require('./cad-render-selftest.cjs');
const { setLanguage } = require('./selftest-language.cjs');

async function verifyResize(window, project) {
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const pause = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
  const layout = () =>
    evaluate(`(()=>{
    const chat=document.querySelector('.ia-chat'), workspace=document.querySelector('.ia-workspace'), columns=document.querySelector('.ia-columns');
    return {chat:chat.getBoundingClientRect().width,workspace:workspace.getBoundingClientRect().width,
      minChat:parseFloat(getComputedStyle(chat).minWidth),minWorkspace:parseFloat(getComputedStyle(workspace).minWidth),overflow:columns.scrollWidth-columns.clientWidth};
  })()`);
  const evidence = process.env.HARNESS_CAD_SELFTEST_OUTPUT
    ? path.join(path.dirname(process.env.HARNESS_CAD_SELFTEST_OUTPUT), 'cad-resize')
    : path.join(project, 'cad-resize');
  fs.mkdirSync(evidence, { recursive: true });
  let captureIndex = 0;
  async function capture() {
    const rect = await viewportRect(window);
    const index = ++captureIndex;
    fs.writeFileSync(
      path.join(evidence, `${index}-layout.json`),
      JSON.stringify({ rect, layout: await layout(), size: window.getContentSize() }),
    );
    const image = await captureSettled(window, {
      rect,
      output: path.join(evidence, `${index}-viewport.png`),
    });
    fs.writeFileSync(
      path.join(evidence, `${index}-window.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
    return image;
  }
  const modelRatio = image => {
    const { width, height } = image.getSize();
    const pixels = image.toBitmap();
    assert.equal(pixels.length, width * height * 4);
    let minX = width,
      minY = height,
      maxX = -1,
      maxY = -1,
      count = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4,
          low = Math.min(pixels[i], pixels[i + 2]),
          high = Math.max(pixels[i], pixels[i + 2]),
          green = pixels[i + 1];
        // OCCT blue solid pixels, excluding the gradient and green annotations.
        if (green > 130 && green > low + 25 && high > green + 5 && high > low + 40) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          count++;
        }
      }
    assert.ok(count > 500, 'The actual rendered solid must be visible.');
    assert.ok(
      minX > 1 && minY > 1 && maxX < width - 2 && maxY < height - 2,
      `The reference solid must not be cropped: ${JSON.stringify({ width, height, minX, minY, maxX, maxY, count })}`,
    );
    return (maxX - minX + 1) / (maxY - minY + 1);
  };
  const sameShape = (image, ratio, context) => {
    const actual = modelRatio(image);
    assert.ok(
      Math.abs(actual / ratio - 1) < 0.02,
      `${context} stretched the solid: ${ratio} → ${actual}`,
    );
  };
  async function drag(before, ratio, context) {
    await evaluate(`(()=>{
    const node=document.querySelector('[aria-label="Resize chat and workspace"]'),r=node.getBoundingClientRect();
    const p={pointerId:42,button:0,clientX:r.left+r.width/2,clientY:r.top+80,bubbles:true};
    node.dispatchEvent(new PointerEvent('pointerdown',p));
    node.dispatchEvent(new PointerEvent('pointermove',{...p,clientX:p.clientX-180}));
    node.dispatchEvent(new PointerEvent('pointerup',{...p,clientX:p.clientX-180}));
  })()`);
    await pause();
    const wider = await layout();
    // Hosted macOS desktops can clamp the initial window below 1440 px. The
    // divider must stop at the chat minimum even when less than 180 px is free.
    const movement = Math.min(180, before.chat - before.minChat);
    assert.ok(movement > 2, `The drag must exercise available space: ${JSON.stringify(before)}`);
    assert.ok(
      Math.abs(wider.workspace - before.workspace - movement) < 2 &&
        Math.abs(before.chat - wider.chat - movement) < 2,
      JSON.stringify({ before, wider, movement }),
    );
    assert.ok(wider.chat >= wider.minChat - 1 && wider.overflow <= 1, JSON.stringify(wider));
    sameShape(await capture(), ratio, context);
    console.log('CAD divider drag:', JSON.stringify({ context, before, wider, movement }));
    return wider;
  }
  await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
  await pause();
  const before = await layout(),
    ratio = modelRatio(await capture());
  await drag(before, ratio, 'Dragging the workspace divider');
  const key = key =>
    evaluate(
      `document.querySelector('[aria-label="Resize chat and workspace"]').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));`,
    );
  await key('Home');
  await pause();
  const expanded = await layout();
  assert.ok(Math.abs(expanded.chat - 280) < 2, JSON.stringify(expanded));
  try {
    for (const locale of ['en', 'zh-CN']) {
      await setLanguage(window, locale);
      await pause();
      const composer = await evaluate(`(() => {
        const body=document.querySelector('.ia-composer-body').getBoundingClientRect();
        const controls=['.ia-chat-approval-mode','.ia-model-pill','.ia-image-file-input + button','.ia-send'].map(selector => {
          const node=document.querySelector(selector), rect=node?.getBoundingClientRect();
          if (!node) return {selector,visible:false,contained:false};
          const style=getComputedStyle(node);
          return {selector,visible:rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.display!=='none',
            contained:rect.left>=body.left-1 && rect.right<=body.right+1 && rect.top>=body.top-1 && rect.bottom<=Math.min(body.bottom,innerHeight)+1,
            left:rect.left,right:rect.right};
        });
        const overflow=['.ia-composer','.ia-composer-body','.ia-composer-footer','.ia-chat-controls','.ia-send-actions','.ia-composer textarea'].map(selector => {
          const node=document.querySelector(selector);
          return {selector,extraWidth:node.scrollWidth-node.clientWidth};
        });
        return {body:{left:body.left,right:body.right},controls,overflow};
      })()`);
      assert.ok(
        composer.controls.every(control => control.visible && control.contained),
        `${locale}: approval, model, attachment and send controls must remain visible inside the 280 px chat composer: ${JSON.stringify(composer)}`,
      );
      assert.ok(
        composer.overflow.every(node => node.extraWidth <= 1),
        `${locale}: the narrow composer must not overflow horizontally: ${JSON.stringify(composer.overflow)}`,
      );
    }
  } finally {
    await setLanguage(window, 'en');
  }
  const originalSize = window.getContentSize();
  try {
    window.setContentSize(1000, 800);
    await pause();
    const smaller = await layout();
    assert.ok(
      smaller.chat >= smaller.minChat - 1 &&
        smaller.workspace >= smaller.minWorkspace - 1 &&
        smaller.overflow <= 1,
      JSON.stringify(smaller),
    );
    await evaluate(
      `document.querySelector('[aria-label="Resize chat and workspace"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`,
    );
    await pause();
    await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
    await pause();
    const narrow = await layout();
    assert.ok(narrow.chat - narrow.minChat < 180, 'The narrow case must exercise the drag limit.');
    const limited = await drag(narrow, modelRatio(await capture()), 'Dragging in a narrow window');
    assert.ok(Math.abs(limited.chat - limited.minChat) < 2, JSON.stringify(limited));
  } finally {
    window.setContentSize(...originalSize);
  }
  await pause();
  await key('End');
  await pause();
  const minimum = await layout();
  assert.ok(Math.abs(minimum.workspace - minimum.minWorkspace) < 2, JSON.stringify(minimum));
  await evaluate(
    `document.querySelector('[aria-label="Resize chat and workspace"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`,
  );
  await pause();
  assert.ok(
    Math.abs((await layout()).workspace - before.workspace) < 2,
    'Double-click must restore the default split.',
  );
  await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
  await pause();
  const fitted = await capture(),
    fittedRatio = modelRatio(fitted),
    restoredWidth = (await layout()).workspace;
  await evaluate(`(() => {
    const view=document.querySelector('.ia-file-view:not([hidden])');
    window.__cadCanvas=view.querySelector('.rp-cad canvas');
    window.__cadPose={yaw:view.querySelector('.rp-cad').dataset.yaw,zoom:view.querySelector('.rp-cad').dataset.zoom};
    window.__cadFile=document.querySelector('.ia-viewer-header b').textContent;
  })()`);
  async function retained(context) {
    assert.equal(
      await evaluate(`(() => {
      const view=document.querySelector('.ia-file-view:not([hidden])');
      return view.querySelector('.rp-cad canvas')===window.__cadCanvas &&
        document.querySelector('.ia-viewer-header b').textContent===window.__cadFile;
    })()`),
      true,
      `${context}: preserve the current file and OCCT WebGL canvas`,
    );
    assert.deepEqual(
      await evaluate(`(() => {
      const cad=document.querySelector('.ia-file-view:not([hidden]) .rp-cad');
      return {yaw:cad.dataset.yaw,zoom:cad.dataset.zoom};
    })()`),
      await evaluate(`window.__cadPose`),
      `${context}: preserve camera and zoom`,
    );
  }
  for (const context of ['Collapsing the sidebar', 'Restoring the sidebar']) {
    await evaluate(`document.querySelector('[data-testid="sidebar-toggle"]').click()`);
    await pause();
    await retained(context);
    sameShape(await capture(), fittedRatio, context);
  }
  await transitionFullscreen(window, true, () =>
    evaluate(`document.querySelector('button[aria-label="Fullscreen viewer"]').click()`),
  );
  await pause();
  assert.equal(
    await evaluate(`document.fullscreenElement === document.querySelector('.ia-workspace')`),
    true,
    'The existing workspace remains the fullscreen root',
  );
  await retained('Entering fullscreen');
  const fullscreen = await capture();
  sameShape(fullscreen, fittedRatio, 'Entering fullscreen');
  fs.writeFileSync(path.join(project, 'cad-resize-before.png'), fitted.toPNG());
  fs.writeFileSync(path.join(project, 'cad-resize-fullscreen.png'), fullscreen.toPNG());
  await transitionFullscreen(window, false, () =>
    evaluate(`document.querySelector('button[aria-label="Exit viewer fullscreen"]').click()`),
  );
  await pause(1000);
  await retained('Exiting fullscreen');
  sameShape(await capture(), fittedRatio, 'Exiting fullscreen');
  assert.ok(
    Math.abs((await layout()).workspace - restoredWidth) < 2,
    'Fullscreen must retain the split width.',
  );
  await transitionFullscreen(window, true, () =>
    evaluate(`document.querySelector('button[aria-label="Fullscreen viewer"]').click()`),
  );
  await transitionFullscreen(window, false, async () => {
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await pause(1000);
  await retained('Leaving fullscreen with Esc');
  sameShape(await capture(), fittedRatio, 'Leaving fullscreen with Esc');
  await evaluate(
    `window.__cadCanvas = document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas'); window.__cadPose = {yaw: document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw, zoom: document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.zoom}; document.querySelector('.ia-layout-toggle').click();`,
  );
  await pause();
  sameShape(await capture(), fittedRatio, 'Switching to tab layout');
  await evaluate(`document.getElementById('tab-chat').click()`);
  await pause();
  assert.equal(await evaluate(`document.querySelector('.ia-workspace').hidden`), true);
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-workbench-tabbar [role="tab"]')).find(tab => tab.textContent === 'model.FCStd').click()`,
  );
  await pause();
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas') === window.__cadCanvas`,
    ),
    true,
    'Chat/file tab switching must retain the OCCT WebGL canvas',
  );
  assert.deepEqual(
    await evaluate(
      `({yaw: document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.yaw, zoom: document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad').dataset.zoom})`,
    ),
    await evaluate(`window.__cadPose`),
  );
  sameShape(await capture(), fittedRatio, 'Restoring a hidden CAD tab');
  await evaluate(`document.querySelector('.ia-layout-toggle').click()`);
  await pause();
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas') === window.__cadCanvas`,
    ),
    true,
  );
  sameShape(await capture(), fittedRatio, 'Returning to split layout');
  console.log(
    'CAD pixel proportions survive sidebar changes, divider drag, fullscreen and Esc; current file, canvas, camera, 280 px chat, window shrink, keyboard limits and split reset passed',
  );
}
module.exports = { verifyResize };
