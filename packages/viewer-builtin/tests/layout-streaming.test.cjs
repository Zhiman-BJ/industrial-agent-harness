const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLayoutTileCache,
  createLayoutTileScheduler,
  planLayoutTiles,
  layoutTileKey,
  layoutResolutionLimits,
} = require('../src/layout/layout-streaming.ts');

const cost = (cpuBytes, gpuBytes = cpuBytes, triangles = 1) => ({ cpuBytes, gpuBytes, triangles });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('tile cache independently limits CPU, GPU and triangles and evicts the least recently used', () => {
  const disposed = [];
  const cache = createLayoutTileCache(cost(10, 10, 4), (value, key) => disposed.push([key, value]));
  assert.equal(cache.set('a', 'A', cost(3, 3)), true);
  assert.equal(cache.set('b', 'B', cost(3, 3)), true);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.set('c', 'C', cost(5, 5)), true);
  assert.deepEqual(disposed, [['b', 'B']]);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.set('gpu', 'GPU', cost(1, 11)), false);
  assert.equal(cache.set('cpu', 'CPU', cost(11, 1)), false);
  assert.equal(cache.set('tri', 'TRI', cost(1, 1, 5)), false);
  assert.equal(cache.stats().rejections, 3);
  assert.equal(cache.stats().cpuBytes, 8);
  assert.equal(cache.stats().gpuBytes, 8);
  assert.equal(cache.stats().triangles, 2);
  // Refused objects never become cache-owned and must not be disposed by it.
  cache.clear();
  assert.deepEqual(disposed, [
    ['b', 'B'],
    ['a', 'A'],
    ['c', 'C'],
  ]);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().cpuBytes, 0);
});

test('protected visible coverage cannot exceed the budget and failed admission does not evict anything', () => {
  const disposed = [];
  const cache = createLayoutTileCache(cost(10, 10, 10), value => disposed.push(value));
  cache.set('visible', 'visible', cost(8));
  cache.set('old', 'old', cost(2));
  cache.protect(['visible']);
  assert.equal(cache.set('new', 'new', cost(4)), false);
  assert.deepEqual(disposed, []);
  assert.equal(cache.has('old'), true);
  cache.protect([]);
  assert.equal(cache.set('new', 'new', cost(4)), true);
  assert.deepEqual(disposed, ['visible']);
  assert.equal(cache.stats().cpuBytes, 6);
});

test('replacements release old resources exactly once and overview bytes count against the same budget', () => {
  const disposed = [];
  const cache = createLayoutTileCache(cost(10, 10, 10), value => disposed.push(value));
  assert.equal(cache.set('overview', 'mask', cost(5, 4, 0)), true);
  cache.protect(['overview']);
  assert.equal(cache.set('exact', 'mesh', cost(6, 4, 2)), false);
  assert.equal(cache.set('overview', 'mask2', cost(3, 2, 0)), true);
  assert.equal(cache.set('exact', 'mesh', cost(6, 4, 2)), true);
  assert.deepEqual(disposed, ['mask']);
  assert.equal(cache.delete('overview'), true);
  assert.equal(cache.delete('overview'), false);
  cache.clear();
  assert.deepEqual(disposed, ['mask', 'mask2', 'mesh']);
  assert.equal(cache.stats().gpuBytes, 0);
  assert.throws(() => cache.set('bad', {}, cost(NaN)), RangeError);
  assert.throws(() => cache.set('bad', {}, cost(-1)), RangeError);
});

test('scheduler bounds live work and its queue, prioritizes requests, and exposes rejected demand', async () => {
  const pending = new Map(),
    started = [],
    ready = [];
  const scheduler = createLayoutTileScheduler({
    concurrency: 2,
    maxQueued: 1,
    load(request) {
      started.push(request.key);
      const work = deferred();
      pending.set(request.key, work);
      return work.promise;
    },
    onReady(request, value) {
      ready.push([request.key, value]);
    },
  });
  const result = scheduler.replace([
    { key: 'd', priority: 4 },
    { key: 'b', priority: 2 },
    { key: 'a', priority: 1 },
    { key: 'c', priority: 3 },
    { key: 'a', priority: 5 },
  ]);
  await flush();
  assert.deepEqual(result.rejected, ['d']);
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(scheduler.stats().active, 2);
  assert.equal(scheduler.stats().queued, 1);
  pending.get('a').resolve('A');
  await flush();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(scheduler.stats().active, 2);
  pending.get('b').resolve('B');
  pending.get('c').resolve('C');
  await flush();
  assert.equal(scheduler.stats().active, 0);
  assert.deepEqual(ready, [
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ]);
  scheduler.dispose();
});

test('a shared active key survives plan changes and is requested only once', async () => {
  const work = deferred(),
    ready = [],
    contexts = [];
  const scheduler = createLayoutTileScheduler({
    load(_request, context) {
      contexts.push(context);
      return work.promise;
    },
    onReady(request, value) {
      ready.push([request.key, value]);
    },
  });
  scheduler.replace([{ key: 'shared' }]);
  await flush();
  scheduler.replace([{ key: 'shared', priority: -1 }]);
  assert.equal(contexts[0].signal.aborted, false);
  work.resolve('same-source');
  await flush();
  assert.equal(contexts.length, 1);
  assert.deepEqual(ready, [['shared', 'same-source']]);
  scheduler.dispose();
});

test('the concurrency slot covers asynchronous image decoding and GPU upload', async () => {
  const upload = deferred(),
    started = [],
    ready = [];
  const scheduler = createLayoutTileScheduler({
    concurrency: 1,
    async load(request) {
      started.push(request.key);
      return request.key;
    },
    async onReady(request) {
      ready.push(request.key);
      if (request.key === 'overview') await upload.promise;
    },
  });
  scheduler.replace([{ key: 'overview' }, { key: 'exact' }]);
  await flush();
  assert.deepEqual(started, ['overview']);
  assert.deepEqual(ready, ['overview']);
  assert.equal(scheduler.stats().active, 1);
  upload.resolve();
  await flush();
  assert.deepEqual(started, ['overview', 'exact']);
  assert.deepEqual(ready, ['overview', 'exact']);
  assert.equal(scheduler.stats().active, 0);
  scheduler.dispose();
});

test('clear and same-key reentry discard stale responses without oversubscribing the worker', async () => {
  const pending = [],
    started = [],
    ready = [],
    disposed = [],
    errors = [];
  const scheduler = createLayoutTileScheduler({
    concurrency: 1,
    load(request, context) {
      const work = deferred();
      pending.push(work);
      started.push({ request, context });
      return work.promise;
    },
    onReady(request, value) {
      ready.push([request.generation, value]);
    },
    onError(_request, error) {
      errors.push(error);
    },
    dispose(value) {
      disposed.push(value);
    },
  });
  scheduler.replace([{ key: 'tile', generation: 1 }]);
  await flush();
  scheduler.clear();
  scheduler.replace([{ key: 'tile', generation: 2 }]);
  await flush();
  assert.equal(started.length, 1, 'aborting does not free a still-running native request slot');
  assert.equal(started[0].context.signal.aborted, true);
  assert.equal(scheduler.stats().active, 1);
  assert.equal(scheduler.stats().queued, 1);
  pending[0].resolve('stale');
  await flush();
  assert.deepEqual(disposed, ['stale']);
  assert.deepEqual(ready, []);
  assert.equal(started.length, 2);
  assert.equal(started[1].request.generation, 2);
  pending[1].resolve('current');
  await flush();
  assert.deepEqual(ready, [[2, 'current']]);
  assert.deepEqual(errors, []);
  assert.equal(scheduler.stats().active, 0);
  scheduler.dispose();
});

test('cancelled failures are suppressed while current failures are reported; disposed results are released', async () => {
  const pending = [],
    errors = [],
    disposed = [];
  const scheduler = createLayoutTileScheduler({
    load() {
      const work = deferred();
      pending.push(work);
      return work.promise;
    },
    onReady() {
      assert.fail('No result may be published');
    },
    onError(request, error) {
      errors.push([request.key, error.message]);
    },
    dispose(value) {
      disposed.push(value);
    },
  });
  scheduler.replace([{ key: 'old' }]);
  await flush();
  scheduler.replace([{ key: 'new' }]);
  pending[0].reject(new Error('cancelled worker'));
  await flush();
  pending[1].reject(new Error('parse failed'));
  await flush();
  assert.deepEqual(errors, [['new', 'parse failed']]);
  scheduler.replace([{ key: 'late' }]);
  await flush();
  scheduler.dispose();
  pending[2].resolve('late buffer');
  await flush();
  assert.deepEqual(disposed, ['late buffer']);
  assert.throws(() => scheduler.replace([]), /disposed/);
});

test('tile boxes use one global grid across navigation, including negative coordinates and exact edges', () => {
  const bounds = [-8, -4, 8, 4];
  const first = planLayoutTiles(bounds, [-7, -3, -1, -0.1], 2);
  const shifted = planLayoutTiles(bounds, [-5, -2, 1, 1], 2);
  for (const tile of first.tiles) {
    const same = shifted.tiles.find(other => other.id === tile.id);
    if (same) assert.deepEqual(same.box, tile.box);
  }
  assert.deepEqual(planLayoutTiles(bounds, [-8, -4, -4, -2], 2).tiles, [
    { id: '2/0/0', lod: 2, x: 0, y: 0, box: [-8, -4, -4, -2] },
  ]);
  assert.equal(planLayoutTiles(bounds, [-100, -100, 100, 100], 1).tiles.length, 4);
  assert.deepEqual(planLayoutTiles(bounds, [20, 20, 30, 30], 2), { tiles: [], limited: false });
  assert.deepEqual(planLayoutTiles(bounds, bounds, 4, 64), { tiles: [], limited: true });
  assert.throws(() => planLayoutTiles(bounds, bounds, 31), RangeError);
  const huge = [1e16, 1e16, 1e16 + 16, 1e16 + 16];
  assert.throws(() => planLayoutTiles(huge, huge, 24), /precision/);
});

test('resolution limits follow DBU and source tile quantization with finite hard caps', () => {
  assert.deepEqual(layoutResolutionLimits([0, 0, 64, 32], [0, 0, 1024, 512], 0.5), {
    maxZoom: 128,
    maxLod: 10,
  });
  assert.deepEqual(layoutResolutionLimits([0, 0, 100, 80], [0, 0, 100, 80], 3), {
    maxZoom: 100 / 3,
    maxLod: 4,
  });
  assert.deepEqual(layoutResolutionLimits([0, 0, 0.1, 0.1], [0, 0, 0.1, 0.1], 1), {
    maxZoom: 1,
    maxLod: 0,
  });
  assert.deepEqual(layoutResolutionLimits([0, 0, 1, 1], [0, 0, 1, 1]), {
    maxZoom: 65536,
    maxLod: 20,
  });
  assert.deepEqual(
    layoutResolutionLimits([-10, -20, 10, 20], [-10, -20, 10, 20], Number.MIN_VALUE),
    { maxZoom: 2 ** 30, maxLod: 30 },
  );
  const large = [1e16, 1e16, 1e16 + 16, 1e16 + 16];
  const limits = layoutResolutionLimits(large, large, 0.001);
  assert.equal(limits.maxLod, 3, 'tile edges must remain distinguishable as JavaScript doubles');
  assert.doesNotThrow(() => planLayoutTiles(large, large, limits.maxLod));
  const bounds = [0, 0, 2 ** 30, 2 ** 30];
  assert.deepEqual(planLayoutTiles(bounds, [0, 0, 1, 1], 30).tiles[0].box, [0, 0, 1, 1]);
  assert.deepEqual(planLayoutTiles(bounds, bounds, 30), { tiles: [], limited: true });
});

test('resolution limits reject invalid or overflowing bounds and nonpositive/nonfinite DBU', () => {
  const valid = [0, 0, 10, 10];
  for (const dbu of [0, -1, NaN, Infinity, -Infinity, null])
    assert.throws(() => layoutResolutionLimits(valid, valid, dbu), RangeError);
  for (const bounds of [
    [0, 0, 0, 10],
    [10, 0, 0, 10],
    [0, 0, 1],
    [0, 0, Infinity, 10],
    [0, NaN, 10, 10],
    [-Number.MAX_VALUE, 0, Number.MAX_VALUE, 1],
  ]) {
    assert.throws(() => layoutResolutionLimits(bounds, valid, 1), RangeError);
    assert.throws(() => layoutResolutionLimits(valid, bounds, 1), RangeError);
  }
});

test('tile identity separates source, layer, LOD, geometry mode and mask resolution', () => {
  const tile = planLayoutTiles([0, 0, 8, 8], [0, 0, 8, 8], 0).tiles[0];
  const key = layoutTileKey('source-v1', '1/0', tile, 'auto', 128);
  assert.equal(layoutTileKey('source-v1', '1/0', { ...tile }, 'auto', 128), key);
  assert.equal(
    new Set([
      key,
      layoutTileKey('source-v2', '1/0', tile, 'auto', 128),
      layoutTileKey('source-v1', '2/0', tile, 'auto', 128),
      layoutTileKey('source-v1', '1/0', { ...tile, id: '1/0/0' }, 'auto', 128),
      layoutTileKey('source-v1', '1/0', tile, 'exact', 128),
      layoutTileKey('source-v1', '1/0', tile, 'auto', 256),
    ]).size,
    6,
  );
});
