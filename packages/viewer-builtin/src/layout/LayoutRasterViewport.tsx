import { useDisplayText } from '../text';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LayoutMeta } from '../api';
import { useViewNavigation, wheelZoomFactor } from '../navigation';

export type RasterControls = {
  zoom: (factor: number) => void;
  fit: () => void;
  layers: (keys: string[]) => void;
  theme: (name: string) => void;
  box: () => number[];
  region: (box: number[]) => void;
};
export function LayoutRasterViewport({
  meta,
  onReady,
  onError,
  controls,
  active = true,
}: {
  meta: LayoutMeta;
  active?: boolean;
  controls: RefObject<RasterControls | undefined>;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useDisplayText();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const enabled = useRef(active);
  enabled.current = active;
  const activity = useRef<((active: boolean) => void) | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const failure = useRef(onError);
  failure.current = onError;
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [span, setSpan] = useState('');
  const [percent, setPercent] = useState(100);
  useViewNavigation({
    ready: active && loaded && !error,
    status: error ? 'error' : loaded ? 'ready' : 'loading',
    percent,
    zoomIn: () => controls.current?.zoom(0.8),
    zoomOut: () => controls.current?.zoom(1.25),
    fit: () => controls.current?.fit(),
  });
  useEffect(() => {
    const element = host.current!,
      surface = canvas.current!,
      ctx = surface.getContext('2d')!;
    let disposed = false,
      busy = false,
      dirty = false,
      revision = 0,
      styleRevision = 0,
      lastInput = 0;
    let timer: ReturnType<typeof setTimeout> | undefined,
      settle: ReturnType<typeof setTimeout> | undefined;
    let frame: { image: ImageBitmap; box: number[] } | null = null;
    let themeName = '02_blueprint';
    let w = 800,
      h = 600,
      fitHeight = 1,
      fitted = false,
      cam = { x: 0, y: 0, h: 1 },
      keys = meta.layers.map(l => l.key);
    let wasActive = enabled.current;
    let highlightRegion: number[] | null = null;
    let pendingRegion: number[] | null = null;
    let drag: { x: number; y: number; cam: typeof cam } | null = null;
    function box() {
      const width = (cam.h * w) / h;
      return [cam.x - width / 2, cam.y - cam.h / 2, cam.x + width / 2, cam.y + cam.h / 2];
    }
    function draw() {
      if (!enabled.current) return;
      surface.dataset.box = JSON.stringify(box());
      surface.dataset.zoom = String(fitHeight / cam.h);
      ctx.fillStyle = (
        {
          '01_neon': '#05090f',
          '02_blueprint': '#071421',
          '03_ember': '#120d13',
          '04_routing': '#080c12',
        } as Record<string, string>
      )[themeName];
      ctx.fillRect(0, 0, surface.width, surface.height);
      if (frame) {
        const b = box(),
          scale = surface.height / cam.h;
        ctx.drawImage(
          frame.image,
          (frame.box[0] - b[0]) * scale,
          (b[3] - frame.box[3]) * scale,
          (frame.box[2] - frame.box[0]) * scale,
          (frame.box[3] - frame.box[1]) * scale,
        );
      }
      if (highlightRegion) {
        const b = box(),
          scale = surface.height / cam.h;
        ctx.strokeStyle = '#ffe082';
        ctx.lineWidth = 2;
        ctx.strokeRect(
          (highlightRegion[0] - b[0]) * scale,
          (b[3] - highlightRegion[3]) * scale,
          (highlightRegion[2] - highlightRegion[0]) * scale,
          (highlightRegion[3] - highlightRegion[1]) * scale,
        );
      }
      setSpan(`${((cam.h * w) / h).toFixed(1)} µm · ${(fitHeight / cam.h).toFixed(2)}×`);
      setPercent(Math.round((fitHeight / cam.h) * 100));
    }
    function schedule() {
      if (disposed || !enabled.current) return;
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void pump();
        }, 12);
    }
    function change(style = false) {
      revision++;
      dirty = true;
      lastInput = performance.now();
      if (style) {
        styleRevision++;
        frame?.image.close();
        frame = null;
      }
      if (!enabled.current) return;
      draw();
      schedule();
      clearTimeout(settle);
      settle = setTimeout(() => {
        dirty = true;
        schedule();
      }, 170);
    }
    async function pump() {
      if (disposed || !enabled.current || busy || !dirty) return;
      busy = true;
      dirty = false;
      const version = revision,
        style = styleRevision;
      try {
        const result = await window.viewerHost!.render({
          token: meta.token,
          box: box(),
          width: surface.width,
          height: surface.height,
          visible: keys,
          theme: themeName,
          quality: performance.now() - lastInput < 150 ? 'fast' : 'fine',
        });
        if (disposed || !enabled.current || style !== styleRevision) return;
        const bytes = Uint8Array.from(atob(result.png), c => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        if (disposed || !enabled.current || style !== styleRevision) {
          image.close();
          return;
        }
        frame?.image.close();
        frame = { image, box: result.box };
        surface.dataset.renderedLayers = keys.join(',');
        surface.dataset.renderedBox = JSON.stringify(result.box);
        draw();
        setLoaded(true);
        ready.current();
        if (version !== revision) dirty = true;
      } catch (e) {
        if (!disposed && enabled.current && style === styleRevision) {
          setError(String((e as Error).message));
          failure.current((e as Error).message);
          dirty = false;
        }
      } finally {
        busy = false;
        if (dirty && !disposed) schedule();
      }
    }
    function fit() {
      fitted = true;
      const [l, b, r, t] = meta.bbox;
      fitHeight = Math.max(t - b, ((r - l) * h) / w) * 1.1;
      cam = { x: (l + r) / 2, y: (b + t) / 2, h: fitHeight };
      change();
    }
    function zoom(factor: number, x = w / 2, y = h / 2) {
      const old = cam.h,
        next = Math.max(0.01, Math.min(fitHeight * 100, old * factor));
      cam.x += (((x / w - 0.5) * w) / h) * (old - next);
      cam.y += (0.5 - y / h) * (old - next);
      cam.h = next;
      change();
    }
    function fitRegion(next: number[]) {
      cam = {
        x: (next[0] + next[2]) / 2,
        y: (next[1] + next[3]) / 2,
        h: Math.max(next[3] - next[1], ((next[2] - next[0]) * h) / w),
      };
      change();
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const r = element.getBoundingClientRect();
      zoom(
        1 / wheelZoomFactor(event.deltaY, event.deltaMode),
        ((event.clientX - r.left) * w) / r.width,
        ((event.clientY - r.top) * h) / r.height,
      );
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, cam: { ...cam } };
      element.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      const size = element.getBoundingClientRect();
      cam.x = drag.cam.x - ((event.clientX - drag.x) * drag.cam.h) / size.height;
      cam.y = drag.cam.y + ((event.clientY - drag.y) * drag.cam.h) / size.height;
      change();
    };
    const up = () => {
      drag = null;
    };
    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      const ratio = Math.min(
        devicePixelRatio || 1,
        1.5,
        3000 / Math.max(64, element.clientWidth),
        3000 / Math.max(64, element.clientHeight),
      );
      surface.width = Math.max(64, Math.round(element.clientWidth * ratio));
      surface.height = Math.max(64, Math.round(element.clientHeight * ratio));
      w = surface.width;
      h = surface.height;
      if (pendingRegion) {
        const next = pendingRegion;
        pendingRegion = null;
        fitRegion(next);
      } else if (!fitted) fit();
      else change();
    });
    activity.current = next => {
      if (wasActive === next) return;
      wasActive = next;
      revision++;
      styleRevision++;
      dirty = true;
      clearTimeout(timer);
      clearTimeout(settle);
      timer = undefined;
      settle = undefined;
      if (next) change();
    };
    resize.observe(element);
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('lostpointercapture', up);
    element.addEventListener('dblclick', fit);
    controls.current = {
      box,
      region: next => {
        highlightRegion = [...next];
        pendingRegion = element.clientWidth && element.clientHeight ? null : [...next];
        fitRegion(next);
      },
      zoom: f => zoom(f),
      fit,
      layers: next => {
        keys = next;
        change(true);
      },
      theme: name => {
        themeName = name;
        change(true);
      },
    };
    return () => {
      disposed = true;
      activity.current = null;
      clearTimeout(timer);
      clearTimeout(settle);
      resize.disconnect();
      frame?.image.close();
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('lostpointercapture', up);
      element.removeEventListener('dblclick', fit);
      controls.current = undefined;
    };
  }, [meta, controls]);
  useEffect(() => {
    activity.current?.(active);
  }, [active]);
  return (
    <div className="rp-layout-raster">
      <div ref={host} className="rp-canvas-host">
        <canvas ref={canvas} aria-label={t('KLayout rendering of {0}', { 0: meta.cell })} />
        {error ? (
          <div className="rp-view-error" role="alert">
            {t(error)}
          </div>
        ) : null}
      </div>
      <footer className="rp-view-footer">
        <span>
          KLayout {meta.klayout} {t('· generic layer colors')}
        </span>
        <span>{span}</span>
      </footer>
    </div>
  );
}
