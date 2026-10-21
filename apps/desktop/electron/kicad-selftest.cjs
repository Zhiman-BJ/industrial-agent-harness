const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { app } = require('electron');
const {
  verifyNavigation,
  verifyWheel,
  transitionFullscreen,
  waitForFittedView,
} = require('./navigation-selftest.cjs');
const { saveBindings } = require('./project-bindings.cjs');
const { setLanguage } = require('./selftest-language.cjs');
let directory;
let complexFixture;
function prepare(config) {
  directory = path.join(config, 'kicad-project');
  fs.mkdirSync(directory, { recursive: true });
  const fixtures = path.resolve(__dirname, '../../../packages/viewer-builtin/fixtures/kicad');
  for (const file of ['pads.kicad_pcb', 'symbols.kicad_sch', 'hierarchy.kicad_sch'])
    fs.copyFileSync(path.join(fixtures, file), path.join(directory, file));
  const example = path.resolve(__dirname, '../../../examples/pcb-led');
  for (const file of ['led.kicad_pcb', 'led.kicad_sch'])
    fs.copyFileSync(path.join(example, file), path.join(directory, file));
  complexFixture = undefined;
  if (process.env.INDUSTRIAL_PCB3D_FIXTURE) {
    const source = fs.realpathSync(process.env.INDUSTRIAL_PCB3D_FIXTURE);
    const stat = fs.statSync(source);
    assert.ok(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'bounded real PCB fixture');
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(directory, 'complex.kicad_pcb'), bytes);
    complexFixture = {
      source,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  fs.mkdirSync(path.join(directory, 'sub'));
  fs.copyFileSync(
    path.join(fixtures, 'symbols.kicad_sch'),
    path.join(directory, 'sub/child.kicad_sch'),
  );
  fs.writeFileSync(path.join(directory, 'invalid.kicad_pcb'), '(kicad_pcb broken');
  fs.writeFileSync(path.join(directory, 'README.md'), 'KiCad Viewer desktop integration test');
  saveBindings(config, {
    activeId: 'kicad-test',
    projects: [
      { id: 'kicad-test', name: 'KiCad test', path: fs.realpathSync(directory), domain: 'pcb' },
    ],
  });
}
async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script);
  const screenshotDirectory = process.env.INDUSTRIAL_UI_SCREENSHOTS || directory;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  async function waitFor(check) {
    const end = Date.now() + 35000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('KiCad desktop condition timed out.');
  }
  const memoryStarted = Date.now();
  const memoryTypes = ['Browser', 'Tab', 'GPU'];
  const memoryReport = { unit: 'KiB', intervalMs: 100, samples: 0, byType: {} };
  let memoryScope, memoryTimer;
  function sampleMemory() {
    try {
      const processes = app
        .getAppMetrics()
        .filter(metric => memoryTypes.includes(metric.type))
        .map(metric => ({
          pid: metric.pid,
          creationTime: metric.creationTime,
          type: metric.type,
          workingSetKiB: metric.memory.workingSetSize,
          processLifetimePeakKiB: metric.memory.peakWorkingSetSize,
        }));
      const snapshot = { elapsedMs: Date.now() - memoryStarted, byType: {}, processes };
      for (const type of memoryTypes) {
        const matching = processes.filter(metric => metric.type === type);
        snapshot.byType[type] = {
          count: matching.length,
          workingSetKiB: matching.reduce((sum, metric) => sum + metric.workingSetKiB, 0),
          sumProcessLifetimePeaksKiB: matching.reduce(
            (sum, metric) => sum + metric.processLifetimePeakKiB,
            0,
          ),
        };
      }
      for (const report of [memoryReport, memoryScope].filter(Boolean)) {
        report.samples++;
        report.initial ||= snapshot;
        report.final = snapshot;
        for (const type of memoryTypes) {
          const value = snapshot.byType[type];
          const maximum = (report.byType[type] ||= {
            maxWorkingSetKiB: 0,
            maxSumProcessLifetimePeaksKiB: 0,
          });
          maximum.maxWorkingSetKiB = Math.max(maximum.maxWorkingSetKiB, value.workingSetKiB);
          maximum.maxSumProcessLifetimePeaksKiB = Math.max(
            maximum.maxSumProcessLifetimePeaksKiB,
            value.sumProcessLifetimePeaksKiB,
          );
        }
      }
      return snapshot;
    } catch (error) {
      memoryReport.error = String(error?.message || error);
      return null;
    }
  }
  const resources = [];
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    resources.push(details.url);
    callback({ cancel: /^https?:/.test(details.url) });
  });
  try {
    sampleMemory();
    memoryTimer = setInterval(sampleMemory, memoryReport.intervalMs);
    await setLanguage(window, 'en');
    await waitFor(() =>
      evaluate(`document.querySelector('.ia-domain-pill')?.innerText.includes('PCB')`),
    );
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await waitFor(() =>
      evaluate(`Boolean(document.querySelector('.ia-workspace-actions button'))`),
    );
    await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
    const screenshots = [];
    for (const [file, tag] of [
      ['pads.kicad_pcb', 'kc-board-viewer'],
      ['symbols.kicad_sch', 'kc-schematic-viewer'],
      ['hierarchy.kicad_sch', 'kc-schematic-viewer'],
      ['led.kicad_pcb', 'kc-board-viewer'],
      ['led.kicad_sch', 'kc-schematic-viewer'],
    ]) {
      await waitFor(() =>
        evaluate(`Boolean(document.querySelector('.ia-file-list button[title="${file}"]'))`),
      );
      await evaluate(`document.querySelector('.ia-file-list button[title="${file}"]').click()`);
      await waitFor(() =>
        evaluate(
          `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-kicad-toolbar strong')?.innerText === '${file}' && document.querySelector('.ia-viewer-footer')?.innerText.includes('KICAD · Ready')`,
        ),
      );
      const currentUrl = await evaluate(
        `document.querySelector('.ia-file-view:not([hidden]) iframe').src`,
      );
      const frame = window.webContents.mainFrame.frames.find(frame => frame.url === currentUrl);
      assert.ok(frame, 'KiCad iframe exists');
      const inspect = `(() => {
        function find(root, tag) {for (const node of root.querySelectorAll('*')) {if (node.localName === tag) return node; if (node.shadowRoot) {const found = find(node.shadowRoot, tag); if (found) return found;}}}
        const viewer = find(document, '${tag}');
        const canvas = find(document, 'canvas');
        return {expectedTag: '${tag}', loaded: viewer?.hasAttribute('loaded'), width: canvas?.width, height: canvas?.height, sourceCount: document.querySelectorAll('kicanvas-source').length};
      })()`;
      const display = await frame.executeJavaScript(inspect);
      assert.equal(display.loaded, true, JSON.stringify(display));
      assert.ok(display.width > 100 && display.height > 100, JSON.stringify(display));
      assert.equal(display.sourceCount, file === 'hierarchy.kicad_sch' ? 2 : 1);
      const native = `(() => {
        function find(root) {for (const node of root.querySelectorAll('*')) {if (node.localName === '${tag}') return node; if (node.shadowRoot) {const found = find(node.shadowRoot); if (found) return found;}}}
        return find(document);
      })()`;
      // KiCanvas keeps camera.zoom unchanged when its canvas resizes. A stable
      // zoom alone therefore does not mean the initial layout is ready to Fit.
      // Wait for fonts and matching, settled canvas/viewport dimensions first.
      await frame.executeJavaScript('document.fonts.ready.then(() => true)');
      async function settledCanvas() {
        let previousSize,
          stableSize = 0;
        await waitFor(async () => {
          const size = await frame.executeJavaScript(`(() => {
          const element = ${native}, camera = element.viewer.viewport.camera;
          return [element.canvas.clientWidth, element.canvas.clientHeight,
            camera.viewport_size.x, camera.viewport_size.y];
        })()`);
          const signature = JSON.stringify(size);
          stableSize =
            size[0] > 100 &&
            size[1] > 100 &&
            size[0] === size[2] &&
            size[1] === size[3] &&
            signature === previousSize
              ? stableSize + 1
              : 0;
          previousSize = signature;
          return stableSize >= 7;
        });
      }
      await settledCanvas();
      let lastView;
      const snapshot = async () => {
        const view = await frame.executeJavaScript(`(() => {
          const element = ${native}, camera = element.viewer.viewport.camera;
          return {zoom: camera.zoom, viewport: [...camera.viewport_size],
            canvas: [element.canvas.clientWidth, element.canvas.clientHeight],
            backing: [element.canvas.width, element.canvas.height],
            fonts: document.fonts.status};
        })()`);
        const signature = JSON.stringify(view);
        if (signature !== lastView) {
          console.log('KiCad navigation:', file, signature);
          lastView = signature;
        }
        return {
          scale: view.zoom,
          ready:
            view.fonts === 'loaded' &&
            view.canvas[0] > 100 &&
            view.canvas[1] > 100 &&
            view.canvas.every((size, i) => size === view.viewport[i]),
          layoutKey: [view.canvas, view.viewport, view.backing],
        };
      };
      const measure = async () => (await snapshot()).scale;
      try {
        await verifyNavigation(window, measure, { snapshot });
      } catch (error) {
        throw Error(`${file}: ${error.message}`, { cause: error });
      }
      let fitted = await measure();
      if (file === 'pads.kicad_pcb') {
        const retainedFrameId = frame.frameTreeNodeId;
        await evaluate(`document.querySelector('.ia-layout-toggle').click()`);
        await settledCanvas();
        const tabbedZoom = await measure();
        await frame.executeJavaScript(
          `window.retainedKiCadCamera = (${native}).viewer.viewport.camera`,
        );
        await evaluate(`document.getElementById('tab-chat').click()`);
        await waitFor(() => evaluate(`document.querySelector('.ia-workspace').hidden`));
        await evaluate(
          `Array.from(document.querySelectorAll('.ia-workbench-tabbar [role="tab"]')).find(tab => tab.textContent === 'pads.kicad_pcb').click()`,
        );
        await waitFor(() => evaluate(`!document.querySelector('.ia-workspace').hidden`));
        assert.equal(
          window.webContents.mainFrame.frames.find(item => item.url === currentUrl)
            ?.frameTreeNodeId,
          retainedFrameId,
          'Tabbed KiCad must retain its browsing context',
        );
        await settledCanvas();
        assert.equal(
          await frame.executeJavaScript(
            `window.retainedKiCadCamera === (${native}).viewer.viewport.camera`,
          ),
          true,
          'Tabbed KiCad must retain the same native camera object',
        );
        assert.equal(await measure(), tabbedZoom, 'Hidden KiCad tab must retain its camera scale');
        await evaluate(`document.querySelector('.ia-layout-toggle').click()`);
        await settledCanvas();
        await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
        fitted = await measure();
      }
      // Both ordinary wheel and trackpad pinch zoom around the pointer.
      for (const ctrlKey of [false, true]) {
        const anchor = await frame.executeJavaScript(`(() => {
          const element = ${native}, canvas = element.canvas, camera = element.viewer.viewport.camera;
          const rect = canvas.getBoundingClientRect(), point = camera.center.copy(); point.set(rect.width * .6, rect.height * .4);
          const before = camera.screen_to_world(point);
          canvas.dispatchEvent(new WheelEvent('wheel', {deltaY:-60, ctrlKey:${ctrlKey}, clientX:rect.left+point.x, clientY:rect.top+point.y, cancelable:true}));
          const after = camera.screen_to_world(point);
          return {distance: Math.hypot(before.x-after.x, before.y-after.y), zoom:camera.zoom};
        })()`);
        assert.ok(
          anchor.zoom > fitted && anchor.distance * anchor.zoom < 1,
          JSON.stringify(anchor),
        );
      }
      await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
      await waitFor(async () => Math.abs((await measure()) / fitted - 1) < 0.01);
      if (file === 'led.kicad_sch') {
        await evaluate(
          `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-kicad-toolbar button').click()`,
        );
        await waitFor(async () => (await measure()) < fitted * 0.6);
        await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
        await waitFor(async () => Math.abs((await measure()) / fitted - 1) < 0.01);
      }
      if (tag === 'kc-board-viewer') {
        const changed = await frame.executeJavaScript(`(() => {
          function find(root, tag) {for (const node of root.querySelectorAll('*')) {if (node.localName === tag) return node; if (node.shadowRoot) {const found = find(node.shadowRoot, tag); if (found) return found;}}}
          const activity = find(document, 'kc-ui-activity');
          activity.click();
          const layer = find(document, 'kc-board-layer-control');
          const before = layer.hasAttribute('layer-visible');
          layer.shadowRoot.querySelector('button').click();
          const after = layer.hasAttribute('layer-visible');
          layer.shadowRoot.querySelector('button').click();
          return before !== after;
        })()`);
        assert.equal(changed, true, 'layer visibility toggles');
      }
      const screenshot = path.join(screenshotDirectory, `${file}.png`);
      fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      screenshots.push(screenshot);
      if (file === 'hierarchy.kicad_sch') {
        fs.appendFileSync(path.join(directory, 'sub/child.kicad_sch'), '\n');
        assert.equal(
          await frame.executeJavaScript(`fetch('manifest.json').then(response => response.status)`),
          409,
          'changed companion rejected',
        );
      }
    }
    const pcb3dReports = [];
    for (const file of ['led.kicad_pcb', ...(complexFixture ? ['complex.kicad_pcb'] : [])]) {
      await evaluate(`document.querySelector('.ia-file-list button[title="${file}"]').click()`);
      await waitFor(() =>
        evaluate(
          `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-kicad-toolbar strong')?.innerText === '${file}' && document.querySelector('.ia-file-view:not([hidden])')?.querySelector('button[aria-label="3D PCB"]')?.disabled === false`,
        ),
      );
      const currentUrl = await evaluate(
        `document.querySelector('.ia-file-view:not([hidden]) iframe').src`,
      );
      const frame = window.webContents.mainFrame.frames.find(item => item.url === currentUrl);
      assert.ok(frame, 'PCB 3D reuses the registered KiCad iframe');
      await frame.executeJavaScript(`(() => {
        window.pcb3dHeartbeat={ticks:0,maxGapMs:0,last:performance.now()};
        window.pcb3dHeartbeatTimer=setInterval(() => {
          const now=performance.now(), heartbeat=window.pcb3dHeartbeat;
          heartbeat.maxGapMs=Math.max(heartbeat.maxGapMs,now-heartbeat.last);
          heartbeat.last=now;heartbeat.ticks++;
        },25);
      })()`);
      memoryScope = { unit: 'KiB', samples: 0, byType: {} };
      sampleMemory();
      const started = Date.now();
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('button[aria-label="3D PCB"]').click()`,
      );
      await waitFor(() =>
        frame.executeJavaScript(
          `document.body.dataset.pcb3d === 'ready' && document.body.dataset.pcbMode === '3d'`,
        ),
      );
      const canvasState = () =>
        frame.executeJavaScript(`(() => {
          const canvas = document.querySelector('.pcb3d-scene canvas');
          return canvas ? { ...canvas.dataset, width: canvas.width, height: canvas.height,
            clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight,
            webgl: Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')) } : null;
        })()`);
      const initial = await canvasState();
      const initialLoadMs = Date.now() - started;
      memoryScope.sceneReady = sampleMemory();
      const heartbeat = await frame.executeJavaScript(`(() => {
        window.pcb3dHeartbeat.maxGapMs=Math.max(window.pcb3dHeartbeat.maxGapMs,
          performance.now()-window.pcb3dHeartbeat.last);
        clearInterval(window.pcb3dHeartbeatTimer);return window.pcb3dHeartbeat;
      })()`);
      assert.ok(
        initial?.webgl && initial.width > 100 && initial.height > 100,
        JSON.stringify(initial),
      );
      assert.ok(
        Number(initial.pcb3dTriangles) > 0 && Number(initial.pcb3dDrawCalls) > 0,
        'real WebGL geometry is drawn',
      );
      assert.ok(
        heartbeat.ticks > 0 || initialLoadMs < 100,
        'the event loop remains live during scene construction',
      );
      assert.ok(
        heartbeat.maxGapMs < 3000,
        `PCB 3D construction blocked the renderer for ${heartbeat.maxGapMs} ms`,
      );
      const visibleLayers = JSON.parse(initial.pcb3dVisibleLayers);
      assert.ok(visibleLayers.length >= 2, 'source copper layers are represented');
      const measure = async () => Number((await canvasState())?.pcb3dPercent);
      await verifyNavigation(window, measure, {
        snapshot: async () => {
          const state = await canvasState();
          return {
            scale: Number(state?.pcb3dPercent),
            ready: state?.pcb3dReady === 'true' && state.clientWidth > 0 && state.clientHeight > 0,
            layoutKey: [state?.width, state?.height, state?.clientWidth, state?.clientHeight],
          };
        },
      });
      // OrbitControls scales 60 px by only ~3.1%; 120 px exercises the shared
      // >5% visible-magnification assertion without weakening that assertion.
      await verifyWheel(
        window,
        measure,
        (deltaY, ctrlKey) =>
          frame.executeJavaScript(`(() => {
          const canvas=document.querySelector('.pcb3d-scene canvas'), rect=canvas.getBoundingClientRect();
          return !canvas.dispatchEvent(new WheelEvent('wheel', {deltaY:${deltaY},ctrlKey:${ctrlKey},
            clientX:rect.left+rect.width*.6,clientY:rect.top+rect.height*.4,bubbles:true,cancelable:true}));
        })()`),
        { deltaY: -120 },
      );
      // Exercise the user control, then check the rendered layer set rather than only React state.
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-pcb3d-layers .rp-pcb3d-layer input[type="checkbox"]').click()`,
      );
      await waitFor(
        async () =>
          JSON.parse((await canvasState()).pcb3dVisibleLayers).length === visibleLayers.length - 1,
      );
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-pcb3d-layers .rp-pcb3d-layer input[type="checkbox"]').click()`,
      );
      await waitFor(
        async () =>
          JSON.parse((await canvasState()).pcb3dVisibleLayers).length === visibleLayers.length,
      );
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-pcb3d-layers .rp-pcb3d-layer button').click()`,
      );
      await waitFor(async () => JSON.parse((await canvasState()).pcb3dVisibleLayers).length === 1);
      await evaluate(
        `Array.from(document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-pcb3d-layer-heading button')).find(button=>button.textContent==='Show all').click()`,
      );
      await waitFor(
        async () =>
          JSON.parse((await canvasState()).pcb3dVisibleLayers).length === visibleLayers.length,
      );
      await evaluate(`(() => {
        const input=document.querySelector('.ia-file-view:not([hidden])')?.querySelector('input[aria-label="Layer separation"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'65');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        input.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await waitFor(
        async () => Math.abs(Number((await canvasState()).pcb3dExplode) - 0.65) < 0.001,
      );
      // The runner's narrow workspace can leave a ~40 px canvas beside the
      // layer controls. Use the real fullscreen control before pixel-accurate
      // native input, so rounding does not move a click outside a tiny pad.
      await transitionFullscreen(window, true, () =>
        window.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="Fullscreen viewer"]').click()`,
          true,
        ),
      );
      await waitFor(async () => {
        const state = await canvasState();
        return state?.clientWidth >= 400 && state.clientHeight >= 200;
      });
      const topView = () =>
        evaluate(
          `Array.from(document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-pcb3d-views button')).find(button=>button.textContent==='Top').click()`,
        );
      await topView();
      await waitFor(() =>
        frame.executeJavaScript(`(() => {
          const {camera,target}=window.pcb3dInspection.getState();
          const z=camera[2]-target[2];
          return z>0 && Math.abs((camera[0]-target[0])/z)<0.0001 &&
            Math.abs((camera[1]-target[1])/z+0.001)<0.0001;
        })()`),
      );
      await waitForFittedView(async () => {
        const state = await canvasState();
        return {
          scale: Number(state?.pcb3dPercent),
          ready: state?.pcb3dReady === 'true',
          layoutKey: [state?.width, state?.height, state?.clientWidth, state?.clientHeight],
        };
      }, topView);
      // Read-only projections locate real geometry. Native Chromium input then
      // exercises pointer capture, controls and picking together.
      window.focus();
      window.webContents.focus();
      const candidates = await frame.executeJavaScript(`(async () => {
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const inspector=window.pcb3dInspection;
        if (!inspector) throw Error('PCB read-only inspection is unavailable.');
        const objects=inspector.objects().filter(item => ['track','segment','pad'].includes(item.kind.toLowerCase()) && Number.isInteger(item.net) && item.net>0)
          .sort((a,b)=>Number(b.kind.toLowerCase()==='pad')-Number(a.kind.toLowerCase()==='pad'));
        const canvas=document.querySelector('.pcb3d-scene canvas'), rect=canvas.getBoundingClientRect();
        function find(root) {for (const node of root.querySelectorAll('*')) {if (node.localName==='kc-board-viewer') return node;if(node.shadowRoot){const found=find(node.shadowRoot);if(found)return found;}}}
        const viewer=find(document).viewer, original=viewer.highlight_net, netCalls=[];
        viewer.highlight_net=function(net){
          const previous=this.layers.overlay.graphics,result=original.call(this,net);
          netCalls.push({net,changed:this.layers.overlay.graphics!==previous});return result;
        };
        window.pcb3dPickProbe={viewer,original,netCalls};
        return objects.slice(0,250).flatMap(item=>{
          const point=inspector.projectObject(item.id);
          if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
            point.x<1 || point.y<1 || point.x>rect.width-1 || point.y>rect.height-1) return [];
          return [{target:item,point:{x:rect.left+point.x,y:rect.top+point.y,layerId:point.layerId}}];
        });
      })()`);
      const picked = [];
      const pickAttempts = [];
      try {
        for (const { target, point } of candidates) {
          if (picked.some(entry => entry.target.net === target.net)) continue;
          if (picked.length && point.layerId !== picked[0].layerId) continue;
          const origin = await evaluate(`(() => {
            const iframe=document.querySelector('.ia-file-view:not([hidden]) iframe'), rect=iframe.getBoundingClientRect();
            return {x:rect.left+iframe.clientLeft,y:rect.top+iframe.clientTop};
          })()`);
          const input = { x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y) };
          window.webContents.sendInputEvent({ type: 'mouseMove', ...input });
          window.webContents.sendInputEvent({
            type: 'mouseDown',
            button: 'left',
            clickCount: 1,
            ...input,
          });
          window.webContents.sendInputEvent({
            type: 'mouseUp',
            button: 'left',
            clickCount: 1,
            ...input,
          });
          const selection = await frame.executeJavaScript(`(async () => {
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const probe=window.pcb3dPickProbe;
            return {selected:document.querySelector('.pcb3d-scene canvas').dataset.pcb3dSelected,
              highlightedNet:probe.netCalls.at(-1)?.net,
              overlay:Boolean(probe.netCalls.at(-1)?.changed && probe.viewer.layers.overlay.graphics?.composite_operation==='overlay')};
          })()`);
          pickAttempts.push({ target, point, input, selection });
          if (selection.selected === target.id)
            picked.push({ target, layerId: point.layerId, ...selection });
          if (picked.length === 2) break;
        }
      } finally {
        await frame.executeJavaScript(`(() => {
          const probe=window.pcb3dPickProbe;if(probe)probe.viewer.highlight_net=probe.original;
          delete window.pcb3dPickProbe;
        })()`);
      }
      if (picked.length !== 2) {
        const diagnostic = {
          file,
          canvas: await canvasState(),
          view: await frame.executeJavaScript('window.pcb3dInspection.getState()'),
          candidates: candidates.length,
          picked,
          attempts: pickAttempts,
        };
        fs.writeFileSync(
          path.join(screenshotDirectory, 'pcb3d-picking-failure.json'),
          JSON.stringify(diagnostic, null, 2),
        );
        console.error('PCB pointer picking failed:', JSON.stringify(diagnostic));
      }
      assert.equal(picked.length, 2, 'pointer picking distinguishes two nets on the same layer');
      assert.notEqual(picked[0].target.net, picked[1].target.net);
      assert.equal(picked[0].layerId, picked[1].layerId);
      assert.ok(
        picked.some(entry => entry.target.kind.toLowerCase() === 'pad'),
        'real pad selection is exercised',
      );
      const sourceText = fs.readFileSync(path.join(directory, file), 'utf8');
      for (const entry of picked) {
        assert.ok(
          entry.target.sourceId && sourceText.includes(entry.target.sourceId),
          'picked source identity exists in the actual loaded board',
        );
        if (entry.target.kind.toLowerCase() === 'pad')
          assert.ok(
            entry.target.footprintId && sourceText.includes(entry.target.footprintId),
            'picked pad retains its real source footprint identity',
          );
        assert.equal(
          entry.highlightedNet,
          entry.target.net,
          '3D source selection highlights its exact net in KiCanvas',
        );
        assert.equal(entry.overlay, true, 'KiCanvas paints the selected net overlay');
      }
      const pickedCanvas = await canvasState();
      await transitionFullscreen(window, false, () =>
        window.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="Exit viewer fullscreen"]').click()`,
          true,
        ),
      );
      await waitFor(async () => {
        const state = await canvasState();
        return (
          state?.pcb3dSceneId === pickedCanvas.pcb3dSceneId &&
          state.pcb3dSelected === pickedCanvas.pcb3dSelected
        );
      });
      await waitFor(() =>
        evaluate(
          `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-pcb3d-selection')?.textContent.trim())`,
        ),
      );
      const retained = await canvasState();
      const retainedView = await frame.executeJavaScript(`window.pcb3dInspection.getState()`);
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('button[aria-label="2D PCB"]').click()`,
      );
      await waitFor(() => frame.executeJavaScript(`document.body.dataset.pcbMode==='2d'`));
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('button[aria-label="3D PCB"]').click()`,
      );
      await waitFor(() => frame.executeJavaScript(`document.body.dataset.pcbMode==='3d'`));
      const restored = await canvasState();
      for (const key of ['pcb3dSceneId', 'pcb3dSelected', 'pcb3dVisibleLayers', 'pcb3dExplode'])
        assert.equal(restored[key], retained[key], `2D/3D retains ${key}`);
      const restoredView = await frame.executeJavaScript(`window.pcb3dInspection.getState()`);
      assert.deepEqual(
        restoredView.camera,
        retainedView.camera,
        '2D/3D retains the real camera pose',
      );
      assert.deepEqual(
        restoredView.target,
        retainedView.target,
        '2D/3D retains the real orbit target',
      );
      await setLanguage(window, 'zh-CN');
      const translated = await canvasState();
      for (const key of ['pcb3dSceneId', 'pcb3dSelected', 'pcb3dVisibleLayers', 'pcb3dExplode'])
        assert.equal(translated[key], retained[key], `language change retains ${key}`);
      const translatedView = await frame.executeJavaScript(`window.pcb3dInspection.getState()`);
      assert.deepEqual(
        translatedView.camera,
        retainedView.camera,
        'language switch retains the real camera pose',
      );
      assert.equal(
        window.webContents.mainFrame.frames.find(item => item.url === currentUrl)?.frameTreeNodeId,
        frame.frameTreeNodeId,
        'language switch retains the same PCB browsing context',
      );
      const screenshot = path.join(screenshotDirectory, `${file}.3d.zh-CN.png`);
      fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      screenshots.push(screenshot);
      await setLanguage(window, 'en');
      // A lost GPU context must preserve the working 2D viewer, not crash the window.
      const contextLoss = await frame.executeJavaScript(`(() => {
        const canvas=document.querySelector('.pcb3d-scene canvas');
        const gl=canvas.getContext('webgl2') || canvas.getContext('webgl');
        const extension=gl?.getExtension('WEBGL_lose_context');
        if (!extension) return false;
        extension.loseContext(); return true;
      })()`);
      assert.equal(contextLoss, true, 'graphics context loss can be exercised');
      await waitFor(() => frame.executeJavaScript(`document.body.dataset.pcb3d==='error'`));
      await waitFor(() => frame.executeJavaScript(`document.body.dataset.pcbMode==='2d'`));
      assert.equal(
        await frame.executeJavaScript(
          `Boolean(document.querySelector('kicanvas-embed') && !document.querySelector('kicanvas-embed').hidden)`,
        ),
        true,
        'GPU failure leaves the original 2D viewer usable',
      );
      const measure2d = () =>
        frame.executeJavaScript(`(() => {
        function find(root) {for(const node of root.querySelectorAll('*')) {
          if(node.localName==='kc-board-viewer')return node;
          if(node.shadowRoot){const found=find(node.shadowRoot);if(found)return found;}}}
        return find(document).viewer.viewport.camera.zoom;
      })()`);
      const before2d = await measure2d();
      await evaluate(`document.querySelector('button[aria-label="Zoom in"]').click()`);
      await waitFor(async () => (await measure2d()) > before2d);
      sampleMemory();
      const memory = memoryScope;
      memoryScope = undefined;
      pcb3dReports.push({
        memory,
        file,
        initialLoadMs,
        heartbeat,
        loadAndInteractionMs: Date.now() - started,
        initial,
        picked,
        source: file === 'complex.kicad_pcb' ? complexFixture : undefined,
      });
    }
    // Opening a changed or malformed source must surface an error, never a Ready state.
    await evaluate(
      `document.querySelector('.ia-file-list button[title="invalid.kicad_pcb"]').click()`,
    );
    await waitFor(() => evaluate(`document.body.innerText.includes('Malformed KiCad source')`));
    assert.ok(
      !(await evaluate(
        `document.querySelector('.ia-viewer-footer')?.innerText.includes('KICAD · Ready')`,
      )),
    );
    const settings = await evaluate(`window.viewerHost.projectBindings()`);
    assert.equal(settings.projects[0].domain, 'pcb');
    assert.ok(!resources.some(url => /^https?:/.test(url)), resources.join('\n'));
    assert.deepEqual(
      fs.readFileSync(path.join(directory, 'pads.kicad_pcb')),
      fs.readFileSync(
        path.resolve(__dirname, '../../../packages/viewer-builtin/fixtures/kicad/pads.kicad_pcb'),
      ),
    );
    if (complexFixture) {
      for (const source of [complexFixture.source, path.join(directory, 'complex.kicad_pcb')])
        assert.equal(
          crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
          complexFixture.sha256,
          'real source bytes remain unchanged after viewing',
        );
    }
    sampleMemory();
    console.log(
      'KiCad selftest passed:',
      JSON.stringify({
        ok: true,
        screenshots,
        pcb3dReports,
        memory: memoryReport,
        externalRequests: 0,
      }),
    );
  } catch (error) {
    const screenshot = (await window.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(screenshotDirectory, 'failure.png'), screenshot);
    const reports = path.resolve(__dirname, '../../../dist/ci-reports');
    if (fs.existsSync(reports))
      fs.writeFileSync(path.join(reports, 'kicad-failure.png'), screenshot);
    console.error('KiCad selftest project:', directory);
    throw error;
  } finally {
    clearInterval(memoryTimer);
    sampleMemory();
    fs.writeFileSync(
      path.join(screenshotDirectory, 'kicad-memory.json'),
      JSON.stringify(memoryReport, null, 2) + '\n',
    );
    window.webContents.session.webRequest.onBeforeRequest(null);
  }
}
module.exports = { prepare, run };
