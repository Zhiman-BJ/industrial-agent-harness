import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutMeta, LayoutTileRequest } from '../api';
import { useDisplayText } from '../text';
import { useViewNavigation, wheelZoomFactor } from '../navigation';
import { presetCamera } from './layout-scene';
import { createLayoutStreamScene } from './layout-stream-scene';
import type { WorldBox, StreamResource } from './layout-stream-scene';
import {
  createLayoutTileCache,
  createLayoutTileScheduler,
  planLayoutTiles,
  layoutResolutionLimits,
  DEFAULT_LAYOUT_CACHE_LIMITS,
} from './layout-streaming';
let nextGeneration = 0;
type TileJob = LayoutTileRequest & { key: string; priority: number; root: boolean };
type Progress = {
  roots: number;
  layers: number;
  exact: number;
  detail: number;
  loaded: number;
  failed: number;
  budget: number;
  deferred: boolean;
  gpu: number;
  precision: 'exact' | 'overview' | null;
  fallback: number;
};
const initialProgress: Progress = {
  roots: 0,
  layers: 0,
  exact: 0,
  detail: 0,
  loaded: 0,
  failed: 0,
  budget: 0,
  deferred: false,
  gpu: 0,
  precision: null,
  fallback: 0,
};
import type { LayoutCamera, LayoutViewPreset } from './layout-scene';

export function Layout3DViewport({
  meta,
  box,
  visible,
  theme,
  spacing,
  active,
  onReturnTo2D,
  selectedLayer,
  onSelectLayer,
  viewPreset,
  onViewBox,
}: {
  meta: LayoutMeta;
  box: number[];
  visible: string[];
  theme: string;
  spacing: number;
  active: boolean;
  onReturnTo2D: () => void;
  selectedLayer: string | null;
  onSelectLayer: (key: string | null) => void;
  viewPreset: LayoutViewPreset;
  onViewBox: (box: number[]) => void;
}) {
  const { t } = useDisplayText();
  const { maxZoom, maxLod } = layoutResolutionLimits(
    box as WorldBox,
    meta.bbox as WorldBox,
    meta.dbu,
  );
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<ReturnType<typeof createLayoutStreamScene> | null>(null);
  const activeTiles = useRef(new Set<string>());
  const planner = useRef<(() => void) | null>(null);
  const camera = useRef(presetCamera(viewPreset));
  const previousSpacing = useRef(spacing);
  const scope = useRef(JSON.stringify(box));
  const settings = useRef({
    visible,
    theme,
    spacing,
    active,
    selectedLayer,
    onSelectLayer,
    viewPreset,
    onViewBox,
  });
  settings.current = {
    visible,
    theme,
    spacing,
    active,
    selectedLayer,
    onSelectLayer,
    viewPreset,
    onViewBox,
  };
  const fatal = useRef(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const statusRef = useRef(status);
  statusRef.current = status;
  const [error, setError] = useState('');
  const [percent, setPercent] = useState(100);
  const [progress, setProgress] = useState<Progress>(initialProgress);
  const draw = useCallback(() => {
    const state = settings.current;
    if (!state.active || !scene.current || fatal.current) return;
    const region = scene.current.viewBox(camera.current, state.spacing, state.visible);
    state.onViewBox(region);
    if (canvas.current) canvas.current.dataset.viewBox = JSON.stringify(region);
    scene.current.draw(
      camera.current,
      state.spacing,
      state.visible,
      state.theme,
      state.selectedLayer,
      activeTiles.current,
    );
  }, []);
  const fit = useCallback(() => {
    if (statusRef.current !== 'ready') return;
    camera.current = presetCamera(settings.current.viewPreset);
    setPercent(100);
    draw();
    planner.current?.();
  }, [draw]);
  const zoom = useCallback(
    (factor: number) => {
      if (statusRef.current !== 'ready') return;
      const patch = { zoom: Math.max(0.2, Math.min(maxZoom, camera.current.zoom * factor)) };
      camera.current = scene.current
        ? scene.current.reframe(camera.current, patch, settings.current.spacing)
        : { ...camera.current, ...patch };
      setPercent(Math.round(camera.current.zoom * 100));
      draw();
      planner.current?.();
    },
    [draw, maxZoom],
  );
  useViewNavigation({
    ready: active && status === 'ready',
    status,
    percent,
    zoomIn: () => zoom(1.25),
    zoomOut: () => zoom(0.8),
    fit,
  });

  useEffect(() => {
    const element = host.current!,
      surface = canvas.current!;
    if (scope.current !== JSON.stringify(box)) {
      scope.current = JSON.stringify(box);
      camera.current = presetCamera(settings.current.viewPreset);
      setPercent(100);
    }
    let renderer: ReturnType<typeof createLayoutStreamScene>;
    try {
      renderer = createLayoutStreamScene(
        surface,
        box as WorldBox,
        meta.layers.map(layer => layer.key),
      );
      scene.current = renderer;
    } catch (cause) {
      fatal.current = true;
      setStatus('error');
      setError((cause as Error).message);
      return;
    }
    let disposed = false,
      generation = 0,
      planTimer: ReturnType<typeof setTimeout> | undefined;
    let jobs: TileJob[] = [],
      cancelBarrier: Promise<void> = Promise.resolve(),
      deferred = false;
    const failures = new Map<string, string>(),
      denied = new Set<string>();
    const modes = new Map<string, string>();
    const cache = createLayoutTileCache<{ key: string }>(
      DEFAULT_LAYOUT_CACHE_LIMITS,
      (_value, key) => {
        renderer.remove(key);
        modes.delete(key);
      },
    );
    const update = () => {
      if (disposed || fatal.current) return;
      const roots = jobs.filter(job => job.root),
        details = jobs.filter(job => !job.root);
      const loaded = jobs.filter(job => cache.has(job.key)).length;
      setProgress(previous => ({
        ...previous,
        roots: roots.filter(job => cache.has(job.key)).length,
        layers: roots.length,
        exact: details.filter(
          job => modes.get(job.key) === 'exact' || modes.get(job.key) === 'empty',
        ).length,
        detail: details.length,
        fallback: details.filter(job => modes.get(job.key) === 'overview').length,
        loaded,
        failed: failures.size,
        budget: denied.size,
        deferred,
        gpu: cache.stats().gpuBytes,
      }));
      if (loaded || !settings.current.visible.length) {
        setStatus('ready');
        setError('');
      } else if (jobs.length && failures.size + denied.size >= jobs.length) {
        setStatus('error');
        setError(
          failures.values().next().value ||
            'Could not load layout overview. Return to 2D or retry.',
        );
      } else setStatus('loading');
      Object.assign(surface.dataset, {
        loadedTiles: String(loaded),
        overviewLayers: String(roots.filter(job => cache.has(job.key)).length),
        overviewLayersRequested: String(roots.length),
        requestedTiles: String(jobs.length),
        failedTiles: String(failures.size),
        budgetTiles: String(denied.size),
        gpuBytes: String(cache.stats().gpuBytes),
        cpuBytes: String(cache.stats().cpuBytes),
        generation: String(generation),
      });
      draw();
    };
    const scheduler = createLayoutTileScheduler<TileJob, StreamResource>({
      concurrency: 1,
      maxQueued: 512,
      load: async (request, { signal }) => {
        await cancelBarrier;
        if (signal.aborted) throw Error('Cancelled');
        const data = await window.viewerHost!.layoutTile(request);
        if (signal.aborted) throw Error('Cancelled');
        if (
          data.token !== meta.token ||
          data.generation !== request.generation ||
          data.layer !== request.layer ||
          JSON.stringify(data.box) !== JSON.stringify(request.box)
        )
          throw Error('Layout tile response does not match the request.');
        const resource: StreamResource = {
          key: request.key,
          layer: request.layer,
          box: (data.clipBox || data.box) as WorldBox,
          mode: data.mode,
        };
        if (data.mode === 'exact') {
          if (data.encoding !== 'f64le-xyz' || !data.positions)
            throw Error('Invalid layout tile geometry.');
          const bytes = Uint8Array.from(atob(data.positions), character => character.charCodeAt(0));
          if (
            bytes.length !== data.triangleCount * 9 * 8 ||
            data.triangleCount > data.limits.maxTriangles
          )
            throw Error('Invalid layout tile geometry.');
          const view = new DataView(bytes.buffer),
            positions = new Float64Array(bytes.length / 8);
          for (let i = 0; i < positions.length; i++) {
            positions[i] = view.getFloat64(i * 8, true);
            if (!Number.isFinite(positions[i])) throw Error('Invalid layout tile geometry.');
          }
          resource.positions = positions;
        } else if (data.mode === 'overview') {
          if (!data.png) throw Error('Invalid layout overview.');
          const bytes = Uint8Array.from(atob(data.png), character => character.charCodeAt(0));
          const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          try {
            if (signal.aborted || image.width > 512 || image.height > 512)
              throw Error('Invalid or cancelled layout overview.');
            const scratch = new OffscreenCanvas(image.width, image.height),
              context = scratch.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, image.width, image.height).data;
            const mask = new Uint8Array(image.width * image.height);
            for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4];
            Object.assign(resource, { image, mask, width: image.width, height: image.height });
          } catch (cause) {
            image.close();
            throw cause;
          }
        }
        return resource;
      },
      onReady: (request, resource) => {
        if (disposed || fatal.current || request.generation !== generation) {
          resource.image?.close();
          return;
        }
        const bytes = resource.positions ? (resource.positions.length / 3) * 32 : 0;
        const cost =
          resource.mode === 'exact'
            ? { cpuBytes: bytes, gpuBytes: bytes, triangles: resource.positions!.length / 9 }
            : {
                cpuBytes: resource.mask?.byteLength || 0,
                gpuBytes: (resource.width || 0) * (resource.height || 0) * 4,
                triangles: 0,
              };
        if (!cache.set(request.key, { key: request.key }, cost)) {
          resource.image?.close();
          denied.add(request.key);
          update();
          return;
        }
        try {
          renderer.put(resource);
          modes.set(request.key, resource.mode);
        } catch (cause) {
          cache.delete(request.key);
          resource.image?.close();
          throw cause;
        }
        update();
      },
      onError: (request, cause) => {
        if (fatal.current || request.generation !== generation) return;
        const message = String((cause as Error).message);
        if (message.includes('artifact changed') || message.includes('source changed')) {
          fatal.current = true;
          setStatus('error');
          setError('Layout artifact changed; reopen this view.');
          scheduler.clear();
          return;
        }
        failures.set(request.key, message);
        update();
      },
      dispose: resource => resource.image?.close(),
    });
    const plan = () => {
      clearTimeout(planTimer);
      planTimer = setTimeout(() => {
        if (disposed || fatal.current) return;
        if (!settings.current.active) {
          scheduler.clear();
          void window
            .viewerHost!.layoutTilesCancel({ token: meta.token, generation: ++nextGeneration })
            .catch(() => {});
          return;
        }
        const state = settings.current,
          region = renderer.viewBox(camera.current, state.spacing, state.visible);
        generation = ++nextGeneration;
        scheduler.clear();
        failures.clear();
        denied.clear();
        cancelBarrier = window.viewerHost!.layoutTilesCancel({ token: meta.token, generation });
        const pixels = meta.layers.length > 64 ? 128 : 256;
        const selectedFirst = [...state.visible].sort(
          (a, b) => Number(b === state.selectedLayer) - Number(a === state.selectedLayer),
        );
        const next: TileJob[] = selectedFirst.map((layer, index) => ({
          key: `root:${meta.token}:${layer}:${box.join(',')}:${pixels}`,
          priority: index,
          root: true,
          token: meta.token,
          generation,
          layer,
          box,
          mode: 'overview',
          pixels,
        }));
        const ratio = Math.max(
          (meta.bbox[2] - meta.bbox[0]) / (region[2] - region[0]),
          (meta.bbox[3] - meta.bbox[1]) / (region[3] - region[1]),
        );
        deferred = false;
        if (ratio >= 2) {
          const lod = Math.min(maxLod, Math.max(1, Math.ceil(Math.log2(ratio))));
          const tiles = planLayoutTiles(meta.bbox as WorldBox, region, lod, 32);
          const detailLayers =
            tiles.tiles.length * selectedFirst.length <= 128
              ? selectedFirst
              : state.selectedLayer && state.visible.includes(state.selectedLayer)
                ? [state.selectedLayer]
                : [];
          deferred = tiles.limited || detailLayers.length < state.visible.length;
          for (const layer of detailLayers)
            for (const tile of tiles.tiles) {
              const tileBox: WorldBox = [
                Math.max(box[0], tile.box[0]),
                Math.max(box[1], tile.box[1]),
                Math.min(box[2], tile.box[2]),
                Math.min(box[3], tile.box[3]),
              ];
              if (tileBox[0] >= tileBox[2] || tileBox[1] >= tileBox[3]) continue;
              next.push({
                key: `tile:${meta.token}:${layer}:${tile.id}:${tileBox.join(',')}`,
                priority: 1000 + (layer === state.selectedLayer ? 0 : 10),
                root: false,
                token: meta.token,
                generation,
                layer,
                box: tileBox,
                mode: 'auto',
                pixels: 256,
              });
            }
        }
        jobs = next;
        activeTiles.current = new Set(next.map(job => job.key));
        cache.protect(activeTiles.current);
        for (const job of next) cache.get(job.key);
        const result = scheduler.replace(next.filter(job => !cache.has(job.key)));
        result.rejected.forEach(key => denied.add(key));
        update();
      }, 120);
    };
    planner.current = plan;
    plan();
    let drag: {
      x: number;
      y: number;
      camera: LayoutCamera;
      moved: boolean;
      shift: boolean;
    } | null = null;
    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      const focus = renderer.focus(camera.current, settings.current.spacing);
      const ratio = Math.min(
        devicePixelRatio || 1,
        2,
        3000 / element.clientWidth,
        3000 / element.clientHeight,
      );
      surface.width = Math.max(1, Math.round(element.clientWidth * ratio));
      surface.height = Math.max(1, Math.round(element.clientHeight * ratio));
      camera.current = renderer.focusAt(camera.current, focus, settings.current.spacing);
      draw();
      plan();
    });
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(wheelZoomFactor(event.deltaY, event.deltaMode));
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || statusRef.current !== 'ready') return;
      drag = {
        x: event.clientX,
        y: event.clientY,
        camera: { ...camera.current },
        shift: event.shiftKey,
        moved: false,
      };
      surface.setPointerCapture(event.pointerId);
      surface.focus();
    };
    const move = (event: PointerEvent) => {
      if (!drag || statusRef.current !== 'ready') return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      if (drag.shift || settings.current.viewPreset === 'top') {
        camera.current.panX = drag.camera.panX + (dx / element.clientWidth) * 2;
        camera.current.panY = drag.camera.panY - (dy / element.clientHeight) * 2;
      } else {
        camera.current = renderer.reframe(
          drag.camera,
          {
            yaw: drag.camera.yaw + dx * 0.008,
            pitch: Math.max(0.08, Math.min(1.5, drag.camera.pitch + dy * 0.008)),
          },
          settings.current.spacing,
        );
      }
      draw();
      plan();
    };
    const up = (event: PointerEvent) => {
      const click =
        drag && !drag.moved && event.type === 'pointerup' && statusRef.current === 'ready';
      drag = null;
      if (click) {
        const rect = surface.getBoundingClientRect(),
          state = settings.current;
        const hit = renderer.pick(
          camera.current,
          state.spacing,
          state.visible,
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
          activeTiles.current,
        );
        state.onSelectLayer(hit?.layer || null);
        setProgress(previous => ({ ...previous, precision: hit?.precision || null }));
      }
      if (surface.hasPointerCapture(event.pointerId))
        surface.releasePointerCapture(event.pointerId);
    };
    const key = (event: KeyboardEvent) => {
      if (statusRef.current !== 'ready') return;
      const state = camera.current;
      switch (event.key) {
        case 'ArrowLeft':
          if (event.shiftKey || settings.current.viewPreset === 'top') state.panX -= 0.05;
          else
            camera.current = renderer.reframe(
              state,
              { yaw: state.yaw - 0.1 },
              settings.current.spacing,
            );
          break;
        case 'ArrowRight':
          if (event.shiftKey || settings.current.viewPreset === 'top') state.panX += 0.05;
          else
            camera.current = renderer.reframe(
              state,
              { yaw: state.yaw + 0.1 },
              settings.current.spacing,
            );
          break;
        case 'ArrowUp':
          if (event.shiftKey || settings.current.viewPreset === 'top') state.panY += 0.05;
          else
            camera.current = renderer.reframe(
              state,
              { pitch: Math.min(1.5, state.pitch + 0.1) },
              settings.current.spacing,
            );
          break;
        case 'ArrowDown':
          if (event.shiftKey || settings.current.viewPreset === 'top') state.panY -= 0.05;
          else
            camera.current = renderer.reframe(
              state,
              { pitch: Math.max(0.08, state.pitch - 0.1) },
              settings.current.spacing,
            );
          break;
        case '+':
        case '=':
          zoom(1.25);
          break;
        case '-':
          zoom(0.8);
          break;
        case 'Home':
          fit();
          break;
        default:
          return;
      }
      event.preventDefault();
      draw();
      plan();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      fatal.current = true;
      scheduler.clear();
      cache.clear();
      activeTiles.current.clear();
      Object.assign(surface.dataset, {
        cpuBytes: '0',
        gpuBytes: '0',
        loadedTiles: '0',
        overviewLayers: '0',
        triangles: '0',
      });
      setProgress(previous => ({ ...previous, roots: 0, exact: 0, loaded: 0, gpu: 0 }));
      void window
        .viewerHost!.layoutTilesCancel({ token: meta.token, generation: ++nextGeneration })
        .catch(() => {});
      setError('3D graphics were interrupted. Return to 2D or retry.');
      setStatus('error');
    };
    resize.observe(element);
    surface.addEventListener('wheel', wheel, { passive: false });
    surface.addEventListener('pointerdown', down);
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', up);
    surface.addEventListener('pointercancel', up);
    surface.addEventListener('lostpointercapture', up);
    surface.addEventListener('keydown', key);
    surface.addEventListener('dblclick', fit);
    surface.addEventListener('webglcontextlost', lost);
    return () => {
      disposed = true;
      clearTimeout(planTimer);
      planner.current = null;
      scheduler.dispose();
      cache.clear();
      void window
        .viewerHost!.layoutTilesCancel({ token: meta.token, generation: ++nextGeneration })
        .catch(() => {});
      resize.disconnect();
      surface.removeEventListener('wheel', wheel);
      surface.removeEventListener('pointerdown', down);
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', up);
      surface.removeEventListener('pointercancel', up);
      surface.removeEventListener('lostpointercapture', up);
      surface.removeEventListener('keydown', key);
      surface.removeEventListener('dblclick', fit);
      surface.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      scene.current = null;
    };
  }, [meta, box, draw, fit, zoom]);

  useEffect(() => {
    planner.current?.();
  }, [visible, active, selectedLayer]);
  useEffect(() => {
    const preset = presetCamera(viewPreset);
    const patch = { yaw: preset.yaw, pitch: preset.pitch, view: preset.view };
    camera.current = scene.current
      ? scene.current.reframe(camera.current, patch, settings.current.spacing)
      : { ...camera.current, ...patch };
    draw();
    planner.current?.();
  }, [viewPreset, draw]);
  useEffect(() => {
    if (scene.current && previousSpacing.current !== spacing)
      camera.current = scene.current.reframe(camera.current, {}, previousSpacing.current, spacing);
    previousSpacing.current = spacing;
    draw();
    planner.current?.();
  }, [draw, spacing, theme, active, selectedLayer]);

  return (
    <div className="rp-layout-solid">
      <div ref={host} className="rp-layout-3d rp-canvas-host" data-state={status}>
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={t(
            viewPreset === 'top'
              ? 'Top layout: click to select a layer, drag to pan, Home fits.'
              : '3D layout: click to select a layer, drag to rotate, Shift-drag to pan; Home fits.',
          )}
        />
        {status !== 'ready' ? (
          <div className="rp-layout-message" role={status === 'error' ? 'alert' : 'status'}>
            <span>{t(status === 'error' ? error : 'Loading real layer overview…')}</span>
            {status === 'error' ? (
              <button onClick={onReturnTo2D}>{t('Return to 2D')}</button>
            ) : null}
          </div>
        ) : (
          <div className="rp-layout-hint">
            {t(
              viewPreset === 'top'
                ? 'Click to select a layer · Drag to pan'
                : 'Click to select a layer · Drag to rotate · Shift-drag to pan',
            )}
          </div>
        )}
      </div>
      <div className="rp-layout-stream-status" role="status">
        <span>
          {progress.detail && progress.exact === progress.detail
            ? t('Exact detail available in loaded tiles')
            : t('Overview pixels · zoom in for exact detail')}
        </span>
        {progress.precision ? (
          <span>
            {t(
              progress.precision === 'exact'
                ? 'Picked from exact geometry'
                : 'Picked from overview pixels',
            )}
          </span>
        ) : null}
        <span>
          {progress.loaded}/{progress.layers + progress.detail} {t('tiles loaded')}
        </span>
        {progress.fallback ? (
          <span>
            {progress.fallback} {t('dense tiles shown as overview')}
          </span>
        ) : null}
        {progress.failed ? (
          <span>
            {progress.failed} {t('tiles unavailable; other layers remain visible')}
          </span>
        ) : null}
        {progress.budget || progress.deferred ? (
          <span>
            {t('Overview retained within memory budget. Select one layer for more detail.')}
          </span>
        ) : null}
        <span>{(progress.gpu / 1048576).toFixed(1)} / 64 MiB</span>
      </div>
      <footer className="rp-view-footer">
        <span>{t('Illustrative layer stack · not process dimensions')}</span>
        <span>
          {progress.roots}/{progress.layers} {t('overview layers')} · {progress.exact}/
          {progress.detail} {t('exact tiles')} · {percent}%
        </span>
      </footer>
    </div>
  );
}
