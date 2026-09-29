const channel = 'industrial-harness-kicad-v1';
let settled = false;
let activeViewer;
let fitZoom = 1;
const boundCanvases = new WeakSet();
function send(type, data) {window.parent.postMessage({channel, type, ...data}, '*');}
function viewState() {
  if (!activeViewer) return;
  const zoom = activeViewer.viewer.viewport.camera.zoom;
  send('view', {percent: Math.round(zoom / fitZoom * 100)});
}
function fitDesign() {
  const viewer = activeViewer.viewer;
  let bounds;
  // Exclude the drawing sheet and grid; fit actual rendered design objects.
  for (const layer of viewer.layers.in_order()) {
    if ([':DrawingSheet', ':Grid'].includes(layer.name)) continue;
    for (const [item, sourceBox] of layer.bboxes.entries()) {
      let box = sourceBox;
      // The pinned label painter includes (0,0) in its empty shape bounds.
      // Use a conservative text envelope around the real anchor for fitting only.
      if (layer.name === ':Label' && item.at?.position && item.effects?.font) {
        const radius = Math.max(item.effects.font.size.x, item.effects.font.size.y) * (String(item.shown_text ?? item.text ?? '').length + 2);
        box = sourceBox.copy();
        box.x = item.at.position.x - radius; box.y = item.at.position.y - radius;
        box.w = box.h = radius * 2;
      }
      if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || !box.valid) continue;
      if (!bounds) {bounds = box.copy(); continue;}
      const right = Math.max(bounds.x + bounds.w, box.x + box.w);
      const bottom = Math.max(bounds.y + bounds.h, box.y + box.h);
      bounds.x = Math.min(bounds.x, box.x); bounds.y = Math.min(bounds.y, box.y);
      bounds.w = right - bounds.x; bounds.h = bottom - bounds.y;
    }
  }
  if (bounds) viewer.viewport.camera.bbox = bounds.grow(Math.max(bounds.w, bounds.h) * 0.08 + 1);
  else viewer.zoom_to_page();
  fitZoom = viewer.viewport.camera.zoom;
  viewer.draw(); viewState();
}
function zoomBy(factor, point) {
  const viewer = activeViewer.viewer;
  const camera = viewer.viewport.camera;
  const before = point ? camera.screen_to_world(point) : null;
  camera.zoom = Math.max(Math.min(0.5, fitZoom / 16), Math.min(190, camera.zoom * factor));
  if (point) {
    const after = camera.screen_to_world(point);
    camera.center.set(camera.center.x + before.x - after.x, camera.center.y + before.y - after.y);
  }
  viewer.draw(); viewState();
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || !['app://viewer', 'http://127.0.0.1:5173'].includes(event.origin) || event.data?.channel !== channel || event.data.type !== 'command' || !activeViewer) return;
  switch (event.data.command) {
    case 'zoomIn': zoomBy(1.25); break;
    case 'zoomOut': zoomBy(0.8); break;
    case 'fit': fitDesign(); break;
    case 'page': activeViewer.viewer.zoom_to_page(); viewState(); break;
  }
});
function connectViewer(event) {
  activeViewer = event.composedPath().find(node => ['kc-board-viewer', 'kc-schematic-viewer'].includes(node.localName));
  if (!activeViewer?.viewer?.viewport) throw Error('KiCad viewport is unavailable.');
  const element = activeViewer;
  const canvas = element.canvas;
  if (!boundCanvases.has(canvas)) {
    boundCanvases.add(canvas);
    canvas.addEventListener('wheel', event => {
      // Intercept upstream's default wheel-to-pan mapping; Shift retains pan.
      if (event.shiftKey || activeViewer !== element) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const rect = canvas.getBoundingClientRect();
      const point = element.viewer.viewport.camera.center.copy();
      point.set(event.clientX - rect.left, event.clientY - rect.top);
      const multiplier = event.deltaMode === 1 ? 8 : event.deltaMode === 2 ? 24 : 1;
      zoomBy(Math.exp(-Math.max(-120, Math.min(120, event.deltaY * multiplier)) * 0.005), point);
    }, {capture: true, passive: false});
  }
  requestAnimationFrame(() => {
    fitDesign();
    requestAnimationFrame(() => report('ready'));
  });
}
function report(type, error) {
  if (settled) return;
  settled = true;
  window.parent.postMessage({channel, type, error}, '*');
}
window.addEventListener('error', event => report('error', event.message || 'KiCad rendering failed.'));
window.addEventListener('unhandledrejection', event => report('error', String(event.reason?.message || event.reason)));

try {
  await import('./kicanvas.js');
  const response = await fetch('./manifest.json');
  if (!response.ok) throw Error(await response.text());
  const manifest = await response.json();
  const embed = document.createElement('kicanvas-embed');
  embed.setAttribute('controls', 'full');
  embed.setAttribute('controlslist', 'nooverlay nodownload nofullscreen');
  // The pinned runtime emits a composed, non-bubbling event from the actual viewer.
  embed.addEventListener('kicanvas:load', connectViewer, {capture: true});
  for (const file of manifest.sources) {
    const sourceResponse = await fetch(file.url);
    if (!sourceResponse.ok) throw Error(await sourceResponse.text());
    const source = document.createElement('kicanvas-source');
    source.setAttribute('name', file.name);
    source.textContent = await sourceResponse.text();
    embed.appendChild(source);
  }
  document.body.appendChild(embed);
} catch (error) {report('error', String(error.message || error));}
