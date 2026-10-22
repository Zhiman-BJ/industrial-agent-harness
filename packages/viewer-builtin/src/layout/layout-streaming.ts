export interface LayoutCacheCost {
  cpuBytes: number;
  gpuBytes: number;
  triangles: number;
}

export const DEFAULT_LAYOUT_CACHE_LIMITS: LayoutCacheCost = {
  cpuBytes: 128 * 1024 * 1024,
  gpuBytes: 64 * 1024 * 1024,
  triangles: 250_000,
};

const resources = ['cpuBytes', 'gpuBytes', 'triangles'] as const;
const zeroCost = (): LayoutCacheCost => ({ cpuBytes: 0, gpuBytes: 0, triangles: 0 });
function checkCost(cost: LayoutCacheCost) {
  if (resources.some(resource => !Number.isSafeInteger(cost[resource]) || cost[resource] < 0))
    throw new RangeError('Layout cache costs must be nonnegative safe integers.');
}

/** Owns only accepted values. Rejected values must be released by the caller. */
export function createLayoutTileCache<T>(
  limits: LayoutCacheCost,
  dispose: (value: T, key: string) => void,
) {
  checkCost(limits);
  const budget = { ...limits };
  const entries = new Map<string, { value: T; cost: LayoutCacheCost }>();
  const used = zeroCost();
  let protectedKeys = new Set<string>();
  let hits = 0,
    misses = 0,
    evictions = 0,
    rejections = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    for (const resource of resources) used[resource] -= entry.cost[resource];
    dispose(entry.value, key);
    return true;
  }
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) {
        misses++;
        return undefined;
      }
      hits++;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    has(key: string) {
      return entries.has(key);
    },
    set(key: string, value: T, cost: LayoutCacheCost): boolean {
      checkCost(cost);
      const previous = entries.get(key);
      const next = zeroCost();
      for (const resource of resources)
        next[resource] = used[resource] - (previous?.cost[resource] || 0) + cost[resource];
      const victims: string[] = [];
      const fits = () => resources.every(resource => next[resource] <= budget[resource]);
      if (resources.some(resource => cost[resource] > budget[resource])) {
        rejections++;
        return false;
      }
      for (const [candidate, entry] of entries) {
        if (fits()) break;
        if (candidate === key || protectedKeys.has(candidate)) continue;
        victims.push(candidate);
        for (const resource of resources) next[resource] -= entry.cost[resource];
      }
      // A pinned visible working set is still bounded. Refusal leaves existing coverage intact.
      if (!fits()) {
        rejections++;
        return false;
      }
      for (const victim of victims) {
        remove(victim);
        evictions++;
      }
      if (previous) remove(key);
      entries.set(key, { value, cost: { ...cost } });
      for (const resource of resources) used[resource] += cost[resource];
      return true;
    },
    protect(keys: Iterable<string>) {
      protectedKeys = new Set(keys);
    },
    delete: remove,
    clear() {
      for (const key of [...entries.keys()]) remove(key);
      protectedKeys.clear();
    },
    stats() {
      return { ...used, entries: entries.size, hits, misses, evictions, rejections };
    },
  };
}

export interface LayoutScheduledRequest {
  key: string;
  priority?: number;
}
export interface LayoutLoadContext {
  signal: AbortSignal;
  generation: number;
}

/** Abort signals must be wired to host cancellation; unresolved work keeps its concurrency slot. */
export function createLayoutTileScheduler<R extends LayoutScheduledRequest, T>(options: {
  concurrency?: number;
  maxQueued?: number;
  load: (request: R, context: LayoutLoadContext) => Promise<T>;
  onReady: (request: R, value: T) => void | Promise<void>;
  onError?: (request: R, error: unknown) => void;
  dispose?: (value: T) => void;
}) {
  const concurrency = options.concurrency ?? 1,
    maxQueued = options.maxQueued ?? 128;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isSafeInteger(maxQueued) ||
    maxQueued < 0
  )
    throw new RangeError(
      'Layout scheduling requires positive concurrency and a nonnegative queue limit.',
    );
  type Job = { request: R; controller: AbortController; generation: number };
  const active = new Set<Job>();
  const live = new Map<string, Job>();
  let desired = new Map<string, R>(),
    queued = new Map<string, R>();
  let generation = 0,
    cancelled = 0,
    completed = 0,
    rejected = 0,
    disposed = false;
  function abort(job: Job) {
    if (!job.controller.signal.aborted) {
      cancelled++;
      job.controller.abort();
    }
    if (live.get(job.request.key) === job) live.delete(job.request.key);
  }
  function pump() {
    while (!disposed && active.size < concurrency && queued.size) {
      const [key, request] = queued.entries().next().value!;
      queued.delete(key);
      if (!desired.has(key)) continue;
      const job = { request, controller: new AbortController(), generation };
      active.add(job);
      live.set(key, job);
      Promise.resolve()
        .then(() => {
          if (job.controller.signal.aborted) throw new Error('Layout tile request cancelled.');
          return options.load(request, {
            signal: job.controller.signal,
            generation: job.generation,
          });
        })
        .then(async value => {
          if (
            disposed ||
            job.controller.signal.aborted ||
            !desired.has(key) ||
            live.get(key) !== job
          ) {
            options.dispose?.(value);
            return;
          }
          try {
            await options.onReady(request, value);
            completed++;
          } catch (error) {
            options.dispose?.(value);
            throw error;
          }
        })
        .catch(error => {
          if (
            !disposed &&
            !job.controller.signal.aborted &&
            desired.has(key) &&
            live.get(key) === job
          )
            options.onError?.(request, error);
        })
        .finally(() => {
          active.delete(job);
          if (live.get(key) === job) live.delete(key);
          pump();
        });
    }
  }
  function clear() {
    generation++;
    desired.clear();
    queued.clear();
    for (const job of active) abort(job);
  }
  return {
    replace(requests: readonly R[]) {
      if (disposed) throw new Error('Layout tile scheduler was disposed.');
      generation++;
      const unique = new Map<string, R>();
      for (const request of [...requests].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)))
        if (!unique.has(request.key)) unique.set(request.key, request);
      for (const job of active) if (!unique.has(job.request.key)) abort(job);
      const next = new Map<string, R>(),
        waiting = new Map<string, R>(),
        rejectedKeys: string[] = [];
      const capacity = maxQueued + Math.max(0, concurrency - active.size);
      for (const [key, request] of unique) {
        if (live.has(key)) {
          next.set(key, request);
          continue;
        }
        if (waiting.size >= capacity) {
          rejectedKeys.push(key);
          continue;
        }
        next.set(key, request);
        waiting.set(key, request);
      }
      desired = next;
      queued = waiting;
      rejected += rejectedKeys.length;
      pump();
      return { generation, rejected: rejectedKeys };
    },
    clear,
    dispose() {
      disposed = true;
      clear();
    },
    stats() {
      return {
        generation,
        active: active.size,
        queued: queued.size,
        cancelled,
        completed,
        rejected,
      };
    },
  };
}

export type LayoutBox = [number, number, number, number];
/** Bound detail by source DBU and double-precision coordinate resolution. */
export function layoutResolutionLimits(world: LayoutBox, bounds: LayoutBox, dbu?: number) {
  for (const box of [world, bounds])
    if (
      box.length !== 4 ||
      !box.every(Number.isFinite) ||
      !Number.isFinite(box[2] - box[0]) ||
      !Number.isFinite(box[3] - box[1]) ||
      box[2] <= box[0] ||
      box[3] <= box[1]
    )
      throw new RangeError('Invalid layout resolution bounds.');
  if (dbu === undefined) return { maxZoom: 65536, maxLod: 20 };
  if (!Number.isFinite(dbu) || dbu <= 0) throw new RangeError('Invalid layout database unit.');
  const worldSpan = Math.max(world[2] - world[0], world[3] - world[1]);
  const minimumSpan = Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  let maxLod = Math.min(30, Math.max(0, Math.floor(Math.log2(minimumSpan / dbu))));
  while (maxLod > 0) {
    const width = (bounds[2] - bounds[0]) / 2 ** maxLod;
    const height = (bounds[3] - bounds[1]) / 2 ** maxLod;
    if (
      width >= dbu &&
      height >= dbu &&
      bounds[0] + width > bounds[0] &&
      bounds[2] - width < bounds[2] &&
      bounds[1] + height > bounds[1] &&
      bounds[3] - height < bounds[3]
    )
      break;
    maxLod--;
  }
  return { maxZoom: Math.min(2 ** 30, Math.max(1, worldSpan / dbu)), maxLod };
}
export interface LayoutGridTile {
  id: string;
  lod: number;
  x: number;
  y: number;
  box: LayoutBox;
}

/** A stable quadtree anchored to the complete source bounds, never the moving viewport. */
export function planLayoutTiles(bounds: LayoutBox, view: LayoutBox, lod: number, maxTiles = 64) {
  const valid = (box: LayoutBox) =>
    box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1];
  if (
    !valid(bounds) ||
    !valid(view) ||
    !Number.isSafeInteger(lod) ||
    lod < 0 ||
    lod > 30 ||
    !Number.isSafeInteger(maxTiles) ||
    maxTiles < 1
  )
    throw new RangeError('Invalid layout tile bounds or limits.');
  const left = Math.max(bounds[0], view[0]),
    bottom = Math.max(bounds[1], view[1]);
  const right = Math.min(bounds[2], view[2]),
    top = Math.min(bounds[3], view[3]);
  if (right <= left || top <= bottom) return { tiles: [] as LayoutGridTile[], limited: false };
  const count = 2 ** lod,
    width = (bounds[2] - bounds[0]) / count,
    height = (bounds[3] - bounds[1]) / count;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    bounds[0] + width <= bounds[0] ||
    bounds[2] - width >= bounds[2] ||
    bounds[1] + height <= bounds[1] ||
    bounds[3] - height >= bounds[3]
  )
    throw new RangeError('Layout tile coordinates exceed the supported precision.');
  const x0 = Math.max(0, Math.floor((left - bounds[0]) / width));
  const y0 = Math.max(0, Math.floor((bottom - bounds[1]) / height));
  const x1 = Math.min(count - 1, Math.ceil((right - bounds[0]) / width) - 1);
  const y1 = Math.min(count - 1, Math.ceil((top - bounds[1]) / height) - 1);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles)
    return { tiles: [] as LayoutGridTile[], limited: true };
  const tiles: LayoutGridTile[] = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      tiles.push({
        id: `${lod}/${x}/${y}`,
        lod,
        x,
        y,
        box: [
          bounds[0] + x * width,
          bounds[1] + y * height,
          x === count - 1 ? bounds[2] : bounds[0] + (x + 1) * width,
          y === count - 1 ? bounds[3] : bounds[1] + (y + 1) * height,
        ],
      });
    }
  return { tiles, limited: false };
}

/** Identity must bind the host-validated source/session and conversion schema. */
export function layoutTileKey(
  identity: string,
  layer: string,
  tile: LayoutGridTile,
  mode: string,
  pixels: number,
) {
  return JSON.stringify([identity, layer, tile.id, tile.box, mode, pixels]);
}
