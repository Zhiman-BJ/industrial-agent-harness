const channel = 'industrial-harness-kicad-v1';
let settled = false;
let activeViewer;
let fitZoom = 1;
let mode = '2d';
let desiredMode = '2d';
let scene3d;
let sceneHost;
let geometry3d;
let building;
let buildController;
let disposed = false;
let selectedObject;
let scenePercent = 100;
let synchronizingSelection = false;
let retainedSceneState;
let reloadSequence = 0;
const boundCanvases = new WeakSet();
function send(type, data) {
  window.parent.postMessage({ channel, type, ...data }, '*');
}
function viewState() {
  if (mode === '3d') return;
  if (!activeViewer) return;
  const zoom = activeViewer.viewer.viewport.camera.zoom;
  send('view', { percent: Math.round((zoom / fitZoom) * 100) });
}
function fitDesign() {
  if (mode === '3d' && scene3d) return scene3d.fit();
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
        const radius =
          Math.max(item.effects.font.size.x, item.effects.font.size.y) *
          (String(item.shown_text ?? item.text ?? '').length + 2);
        box = sourceBox.copy();
        box.x = item.at.position.x - radius;
        box.y = item.at.position.y - radius;
        box.w = box.h = radius * 2;
      }
      if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || !box.valid) continue;
      if (!bounds) {
        bounds = box.copy();
        continue;
      }
      const right = Math.max(bounds.x + bounds.w, box.x + box.w);
      const bottom = Math.max(bounds.y + bounds.h, box.y + box.h);
      bounds.x = Math.min(bounds.x, box.x);
      bounds.y = Math.min(bounds.y, box.y);
      bounds.w = right - bounds.x;
      bounds.h = bottom - bounds.y;
    }
  }
  if (bounds) viewer.viewport.camera.bbox = bounds.grow(Math.max(bounds.w, bounds.h) * 0.08 + 1);
  else viewer.zoom_to_page();
  fitZoom = viewer.viewport.camera.zoom;
  viewer.draw();
  viewState();
}
function zoomBy(factor, point) {
  if (mode === '3d' && scene3d) return scene3d.zoomBy(factor);
  const viewer = activeViewer.viewer;
  const camera = viewer.viewport.camera;
  const before = point ? camera.screen_to_world(point) : null;
  camera.zoom = Math.max(Math.min(0.5, fitZoom / 16), Math.min(190, camera.zoom * factor));
  if (point) {
    const after = camera.screen_to_world(point);
    camera.center.set(camera.center.x + before.x - after.x, camera.center.y + before.y - after.y);
  }
  viewer.draw();
  viewState();
}
function syncSelection(item) {
  selectedObject = item || null;
  try {
    synchronizingSelection = true;
    const viewer = activeViewer.viewer;
    if (item) {
      if (item.footprintId || item.reference || item.kind?.toLowerCase() === 'footprint')
        viewer.select(item.footprintId || item.reference || item.sourceId);
      else viewer.select(null);
      if (Number.isInteger(item.net) && item.net > 0)
        requestAnimationFrame(() => {
          if (disposed || selectedObject !== item) return;
          synchronizingSelection = true;
          try {
            viewer.highlight_net(item.net);
          } finally {
            synchronizingSelection = false;
          }
        });
    } else viewer.select(null);
  } catch {
    // A non-selectable graphic still retains its real source identity in 3D.
  } finally {
    synchronizingSelection = false;
  }
  send('selection', { selection: selectedObject });
}
async function loadComponentAssembly(
  geometry,
  manifest,
  signal,
  componentMatrix,
  displayThickness,
) {
  const components = geometry.components || [];
  const resources = new Map((manifest.models || []).map(entry => [entry.sourceRef, entry]));
  const requested = new Map();
  let missingModels = 0,
    failedModels = 0,
    unmodeledFootprints = 0;
  for (const component of components) {
    if (!component.models?.length) unmodeledFootprints++;
    for (const model of component.models || []) {
      if (model.hidden) continue;
      if (component.error || model.error) {
        failedModels++;
        continue;
      }
      const entry = resources.get(model.path);
      if (entry?.status === 'ready') requested.set(entry.id, entry);
      else missingModels++;
    }
  }
  const loaded = requested.size
    ? await (
        await import('./component-loader.js')
      ).loadPcbComponentModels([...requested.values()], { signal })
    : { assets: [], failures: [] };
  if (signal.aborted) throw new DOMException('PCB component loading cancelled.', 'AbortError');
  const assets = new Map(loaded.assets.map(asset => [asset.sha256, asset]));
  const placements = [];
  for (const component of components) {
    for (const model of component.models || []) {
      if (model.hidden || component.error || model.error) continue;
      const entry = resources.get(model.path);
      if (entry?.status !== 'ready') continue;
      if (!assets.has(entry.sha256)) {
        failedModels++;
        continue;
      }
      try {
        placements.push({
          id: component.id + ':model:' + model.index,
          footprintId: component.footprintId,
          reference: component.reference,
          modelHash: entry.sha256,
          side: component.side,
          opacity: model.opacity ?? 1,
          matrix: componentMatrix(
            component,
            model,
            ((component.side === 'back' ? -1 : 1) * displayThickness) / 2,
          ),
        });
      } catch {
        failedModels++;
      }
    }
  }
  return {
    assets: [...assets.values()],
    placements,
    missingModels,
    failedModels,
    unmodeledFootprints,
  };
}
async function changeMode(next) {
  if (!['2d', '3d'].includes(next) || !activeViewer?.viewer?.board) return;
  desiredMode = next;
  if (next === '2d' && building) {
    buildController?.abort();
    mode = '2d';
    document.body.dataset.pcbMode = mode;
    send('mode', { mode });
    return;
  }
  if (next === '3d' && !scene3d) {
    if (building) return building;
    buildController = new AbortController();
    const signal = buildController.signal;
    send('scene-loading', {});
    building = (async () => {
      const [{ capturePcbGeometry, componentMatrix, pcbDisplayDimensions }, { createPcbScene }] =
        await Promise.all([import('./geometry3d.js'), import('./scene3d.js')]);
      // Recheck the source snapshot immediately before deriving a new view.
      const response = await fetch('./manifest.json');
      if (!response.ok) throw Error(await response.text());
      const manifest = await response.json();
      geometry3d = await capturePcbGeometry(activeViewer.viewer, {
        signal,
        sourceText: document.querySelector('kicanvas-source')?.textContent || '',
        sourceSha256: manifest.sources[0]?.sha256,
      });
      const components = await loadComponentAssembly(
        geometry3d,
        manifest,
        signal,
        componentMatrix,
        pcbDisplayDimensions(geometry3d).thickness,
      );
      if (disposed || signal.aborted) return;
      sceneHost = document.createElement('div');
      sceneHost.className = 'pcb3d-scene';
      document.body.appendChild(sceneHost);
      try {
        scene3d = await createPcbScene(sceneHost, geometry3d, {
          signal,
          components,
          onSelect: syncSelection,
          onView: value => {
            scenePercent = value.percent;
            if (mode === '3d') send('view', value);
          },
          onError: error => {
            buildController?.abort();
            mode = '2d';
            desiredMode = '2d';
            scene3d?.dispose();
            scene3d = null;
            sceneHost?.remove();
            sceneHost = null;
            document.querySelector('kicanvas-embed').hidden = false;
            document.body.dataset.pcb3d = 'error';
            document.body.dataset.pcbMode = mode;
            send('scene-error', { error: String(error?.message || error) });
            send('mode', { mode: '2d' });
            activeViewer.viewer.draw();
            viewState();
          },
        });
        if (disposed || signal.aborted) {
          scene3d.dispose();
          scene3d = null;
          sceneHost?.remove();
          return;
        }
        const restored = retainedSceneState;
        if (restored) {
          const layerIds = new Set(geometry3d.layers.map(layer => layer.id));
          scene3d.setLayers(restored.visibleLayers.filter(id => layerIds.has(id)));
          scene3d.setExplode(restored.explode);
          scene3d.setComponentsVisible(restored.componentsVisible);
          scene3d.fit();
          retainedSceneState = undefined;
        }
        document.body.dataset.pcb3d = 'ready';
        const renderStats = scene3d.stats;
        const renderWarnings = [];
        const missingModels = renderStats.missingModels ?? components.missingModels;
        const failedModels = renderStats.failedModels ?? components.failedModels;
        if (missingModels || components.unmodeledFootprints)
          renderWarnings.push('Some footprints have no available component model.');
        if (failedModels)
          renderWarnings.push('Some component models could not be loaded within preview support.');
        if (renderStats.omittedModels)
          renderWarnings.push('Some component models exceed the display budget and are not shown.');
        if (renderStats.omittedBoardBodies || renderStats.boardTopologyIncomplete)
          renderWarnings.push(
            'The board body is not displayed because its topology exceeds preview support.',
          );
        if (renderStats.omittedPrimitives || renderStats.sourceOmittedPrimitives)
          renderWarnings.push(
            'Some copper detail exceeds the preview budget and is not displayed.',
          );
        if (
          renderStats.unsupportedPrimitives ||
          renderStats.omittedBodyHoles ||
          renderStats.omittedDrillLayers
        )
          renderWarnings.push('Some geometry is unsupported; this is an incomplete preview.');
        send('scene-ready', {
          layers: geometry3d.layers.map(({ id, name, color }) => ({ id, name, color })),
          warnings: [
            ...geometry3d.warnings.filter(
              warning =>
                warning !==
                'Component bodies are not loaded; the preview shows source board geometry and footprints.',
            ),
            ...renderWarnings,
          ],
          stats: { ...geometry3d.stats, ...renderStats },
          complete: geometry3d.complete !== false && !renderWarnings.length,
          zMode: geometry3d.board.zMode,
          thickness: geometry3d.board.thickness,
          renderedModels: renderStats.renderedModels || 0,
          missingModels: missingModels + components.unmodeledFootprints,
          failedModels,
          omittedModels: renderStats.omittedModels || 0,
          modelReferences:
            components.placements.length + components.missingModels + components.failedModels,
          visibleLayers: scene3d.getState().visibleLayers,
          explode: scene3d.getState().explode,
          componentsVisible: scene3d.getState().componentsVisible,
          refitted: Boolean(restored),
        });
      } catch (error) {
        sceneHost?.remove();
        sceneHost = null;
        throw error;
      }
    })();
    try {
      await building;
    } catch (error) {
      mode = '2d';
      if (error?.name !== 'AbortError') desiredMode = '2d';
      document.body.dataset.pcbMode = mode;
      if (error?.name !== 'AbortError') {
        document.body.dataset.pcb3d = 'error';
        send('scene-error', { error: String(error?.message || error) });
      } else send('mode', { mode: '2d' });
      return;
    } finally {
      building = null;
    }
  }
  if (disposed || (next === '3d' && !scene3d)) return;
  mode = desiredMode;
  document.querySelector('kicanvas-embed').hidden = mode === '3d';
  if (sceneHost) sceneHost.hidden = mode !== '3d';
  document.body.dataset.pcbMode = mode;
  send('mode', { mode });
  if (mode === '3d') {
    scene3d.select(selectedObject?.id || null);
    send('view', { percent: scenePercent, stats: scene3d.stats });
  } else {
    activeViewer.viewer.draw();
    viewState();
  }
}
async function reloadModels() {
  const sequence = ++reloadSequence;
  retainedSceneState = scene3d?.getState() || retainedSceneState;
  const pending = building;
  buildController?.abort();
  if (pending) await pending.catch(() => {});
  if (disposed || sequence !== reloadSequence) return;
  scene3d?.dispose();
  scene3d = null;
  sceneHost?.remove();
  sceneHost = null;
  geometry3d = null;
  document.querySelector('kicanvas-embed').hidden = false;
  mode = '2d';
  document.body.dataset.pcbMode = mode;
  document.body.dataset.pcb3d = '';
  if (desiredMode === '3d') await changeMode('3d');
  else send('mode', { mode });
}
window.addEventListener('message', event => {
  if (
    event.source !== window.parent ||
    !['app://viewer', 'http://127.0.0.1:5173'].includes(event.origin) ||
    event.data?.channel !== channel ||
    event.data.type !== 'command' ||
    !activeViewer
  )
    return;
  switch (event.data.command) {
    case 'mode':
      void changeMode(event.data.args?.mode);
      break;
    case 'reload-models':
      void reloadModels();
      break;
    case 'layers': {
      const ids = event.data.args?.ids;
      if (Array.isArray(ids) && ids.length <= 128 && ids.every(id => typeof id === 'string'))
        scene3d?.setLayers(ids);
      break;
    }
    case 'components':
      if (typeof event.data.args?.visible === 'boolean')
        scene3d?.setComponentsVisible(event.data.args.visible);
      break;
    case 'explode': {
      const value = event.data.args?.value;
      if (Number.isFinite(value) && value >= 0 && value <= 1) scene3d?.setExplode(value);
      break;
    }
    case 'preset':
      if (['top', 'bottom', 'isometric'].includes(event.data.args?.view))
        scene3d?.setView(event.data.args.view);
      break;
    case 'zoomIn':
      zoomBy(1.25);
      break;
    case 'zoomOut':
      zoomBy(0.8);
      break;
    case 'fit':
      fitDesign();
      break;
    case 'page':
      activeViewer.viewer.zoom_to_page();
      viewState();
      break;
  }
});
window.addEventListener('pagehide', () => {
  disposed = true;
  buildController?.abort();
  scene3d?.dispose();
  sceneHost?.remove();
});
// Read-only renderer observations for diagnostics and real pointer-picking tests.
window.pcb3dInspection = Object.freeze({
  getState: () => scene3d?.getState(),
  projectObject: id => scene3d?.projectObject(id),
  objects: () =>
    geometry3d?.objects.map(
      ({ id, sourceId, reference, kind, layerId, net, netName, footprintId, label }) => ({
        id,
        sourceId,
        reference,
        kind,
        layerId,
        net,
        netName,
        footprintId,
        label,
      }),
    ),
});
function connectViewer(event) {
  activeViewer = event
    .composedPath()
    .find(node => ['kc-board-viewer', 'kc-schematic-viewer'].includes(node.localName));
  if (!activeViewer?.viewer?.viewport) throw Error('KiCad viewport is unavailable.');
  const element = activeViewer;
  if (element.viewer.board && !element.pcb3dSelectionBound) {
    element.pcb3dSelectionBound = true;
    element.viewer.addEventListener('kicanvas:select', event => {
      if (synchronizingSelection || mode !== '2d') return;
      const item = event.detail?.item;
      const id = item?.unique_id;
      selectedObject = id
        ? geometry3d?.objects.find(object => object.id === id) || {
            id,
            sourceId: id,
            reference: item.reference,
            kind: item.constructor.name,
          }
        : null;
      scene3d?.select(selectedObject?.id || null);
      send('selection', { selection: selectedObject });
    });
    const highlightNet = element.viewer.highlight_net.bind(element.viewer);
    element.viewer.highlight_net = net => {
      highlightNet(net);
      if (synchronizingSelection || mode !== '2d') return;
      selectedObject = geometry3d?.objects.find(object => object.net === net) || null;
      scene3d?.select(selectedObject?.id || null);
      send('selection', { selection: selectedObject });
    };
  }
  const canvas = element.canvas;
  if (!boundCanvases.has(canvas)) {
    boundCanvases.add(canvas);
    canvas.addEventListener(
      'wheel',
      event => {
        // Intercept upstream's default wheel-to-pan mapping; Shift retains pan.
        if (event.shiftKey || activeViewer !== element) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rect = canvas.getBoundingClientRect();
        const point = element.viewer.viewport.camera.center.copy();
        point.set(event.clientX - rect.left, event.clientY - rect.top);
        const multiplier = event.deltaMode === 1 ? 8 : event.deltaMode === 2 ? 24 : 1;
        zoomBy(Math.exp(-Math.max(-120, Math.min(120, event.deltaY * multiplier)) * 0.005), point);
      },
      { capture: true, passive: false },
    );
  }
  requestAnimationFrame(() => {
    fitDesign();
    requestAnimationFrame(() => report('ready'));
  });
}
function report(type, error) {
  if (settled) return;
  settled = true;
  window.parent.postMessage({ channel, type, error }, '*');
}
window.addEventListener('error', event =>
  report('error', event.message || 'KiCad rendering failed.'),
);
window.addEventListener('unhandledrejection', event =>
  report('error', String(event.reason?.message || event.reason)),
);

try {
  await import('./kicanvas.js');
  const response = await fetch('./manifest.json');
  if (!response.ok) throw Error(await response.text());
  const manifest = await response.json();
  const embed = document.createElement('kicanvas-embed');
  embed.setAttribute('controls', 'full');
  embed.setAttribute('controlslist', 'nooverlay nodownload nofullscreen');
  // The pinned runtime emits a composed, non-bubbling event from the actual viewer.
  embed.addEventListener('kicanvas:load', connectViewer, { capture: true });
  for (const file of manifest.sources) {
    const sourceResponse = await fetch(file.url);
    if (!sourceResponse.ok) throw Error(await sourceResponse.text());
    const source = document.createElement('kicanvas-source');
    source.setAttribute('name', file.name);
    source.textContent = await sourceResponse.text();
    embed.appendChild(source);
  }
  document.body.appendChild(embed);
} catch (error) {
  report('error', String(error.message || error));
}
