const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {verifyNavigation} = require('./navigation-selftest.cjs');
const {saveBindings} = require('./project-bindings.cjs');
let directory;
function prepare(config) {
  directory = path.join(config, 'kicad-project');
  fs.mkdirSync(directory, {recursive: true});
  const fixtures = path.resolve(__dirname, '../../../packages/viewer-builtin/fixtures/kicad');
  for (const file of ['pads.kicad_pcb', 'symbols.kicad_sch', 'hierarchy.kicad_sch']) fs.copyFileSync(path.join(fixtures, file), path.join(directory, file));
  const example = path.resolve(__dirname, '../../../examples/pcb-led');
  for (const file of ['led.kicad_pcb', 'led.kicad_sch']) fs.copyFileSync(path.join(example, file), path.join(directory, file));
  fs.mkdirSync(path.join(directory, 'sub'));
  fs.copyFileSync(path.join(fixtures, 'symbols.kicad_sch'), path.join(directory, 'sub/child.kicad_sch'));
  fs.writeFileSync(path.join(directory, 'invalid.kicad_pcb'), '(kicad_pcb broken');
  fs.writeFileSync(path.join(directory, 'README.md'), 'KiCad Viewer desktop integration test');
  saveBindings(config, {activeId: 'kicad-test', projects: [{id: 'kicad-test', name: 'KiCad test', path: fs.realpathSync(directory), domain: 'pcb'}]});
}
async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script);
  async function waitFor(check) {
    const end = Date.now() + 35000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('KiCad desktop condition timed out.');
  }
  const resources = [];
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    resources.push(details.url);
    callback({cancel: /^https?:/.test(details.url)});
  });
  try {
    await waitFor(() => evaluate(`document.querySelector('.ia-domain-pill')?.innerText.includes('PCB')`));
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.ia-workspace-actions button'))`));
    await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
    const screenshots = [];
    for (const [file, tag] of [['pads.kicad_pcb', 'kc-board-viewer'], ['symbols.kicad_sch', 'kc-schematic-viewer'], ['hierarchy.kicad_sch', 'kc-schematic-viewer'], ['led.kicad_pcb', 'kc-board-viewer'], ['led.kicad_sch', 'kc-schematic-viewer']]) {
      await waitFor(() => evaluate(`Boolean(document.querySelector('.ia-file-list button[title="${file}"]'))`));
      await evaluate(`document.querySelector('.ia-file-list button[title="${file}"]').click()`);
      await waitFor(() => evaluate(`document.querySelector('.rp-kicad-toolbar strong')?.innerText === '${file}' && document.querySelector('.ia-viewer-footer')?.innerText.includes('KICAD · Ready')`));
      const frame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith('app://kicad/'));
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
      const measure = () => frame.executeJavaScript(`${native}.viewer.viewport.camera.zoom`);
      await verifyNavigation(window, measure);
      const fitted = await measure();
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
        assert.ok(anchor.zoom > fitted && anchor.distance * anchor.zoom < 1, JSON.stringify(anchor));
      }
      await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
      await waitFor(async () => Math.abs(await measure() / fitted - 1) < .01);
      if (file === 'led.kicad_sch') {
        await evaluate(`document.querySelector('.rp-kicad-toolbar button').click()`);
        await waitFor(async () => await measure() < fitted * .6);
        await evaluate(`document.querySelector('button[aria-label="Fit viewer"]').click()`);
        await waitFor(async () => Math.abs(await measure() / fitted - 1) < .01);
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
      const screenshot = path.join(directory, `${file}.png`);
      fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      screenshots.push(screenshot);
      if (file === 'hierarchy.kicad_sch') {
        fs.appendFileSync(path.join(directory, 'sub/child.kicad_sch'), '\n');
        assert.equal(await frame.executeJavaScript(`fetch('manifest.json').then(response => response.status)`), 409, 'changed companion rejected');
      }
    }
    // Opening a changed or malformed source must surface an error, never a Ready state.
    await evaluate(`document.querySelector('.ia-file-list button[title="invalid.kicad_pcb"]').click()`);
    await waitFor(() => evaluate(`document.body.innerText.includes('Malformed KiCad source')`));
    assert.ok(!await evaluate(`document.querySelector('.ia-viewer-footer')?.innerText.includes('KICAD · Ready')`));
    const settings = await evaluate(`window.viewerHost.projectBindings()`);
    assert.equal(settings.projects[0].domain, 'pcb');
    assert.ok(!resources.some(url => /^https?:/.test(url)), resources.join('\n'));
    assert.deepEqual(fs.readFileSync(path.join(directory, 'pads.kicad_pcb')), fs.readFileSync(path.resolve(__dirname, '../../../packages/viewer-builtin/fixtures/kicad/pads.kicad_pcb')));
    console.log(JSON.stringify({ok: true, screenshots, externalRequests: 0}));
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    console.error('KiCad selftest project:', directory);
    throw error;
  } finally {window.webContents.session.webRequest.onBeforeRequest(null);}
}
module.exports = {prepare, run};
