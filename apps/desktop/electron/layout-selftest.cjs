const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  verifyNavigation,
  verifyWheel,
  transitionFullscreen,
} = require('./navigation-selftest.cjs');
const { captureSettled } = require('./selftest-capture.cjs');

// Uses the selected real Project and its normal file tree/Viewer Registry path.
// Source files are never rewritten; all resulting PNGs and the report are external.
async function runFromProject(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  const output =
    process.env.INDUSTRIAL_UI_SCREENSHOTS ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'layout-selftest-'));
  fs.mkdirSync(output, { recursive: true });
  const screenshots = [];
  const view = `document.querySelector('.ia-file-view:not([hidden])')`;
  const layout = `${view}?.querySelector('.rp-layout')`;
  const canvas = `${layout}?.querySelector('.rp-layout-3d canvas')`;
  const state = `(${layout}?.querySelector('.rp-layout-3d')?.dataset.state || ${canvas}?.dataset.state)`;
  const report = { platform: process.platform, screenshots, checks: [], roiZoomSteps: 0 };
  const check = name => {
    report.checks.push(name);
    console.log('Layout selftest:', name);
  };
  async function waitFor(script, label = script, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const text = await evaluate(`(${view} || document.body).innerText.slice(-5000)`);
    throw Error(`Layout selftest timed out: ${label}\n${text}`);
  }
  async function click(selector) {
    await waitFor(
      `(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled) return false; button.click(); return true; })()`,
      `click ${selector}`,
    );
  }
  async function clickText(scope, label) {
    await waitFor(
      `(() => {const button=Array.from(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button') || []).find(item=>item.textContent.trim()===${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true;})()`,
      `click ${label}`,
    );
  }
  async function clickCanvas(xFraction = 0.5, yFraction = 0.5) {
    const point = await evaluate(
      `(() => {const r=${canvas}.getBoundingClientRect(); return {x:Math.round(r.x+r.width*${xFraction}),y:Math.round(r.y+r.height*${yFraction})};})()`,
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  }
  async function onlyReady(layerKey) {
    await waitFor(
      `${state} === 'ready' && ${canvas}.dataset.visibleLayers === ${JSON.stringify(layerKey)}`,
      `render isolated GDS layer ${layerKey}`,
      120000,
    );
    await tilesSettled();
  }
  async function mode(label) {
    await waitFor(
      `(() => {const button = Array.from(${layout}?.querySelectorAll('.rp-layout-modes button') || []).find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true; })()`,
      `switch to ${label}`,
    );
    await waitFor(
      `Array.from(${layout}?.querySelectorAll('.rp-layout-modes button') || []).some(item => item.textContent.trim() === ${JSON.stringify(label)} && item.getAttribute('aria-pressed') === 'true')`,
      `selected ${label} mode`,
    );
  }
  const raster2d = () =>
    evaluate(`(() => {
    const pane = ${layout}?.querySelector('.rp-layout-pane:not([hidden])');
    const c = pane?.querySelector('.rp-layout-raster canvas');
    if (!c?.dataset.box) return null;
    const host = c.parentElement, box = JSON.parse(c.dataset.box);
    return {box, boxText:c.dataset.box, centerX:(box[0]+box[2])/2,
      centerY:(box[1]+box[3])/2, height:box[3]-box[1], zoom:Number(c.dataset.zoom),
      backing:[c.width,c.height], viewport:[host.clientWidth,host.clientHeight],
      navigationReady:document.querySelector('button[aria-label="Zoom in"]')?.disabled === false,
      toolbarZoom:document.querySelector('output[aria-label="Viewer zoom"]')?.textContent};
  })()`);
  async function ready2d() {
    await waitFor(
      `Boolean(${layout}?.querySelector('.rp-layout-pane:not([hidden]) .rp-layout-raster canvas')) && document.querySelector('button[aria-label="Zoom in"]')?.disabled === false`,
      'ready 2D viewer',
    );
    // React's mode commit and ResizeObserver may finish on different frames.
    // Compare the camera only once the active raster and viewport have settled.
    let previous,
      stable = 0,
      current;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      current = await raster2d();
      const signature = JSON.stringify(current);
      stable =
        current?.navigationReady &&
        current.viewport.every(value => value > 0) &&
        Number.isFinite(current.zoom) &&
        current.zoom > 0 &&
        signature === previous
          ? stable + 1
          : 0;
      if (stable >= 5) return current;
      previous = signature;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`2D camera/viewport did not settle: ${JSON.stringify(current)}`);
  }
  function assertCameraRetained(before, after, label) {
    // Horizontal bounds depend on viewport aspect. A splitter/window resize
    // must preserve camera center/height/zoom while changing the visible width.
    for (const key of ['centerX', 'centerY', 'height', 'zoom']) {
      const tolerance = 1e-10 * Math.max(1, Math.abs(before[key]), Math.abs(after[key]));
      assert.ok(
        Number.isFinite(before[key]) &&
          Number.isFinite(after[key]) &&
          Math.abs(before[key] - after[key]) <= tolerance,
        `${label} retains ${key}: ${JSON.stringify({ before, after })}`,
      );
    }
    assert.equal(
      after.toolbarZoom,
      before.toolbarZoom,
      `${label} retains the shared zoom indicator`,
    );
    if (JSON.stringify(before.backing) === JSON.stringify(after.backing))
      assert.equal(
        after.boxText,
        before.boxText,
        `${label} retains its full box at unchanged viewport dimensions`,
      );
    const expectedWidth = (after.height * after.backing[0]) / after.backing[1];
    assert.ok(
      Math.abs(after.box[2] - after.box[0] - expectedWidth) <= 1e-10 * Math.max(1, expectedWidth),
      `${label} box matches the current viewport aspect: ${JSON.stringify(after)}`,
    );
  }
  const pose3d = () =>
    evaluate(
      `(() => {const c = ${canvas}; return c ? {zoom: Number(c.dataset.zoom), yaw: Number(c.dataset.yaw), pitch: Number(c.dataset.pitch), panX: Number(c.dataset.panX), panY: Number(c.dataset.panY), layers: c.dataset.visibleLayers, selectedLayer: c.dataset.selectedLayer, view: c.dataset.view, box: c.dataset.box, triangles: Number(c.dataset.triangles)} : null;})()`,
    );
  const tileProgress = () =>
    evaluate(
      `(() => {const c=${canvas}; if(!c)return null; const d=c.dataset; return {generation:Number(d.generation),loaded:Number(d.loadedTiles),requested:Number(d.requestedTiles),failed:Number(d.failedTiles),budget:Number(d.budgetTiles),overviewLayers:Number(d.overviewLayers),overviewLayersRequested:Number(d.overviewLayersRequested),visibleLayers:(d.visibleLayers||'').split(',').filter(Boolean).length,overviewTiles:Number(d.overviewTiles),triangles:Number(d.triangles),gpuBytes:Number(d.gpuBytes),cpuBytes:Number(d.cpuBytes),viewBox:d.viewBox};})()`,
    );
  async function tilesSettled() {
    let previous,
      stable = 0,
      current;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await evaluate(`${state} === 'error'`))
        throw Error(`3D tile stream failed: ${await evaluate(`${layout}.innerText`)}`);
      current = await tileProgress();
      const signature = JSON.stringify(current);
      const complete =
        current &&
        current.loaded + current.failed + current.budget === current.requested &&
        current.overviewLayers === current.visibleLayers &&
        current.overviewLayersRequested === current.visibleLayers &&
        (current.visibleLayers === 0 || current.requested > 0);
      stable = complete && signature === previous ? stable + 1 : 0;
      if (stable >= 3) {
        assert.equal(current.failed, 0, 'All requested visible tiles load successfully');
        assert.equal(current.budget, 0, 'Visible tile plan fits the scheduler/cache budget');
        return current;
      }
      previous = signature;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Tile stream did not settle: ${JSON.stringify(current)}`);
  }
  const measure3d = async () => (await pose3d())?.zoom;
  async function screenshot(name) {
    if (
      await evaluate(
        `${layout}?.querySelector('.rp-layout-pane:not([hidden]) .rp-layout-3d') && ${state} === 'ready'`,
      )
    )
      await tilesSettled();
    const file = path.join(output, `${name}.png`);
    await captureSettled(window, { output: file });
    screenshots.push(file);
    return file;
  }
  async function drag({ button = 'left', dx = 55, dy = 25, modifiers = [] } = {}) {
    const rect = await evaluate(
      `(() => {const r = ${canvas}.getBoundingClientRect(); return {x:r.x+r.width*.5, y:r.y+r.height*.5};})()`,
    );
    const x = Math.round(rect.x),
      y = Math.round(rect.y);
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x,
      y,
      button,
      clickCount: 1,
      modifiers,
    });
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: x + dx,
      y: y + dy,
      button,
      modifiers,
    });
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: x + dx,
      y: y + dy,
      button,
      clickCount: 1,
      modifiers,
    });
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  let source, sourceHash;
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    await waitFor(
      `Boolean(document.querySelector('.ia-project-list button.selected'))`,
      'selected project',
    );
    const bindings = await evaluate('window.viewerHost.projectBindings()');
    const project = bindings.projects.find(item => item.id === bindings.activeId);
    assert.ok(project, 'A real Project must be active before layout selftest.');
    const relativeFile = process.env.LAYOUT_SELFTEST_FILE || 'outputs/sobel_layout.gds';
    source = path.join(project.path, relativeFile);
    sourceHash = hash(source);
    report.sourceSha256 = sourceHash;
    if (await evaluate(`Boolean(document.querySelector('.ia-project-start'))`))
      await click('.ia-project-start');
    if (!(await evaluate(`Boolean(document.querySelector('.ia-workspace'))`)))
      await click('.ia-chat-actions button:last-child');
    if (!(await evaluate(`Boolean(document.querySelector('.ia-file-list'))`)))
      await click('.ia-file-tree-toggle');
    // Expand only actual directories on the way to the requested file.
    const segments = relativeFile.replaceAll('\\', '/').split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const directory = segments.slice(0, depth).join('/');
      const next = segments.slice(0, depth + 1).join('/');
      if (
        !(await evaluate(
          `Boolean(document.querySelector(${JSON.stringify(`.ia-file-list button[title="${next}"]`)}))`,
        ))
      )
        await click(`.ia-file-list button[title="${directory}"]`);
    }
    await click(`.ia-file-list button[title="${relativeFile}"]`);
    await ready2d();
    await waitFor(
      `document.querySelector('.ia-viewer-footer')?.innerText.includes('LAYOUT') && document.querySelector('.ia-viewer-footer')?.innerText.includes('Ready')`,
      'Registry layout ready',
      120000,
    );
    check('Project file tree → Registry → real GDS 2D render');
    await screenshot('layout-2d');
    // Whole-chip visibility comes from actual source raster masks on every layer.
    // A healthy overview does not require any exact mesh triangles.
    await mode('2.5D');
    report.wholeLayoutTiles = await tilesSettled();
    assert.ok(
      report.wholeLayoutTiles.overviewLayers > 0,
      'Whole-layout overview covers every visible layer',
    );
    check(
      `Whole-layout overview loaded for ${report.wholeLayoutTiles.overviewLayers} layers without geometry-limit failure`,
    );
    await screenshot('layout-25d-whole-overview');
    await mode('2D');
    await ready2d();
    const detailSteps = Number(process.env.LAYOUT_SELFTEST_DETAIL_ZOOM_STEPS || 18);
    assert.ok(Number.isInteger(detailSteps) && detailSteps >= 0 && detailSteps <= 24);
    for (let i = 0; i < detailSteps; i++) await click('button[aria-label="Zoom in"]');
    report.roiZoomSteps = detailSteps;
    const retainedRaster = await ready2d();
    report.rasterBefore3d = retainedRaster;
    await mode('2.5D');
    report.detailTiles = await tilesSettled();
    const rendered = await pose3d();
    assert.ok(Number.isFinite(rendered.zoom) && rendered.zoom > 0, '3D camera scale exists');
    check(
      `Local tiles settled: ${report.detailTiles.loaded} tiles after ${detailSteps} zoom steps`,
    );
    await screenshot('layout-25d');
    await mode('2D');
    report.rasterAfter3d = await ready2d();
    assertCameraRetained(retainedRaster, report.rasterAfter3d, 'Returning from 3D');
    await screenshot('layout-2d-extracted-roi');
    await mode('2.5D');
    await waitFor(`${state} === 'ready'`, '3D re-entry');
    check('2D camera retained across 2.5D switch with viewport-aware bounds');
    await verifyNavigation(window, measure3d);
    await verifyWheel(window, measure3d, (deltaY, ctrlKey) =>
      evaluate(
        `(() => {const c = ${canvas}; const r = c.getBoundingClientRect(); const event = new WheelEvent('wheel', {deltaY:${deltaY},ctrlKey:${ctrlKey},clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true}); c.dispatchEvent(event); return event.defaultPrevented;})()`,
      ),
    );
    check('Shared zoom/Fit/fullscreen and wheel/pinch navigation');
    const beforeRotate = await pose3d();
    await drag();
    const rotated = await pose3d();
    assert.ok(
      rotated.yaw !== beforeRotate.yaw || rotated.pitch !== beforeRotate.pitch,
      'Drag rotates the real 3D camera',
    );
    await drag({ modifiers: ['shift'] });
    const panned = await pose3d();
    assert.ok(
      panned.panX !== rotated.panX || panned.panY !== rotated.panY,
      'Shift drag pans the real 3D camera',
    );
    await transitionFullscreen(window, true, () => click('button[aria-label="Fullscreen viewer"]'));
    const fullscreenPose = await pose3d();
    for (const key of ['yaw', 'pitch', 'panX', 'panY', 'zoom'])
      assert.equal(fullscreenPose[key], panned[key], `Fullscreen retains ${key}`);
    await transitionFullscreen(window, false, async () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    });
    check('Rotate, pan, fullscreen camera retention and Esc exit');
    const spacing = await evaluate(
      `(() => {const input = ${layout}.querySelector('input[type="range"]'); if (!input) return null; const before=input.value; const min=Number(input.min || 0), max=Number(input.max || 100); const next=Number(before)<(min+max)/2 ? max : min; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(next)); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return {before,next};})()`,
    );
    assert.ok(
      spacing && String(spacing.before) !== String(spacing.next),
      'Layer spacing control is present',
    );
    await waitFor(
      `${layout}.querySelector('input[type="range"]').value === ${JSON.stringify(String(spacing.next))}`,
      'spacing change',
    );
    await click('.rp-layers-button');
    const beforeLayer = (await pose3d()).layers;
    await click('.rp-layer-menu input[type="checkbox"]');
    await waitFor(
      `${canvas}.dataset.visibleLayers !== ${JSON.stringify(beforeLayer)}`,
      '3D layer visibility',
    );
    await click('.rp-layer-menu input[type="checkbox"]');
    await waitFor(
      `${canvas}.dataset.visibleLayers === ${JSON.stringify(beforeLayer)}`,
      'restore layers',
    );
    await click('.rp-layers-button');
    check('Layer spacing and layer visibility');
    await screenshot('layout-25d-controls');
    // Exercise actual hit testing separately from inspector-list selection.
    // These numeric keys are facts of the committed Sobel fixture, not product semantics.
    const plateLayer = process.env.LAYOUT_SELFTEST_PLATE_LAYER || '235/0';
    const patternLayer = process.env.LAYOUT_SELFTEST_PATTERN_LAYER || '17/0';
    await mode('Top / XY');
    await click('button[aria-label="Fit viewer"]');
    await click(`.rp-layout-layer-list button[data-layer-key="${plateLayer}"]`);
    await waitFor(
      `${canvas}.dataset.selectedLayer === ${JSON.stringify(plateLayer)}`,
      'inspector selects plate layer',
    );
    await clickText('.rp-layout-selection', 'Isolate selected layer');
    await onlyReady(plateLayer);
    await clickText('.rp-layout-selection', 'Clear selection');
    await waitFor(`${canvas}.dataset.selectedLayer === ''`, 'clear inspector selection');
    await clickCanvas();
    await waitFor(
      `${canvas}.dataset.selectedLayer === ${JSON.stringify(plateLayer)}`,
      'native click picks real plate geometry',
    );
    assert.equal(
      await evaluate(`document.querySelector('.rp-layout-selection code')?.textContent`),
      plateLayer,
      'Picked GDS identity appears in inspector',
    );
    const selectedBeforeDrag = await pose3d();
    await drag({ dx: 35, dy: 20 });
    const selectedAfterDrag = await pose3d();
    assert.equal(
      selectedAfterDrag.selectedLayer,
      plateLayer,
      'A pan drag does not replace the selected layer',
    );
    assert.equal(selectedAfterDrag.yaw, 0, 'Top-view pan preserves XY orientation');
    assert.equal(selectedAfterDrag.pitch, 0, 'Top-view pan preserves XY orientation');
    assert.ok(
      selectedAfterDrag.panX !== selectedBeforeDrag.panX ||
        selectedAfterDrag.panY !== selectedBeforeDrag.panY,
      'Top-view drag pans the camera',
    );
    await click('button[aria-label="Fit viewer"]');
    await click('button[aria-label="Zoom out"]');
    await click('button[aria-label="Zoom out"]');
    await clickCanvas(0.02, 0.02);
    await waitFor(
      `${canvas}.dataset.selectedLayer === ''`,
      'clicking blank space clears selection',
    );
    await click('button[aria-label="Fit viewer"]');
    await clickCanvas();
    await waitFor(
      `${canvas}.dataset.selectedLayer === ${JSON.stringify(plateLayer)}`,
      'reselect plate before hide',
    );
    await click(`.rp-layout-layer-row input[aria-label="Show layer ${plateLayer}"]`);
    await waitFor(
      `${state} === 'ready' && ${canvas}.dataset.visibleLayers === '' && ${canvas}.dataset.selectedLayer === '' && Number(${canvas}.dataset.triangles) === 0`,
      'hiding the selected layer clears selection',
    );
    await clickCanvas();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await pose3d()).selectedLayer, '', 'Hidden geometry cannot be selected');
    check(
      'Native geometry picking, inspector identity, blank clear, drag discrimination and hidden-layer exclusion',
    );

    await clickText('.rp-layout-inspector header', 'Show all');
    await tilesSettled();
    await click(`.rp-layout-layer-list button[data-layer-key="${patternLayer}"]`);
    await waitFor(
      `${canvas}.dataset.selectedLayer === ${JSON.stringify(patternLayer)}`,
      'select patterned fixture layer',
    );
    await clickText('.rp-layout-selection', 'Isolate selected layer');
    await onlyReady(patternLayer);
    assert.ok(
      (await pose3d()).triangles > 12,
      'Patterned layer contains more than one rectangular prism',
    );
    const comparisonViewBox = JSON.parse((await tilesSettled()).viewBox);
    await clickText('.rp-layout-selection', 'Compare selected in 2D');
    const comparisonRaster = await ready2d();
    const comparisonTolerance = 1e-9 * Math.max(1, ...comparisonViewBox.map(Math.abs));
    assert.ok(
      Math.abs(comparisonRaster.centerX - (comparisonViewBox[0] + comparisonViewBox[2]) / 2) <=
        comparisonTolerance &&
        Math.abs(comparisonRaster.centerY - (comparisonViewBox[1] + comparisonViewBox[3]) / 2) <=
          comparisonTolerance,
      'Compare selected centers the current 3D XY region',
    );
    assert.ok(
      comparisonRaster.box[0] <= comparisonViewBox[0] + comparisonTolerance &&
        comparisonRaster.box[1] <= comparisonViewBox[1] + comparisonTolerance &&
        comparisonRaster.box[2] >= comparisonViewBox[2] - comparisonTolerance &&
        comparisonRaster.box[3] >= comparisonViewBox[3] - comparisonTolerance,
      '2D viewport contains the compared 3D region at its own aspect',
    );
    await waitFor(
      `(() => {const c=${layout}.querySelector('.rp-layout-raster canvas'); return c.dataset.renderedLayers === ${JSON.stringify(patternLayer)} && c.dataset.renderedBox === c.dataset.box;})()`,
      'KLayout raster has rendered the same isolated layer and current ROI',
      120000,
    );
    const rasterScreenshot = await screenshot('layout-selected-layer-2d-roi');
    await mode('2.5D');
    await onlyReady(patternLayer);
    await mode('Top / XY');
    await click('button[aria-label="Fit viewer"]');
    await waitFor(
      `${canvas}.dataset.view === 'top' && Number(${canvas}.dataset.yaw) === 0 && Number(${canvas}.dataset.pitch) === 0 && ${canvas}.dataset.box === ${JSON.stringify(comparisonRaster.boxText)}`,
      'Top / XY uses the exact isolated 2D ROI',
    );
    const topScreenshot = await screenshot('layout-selected-layer-top-xy');
    report.layerComparison = {
      layerKey: patternLayer,
      requestedViewBox: comparisonViewBox,
      raster: comparisonRaster,
      top: await pose3d(),
      rasterScreenshot,
      topScreenshot,
    };
    check(
      'Inspector isolation and Compare in 2D produce same-layer, same-ROI raster/Top screenshots',
    );
    await clickText('.rp-layout-selection', 'Clear selection');
    await clickText('.rp-layout-inspector header', 'Show all');
    await waitFor(
      `${state} === 'ready' && ${canvas}.dataset.visibleLayers.includes(',')`,
      'restore all layers after comparison',
      120000,
    );
    await mode('Angled');
    await click('button[aria-label="Fit viewer"]');
    const lost = await evaluate(
      `(() => {const c = ${canvas}; const gl=c.getContext('webgl2') || c.getContext('webgl'); const extension=gl?.getExtension('WEBGL_lose_context'); if (!extension) return false; extension.loseContext(); return true;})()`,
    );
    assert.equal(lost, true, 'A real WebGL context is available for context-loss verification');
    await waitFor(`${state} === 'error'`, 'explicit WebGL failure');
    assert.equal(
      await evaluate(`document.querySelector('button[aria-label="Zoom in"]').disabled`),
      true,
      'Failed 3D view disables navigation',
    );
    await screenshot('layout-25d-context-loss');
    await mode('2D');
    report.rasterAfterContextLoss = await ready2d();
    assertCameraRetained(
      comparisonRaster,
      report.rasterAfterContextLoss,
      '2D fallback after context failure',
    );
    check('WebGL loss has an explicit error and functional 2D fallback');
    // Leave the viewer healthy for the --keep-open manual inspection flow.
    await mode('2.5D');
    if (await evaluate(`${state} === 'error'`))
      await waitFor(
        `(() => {const button = Array.from(${layout}.querySelectorAll('button')).find(item => item.textContent.trim() === 'Reload 3D'); if (!button || button.disabled) return false; button.click(); return true;})()`,
        'Reload 3D after context loss',
      );
    await waitFor(`${state} === 'ready'`, '3D recovery after 2D fallback', 120000);
    await click('button[aria-label="Fit viewer"]');
    await screenshot('layout-25d-final');
    check('Healthy 2.5D view restored for manual inspection');
    assert.equal(hash(source), sourceHash, 'Viewing and controls must not modify the source GDS');
    check('Source SHA-256 unchanged');
    report.status = 'passed';
    fs.writeFileSync(
      path.join(output, 'layout-selftest-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log('Layout selftest passed:', JSON.stringify(report));
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = String(error.stack || error);
    if (source && sourceHash) report.sourceUnchanged = hash(source) === sourceHash;
    try {
      fs.writeFileSync(
        path.join(output, 'layout-selftest-failure.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    } catch {}
    fs.writeFileSync(
      path.join(output, 'layout-selftest-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    throw error;
  }
}

module.exports = { runFromProject };
