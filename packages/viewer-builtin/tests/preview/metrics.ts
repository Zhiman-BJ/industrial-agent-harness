// Opt-in acceptance diagnostics. These are UI-thread scheduling and accounted
// tile-cache measurements, not rendered FPS or process/GPU memory measurements.
export function installPreviewMetrics() {
  const panel = document.createElement('aside');
  panel.id = 'layout-preview-metrics';
  panel.style.cssText =
    'position:fixed;left:16px;bottom:32px;z-index:110;max-width:380px;padding:8px 10px;background:#071421ed;color:#dcebf5;border:1px solid #344b5b;border-radius:6px;font:11px/1.5 monospace;white-space:pre-wrap;pointer-events:none';
  document.body.append(panel);
  const started = performance.now();
  const intervals: number[] = [];
  const messages: string[] = [];
  let errors = 0,
    rejections = 0,
    longTasks = 0,
    longestTaskMs = 0;
  let first2dReadyMs: number | null = null,
    first3dReadyMs: number | null = null;
  let first3dStarted: number | null = null;
  let activeUntil = 0,
    lastFrame = 0,
    animation = 0;
  let observer: PerformanceObserver | undefined;
  const round = (n: number) => Math.round(n * 100) / 100;
  const frame = (time: number) => {
    if (lastFrame && time > lastFrame) {
      intervals.push(time - lastFrame);
      if (intervals.length > 600) intervals.shift();
    }
    lastFrame = time;
    animation = time < activeUntil ? requestAnimationFrame(frame) : 0;
    if (!animation) lastFrame = 0;
  };
  const interaction = () => {
    activeUntil = performance.now() + 2000;
    if (!animation) animation = requestAnimationFrame(frame);
  };
  const error = (event: ErrorEvent) => {
    errors++;
    if (messages.length < 20) messages.push(String(event.message).slice(0, 180));
  };
  const rejection = (event: PromiseRejectionEvent) => {
    rejections++;
    if (messages.length < 20) messages.push(String(event.reason).slice(0, 180));
  };
  const longTasksSupported =
    typeof PerformanceObserver !== 'undefined' &&
    (PerformanceObserver.supportedEntryTypes?.includes('longtask') || false);
  if (longTasksSupported) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTasks++;
        longestTaskMs = Math.max(longestTaskMs, entry.duration);
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
  const update = () => {
    const now = performance.now();
    const raster = document.querySelector<HTMLElement>('.rp-layout-raster canvas');
    const scene = document.querySelector<HTMLElement>('.rp-layout-3d');
    const canvas = scene?.querySelector<HTMLCanvasElement>('canvas');
    if (first2dReadyMs === null && raster?.dataset.renderedBox)
      first2dReadyMs = round(now - started);
    if (first3dStarted === null && scene) first3dStarted = now;
    if (first3dReadyMs === null && scene?.dataset.state === 'ready')
      first3dReadyMs = round(now - first3dStarted!);
    const sorted = [...intervals].sort((a, b) => a - b);
    const p95 = sorted.length ? round(sorted[Math.ceil(sorted.length * 0.95) - 1]) : null;
    const max = sorted.length ? round(sorted[sorted.length - 1]) : null;
    const gpu = Number(canvas?.dataset.gpuBytes || 0);
    const cpu = Number(canvas?.dataset.cpuBytes || 0);
    const report = {
      scope:
        'Ready is DOM observation, not first paint. 2D is since page probe initialization; 3D is since scene mount. UI-thread rAF intervals during 2s after input are not rendered FPS. Cache bytes are accounting, not process memory.',
      elapsedMs: round(now - started),
      first2dReadyMs,
      first3dReadyMs,
      rafSamples: sorted.length,
      rafP95Ms: p95,
      rafMaxMs: max,
      longTasksSupported,
      longTasks,
      longestTaskMs: round(longestTaskMs),
      errors,
      unhandledRejections: rejections,
      messages,
      cacheCpuBytes: cpu,
      cacheGpuBytes: gpu,
      tilesLoaded: Number(canvas?.dataset.loadedTiles || 0),
      tilesRequested: Number(canvas?.dataset.requestedTiles || 0),
      tilesFailed: Number(canvas?.dataset.failedTiles || 0),
    };
    panel.dataset.report = JSON.stringify(report);
    const zh = document.documentElement.lang.startsWith('zh');
    panel.setAttribute('aria-label', zh ? '查看器性能诊断' : 'Viewer performance diagnostics');
    panel.textContent = zh
      ? `测试诊断 · 非渲染 FPS\n2D/3D 就绪: ${first2dReadyMs ?? '—'} / ${first3dReadyMs ?? '—'} ms\nrAF 间隔 P95/最大: ${p95 ?? '—'} / ${max ?? '—'} ms (${sorted.length})\n长任务: ${longTasksSupported ? `${longTasks} / 最大 ${round(longestTaskMs)} ms` : '不支持观测'}\n错误/未处理拒绝: ${errors}/${rejections}\n缓存计费 CPU/GPU: ${(cpu / 1048576).toFixed(1)}/${(gpu / 1048576).toFixed(1)} MiB`
      : `Test diagnostics · not rendered FPS\n2D/3D ready: ${first2dReadyMs ?? '—'} / ${first3dReadyMs ?? '—'} ms\nrAF interval P95/max: ${p95 ?? '—'} / ${max ?? '—'} ms (${sorted.length})\nLong tasks: ${longTasksSupported ? `${longTasks} / max ${round(longestTaskMs)} ms` : 'unavailable'}\nErrors/unhandled rejections: ${errors}/${rejections}\nCache accounted CPU/GPU: ${(cpu / 1048576).toFixed(1)}/${(gpu / 1048576).toFixed(1)} MiB`;
  };
  const events = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const;
  for (const type of events) window.addEventListener(type, interaction, { passive: true });
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  const ready = new MutationObserver(update);
  const root = document.getElementById('root');
  if (root)
    ready.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-rendered-box', 'data-state'],
    });
  const timer = window.setInterval(update, 250);
  update();
  return () => {
    for (const type of events) window.removeEventListener(type, interaction);
    window.removeEventListener('error', error);
    window.removeEventListener('unhandledrejection', rejection);
    window.clearInterval(timer);
    cancelAnimationFrame(animation);
    observer?.disconnect();
    ready.disconnect();
    panel.remove();
  };
}

if (new URLSearchParams(location.search).get('perf') === '1') {
  const stop = installPreviewMetrics();
  const hot = (import.meta as ImportMeta & { hot?: { dispose: (fn: () => void) => void } }).hot;
  hot?.dispose(stop);
}
