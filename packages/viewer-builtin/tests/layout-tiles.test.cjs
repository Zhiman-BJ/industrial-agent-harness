const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { RasterService } = require('../src/layout/raster.cjs');

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const tileRequest = (overrides = {}) => ({
  op: 'tile',
  token: 'source-a',
  generation: 1,
  layer: '1/0',
  box: [0, 0, 10, 10],
  mode: 'auto',
  pixels: 256,
  ...overrides,
});
const exactResult = request => ({
  token: request.token,
  generation: request.generation,
  layer: request.layer,
  box: request.box,
  mode: 'exact',
  positions: Buffer.alloc(9 * 8).toString('base64'),
  encoding: 'f64le-xyz',
  shapeCount: 1,
  triangleCount: 1,
});
const overviewResult = request => ({
  token: request.token,
  generation: request.generation,
  layer: request.layer,
  box: request.box,
  mode: 'overview',
  png: 'opaque-preview',
  shapeCount: 0,
  triangleCount: 0,
});

async function fakeService(t, handler, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'immutable-snapshot.gds');
  fs.writeFileSync(file, 'synthetic worker input');
  const workers = [];
  const spawn = (_python, args) => {
    const child = new EventEmitter();
    child.pid = workers.length + 1;
    child.args = args;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.requests = [];
    child.respond = (request, result) =>
      child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    child.preview = (request, preview) =>
      child.stdout.write(JSON.stringify({ id: request.id, preview }) + '\n');
    child.stdin = new Writable({
      write(chunk, encoding, done) {
        const request = JSON.parse(chunk.toString());
        child.requests.push(request);
        if (request.op === 'load')
          setImmediate(() =>
            child.respond(request, {
              token: request.token,
              bbox: [0, 0, 10, 10],
              cell: 'TOP',
              dbu: 0.001,
              klayout: 'fixture',
              resource: options.loadResource || { peakRssBytes: 10, monitor: 'self-rss' },
            }),
          );
        else handler(child, request);
        done();
      },
    });
    child.kill = signal => {
      child.killed = signal;
    };
    workers.push(child);
    return child;
  };
  const service = new RasterService('fixture-python', { spawn, rssIntervalMs: 0, ...options });
  t.after(() => service.close());
  await service.call({ op: 'load', token: 'source-a', path: file });
  return { service, workers, file };
}

test('tile queue is bounded; advancing generation removes queued work and discards an active reply', async t => {
  const { service, workers } = await fakeService(t, () => {}, { maxQueue: 2 });
  const old = service.call(tileRequest());
  const oldRejected = assert.rejects(old, /superseded/);
  await nextTurn();
  const queuedA = service.call(tileRequest({ box: [10, 0, 20, 10] }));
  const queuedB = service.call(tileRequest({ box: [20, 0, 30, 10] }));
  const aRejected = assert.rejects(queuedA, /superseded/);
  const bRejected = assert.rejects(queuedB, /superseded/);
  await assert.rejects(service.call(tileRequest({ box: [30, 0, 40, 10] })), /queue is full/);
  service.setGeneration('source-a', 2);
  await Promise.all([oldRejected, aRejected, bRejected]);
  assert.equal(service.queue.length, 0);
  const current = service.call(tileRequest({ generation: 2 }));
  const worker = workers[0];
  const first = worker.requests.find(request => request.op === 'tile');
  worker.respond(first, exactResult(first));
  await nextTurn();
  const second = worker.requests.filter(request => request.op === 'tile')[1];
  assert.equal(second.generation, 2);
  worker.respond(second, exactResult(second));
  assert.equal((await current).generation, 2);
  assert.equal(worker.requests.filter(request => request.op === 'tile').length, 2);
  await assert.rejects(service.call(tileRequest({ generation: 1 })), /superseded/);
});

test('tile cache is generation-independent, returns isolated copies, and never crosses source tokens', async t => {
  const { service, workers, file } = await fakeService(t, (worker, request) =>
    worker.respond(request, exactResult(request)),
  );
  const first = await service.call(tileRequest());
  first.box[0] = -999;
  const cached = await service.call(tileRequest({ generation: 2 }));
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.generation, 2);
  assert.deepEqual(cached.box, [0, 0, 10, 10]);
  assert.equal(workers[0].requests.filter(request => request.op === 'tile').length, 1);
  assert.ok(service.cacheBytes >= first.positions.length);
  await service.call({ op: 'load', token: 'source-b', path: file });
  assert.equal(service.cacheBytes, 0);
  await assert.rejects(service.call(tileRequest({ generation: 3 })), /selection changed/);
  const fresh = await service.call(tileRequest({ token: 'source-b', generation: 1 }));
  assert.equal(fresh.cacheHit, undefined);
  assert.equal(workers[1].requests.filter(request => request.op === 'tile').length, 1);
});

test('tile LRU accounts for retained base64 bytes and evicts within its byte budget', async t => {
  const { service, workers } = await fakeService(
    t,
    (worker, request) => {
      worker.respond(request, { ...exactResult(request), positions: 'A'.repeat(700) });
    },
    { maxCacheBytes: 1300 },
  );
  await service.call(tileRequest());
  assert.ok(service.cacheBytes >= 700 && service.cacheBytes <= 1300);
  await service.call(tileRequest({ layer: '2/0' }));
  assert.equal(service.cache.size, 1);
  await service.call(tileRequest());
  assert.equal(workers[0].requests.filter(request => request.op === 'tile').length, 3);
  assert.ok(service.cacheBytes <= 1300);
});

test('native exact timeout returns its bounded preview and the next render reloads the snapshot', async t => {
  const { service, workers, file } = await fakeService(
    t,
    (worker, request) => {
      if (request.op === 'tile') worker.preview(request, overviewResult(request));
      else worker.respond(request, { png: '2d-raster' });
    },
    { tileTimeoutMs: 15 },
  );
  const result = await service.call(tileRequest());
  assert.equal(result.mode, 'overview');
  assert.equal(result.reason, 'worker-timeout');
  assert.equal(result.png, 'opaque-preview');
  assert.equal(workers[0].killed, 'SIGKILL');
  assert.equal(service.cache.size, 0, 'hard timeout must not poison future exact attempts');
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: '2d-raster' });
  assert.equal(workers.length, 2);
  assert.equal(workers[1].requests[0].op, 'load');
  assert.equal(workers[1].requests[0].path, file);
  workers[0].emit('exit', null, 'SIGKILL');
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: '2d-raster' });
  assert.equal(workers.length, 2, 'late exit from an obsolete worker cannot kill the replacement');
  assert.equal(service.failure, undefined);
});

test('timeout without a preview fails explicitly and allows subsequent 2D recovery', async t => {
  const { service, workers } = await fakeService(
    t,
    (worker, request) => {
      if (request.op === 'render') worker.respond(request, { png: 'recovered' });
    },
    { tileTimeoutMs: 15 },
  );
  await assert.rejects(service.call(tileRequest()), /timed out/);
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: 'recovered' });
  assert.equal(workers.length, 2);
});

test('RSS overrun is a visible error, kills only that worker, and preserves recovery', async t => {
  const { service, workers } = await fakeService(
    t,
    (worker, request) => {
      if (request.op === 'render') worker.respond(request, { png: 'recovered' });
    },
    { rssIntervalMs: 5, readRss: async pid => (pid === 1 ? 100 : 1), maxRssBytes: 50 },
  );
  await assert.rejects(service.call(tileRequest()), /memory budget/);
  assert.equal(workers[0].killed, 'SIGKILL');
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: 'recovered' });
  assert.equal(service.failure, undefined);
});

test('oversized unterminated worker replies fail before unbounded accumulation and can recover', async t => {
  const { service } = await fakeService(
    t,
    (worker, request) => {
      if (request.op === 'tile') worker.stdout.write('x'.repeat(1025));
      else worker.respond(request, { png: 'recovered' });
    },
    { maxTileResponseBytes: 1024 },
  );
  await assert.rejects(service.call(tileRequest()), /response exceeded/);
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: 'recovered' });
});

test('input and lifecycle bounds reject oversized loads and all work after close', async t => {
  const { service, workers, file } = await fakeService(t, () => {});
  service.options.maxInputBytes = 1;
  await assert.rejects(
    service.call({ op: 'load', token: 'source-b', path: file }),
    /input exceeds/,
  );
  assert.equal(workers.length, 1, 'reject before starting another native process');
  service.close();
  service.close();
  await assert.rejects(service.call(tileRequest()), /Renderer closed/);
  assert.equal(service.cacheBytes, 0);
});

const native = { skip: !process.env.KLAYOUT_PYTHON };
async function nativeFixture(t, code, extension = 'gds') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-native-tiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, `tile-fixture.${extension}`);
  const made = spawnSync(
    process.env.KLAYOUT_PYTHON,
    [
      '-c',
      `
import json, math, sys
import klayout.db as db
layout = db.Layout()
layout.dbu = 0.001
top = layout.create_cell('TOP')
layer = layout.layer(1, 0)
${code}
layout.write(sys.argv[1])
check = db.Layout()
check.read(sys.argv[1])
counts = [shape.polygon.num_points() for index in check.layer_indices()
          for shape in check.top_cell().shapes(index).each() if shape.is_polygon()]
print(json.dumps({'largestPolygon': max(counts, default=0)}))
`,
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, made.stderr);
  const service = new RasterService(process.env.KLAYOUT_PYTHON);
  t.after(() => service.close());
  const loaded = await service.call({ op: 'load', path: file, token: 'native-tile-fixture' });
  return {
    service,
    loaded,
    file,
    original: fs.readFileSync(file),
    stats: JSON.parse(made.stdout),
    tile: overrides =>
      service.call(tileRequest({ token: loaded.token, box: loaded.bbox, ...overrides })),
  };
}

function decodePositions(result) {
  assert.equal(result.encoding, 'f64le-xyz');
  const bytes = Buffer.from(result.positions, 'base64');
  assert.equal(bytes.length % (9 * 8), 0);
  assert.equal(bytes.length / (9 * 8), result.triangleCount);
  return Array.from({ length: bytes.length / 8 }, (_, i) => bytes.readDoubleLE(i * 8));
}

function regionOracle(file, tiles, { allWalls = false } = {}) {
  const checked = spawnSync(
    process.env.KLAYOUT_PYTHON,
    [
      '-c',
      `
import base64, json, math, struct, sys
import klayout.db as db
layout = db.Layout()
layout.read(sys.argv[1])
cell = layout.top_cell()
dbu = layout.dbu
payload = json.load(sys.stdin)
expected_all = db.Region()
projected_all = db.Region()
walls_all = db.Edges()
for tile in payload['tiles']:
    key = tile['layer'].split('/')
    index = layout.find_layer(int(key[0]), int(key[1]))
    assert index is not None
    source = db.Region(cell.begin_shapes_rec(index)).merged()
    clip = db.Box(*[round(value / dbu) for value in tile['clipBox']])
    expected = (source & db.Region(clip)).merged()
    projected = db.Region()
    actual_walls = db.Edges()
    binary = base64.b64decode(tile['positions'])
    vertices = struct.unpack('<' + 'd' * (len(binary) // 8), binary)
    for i in range(0, len(vertices), 9):
        triangle = vertices[i:i + 9]
        points = [db.Point(round(triangle[j] / dbu), round(triangle[j + 1] / dbu)) for j in (0, 3, 6)]
        zs = [triangle[j] for j in (2, 5, 8)]
        assert all(z in (0, 1) for z in zs), 'Z must remain normalized for illustrative extrusion'
        assert all(clip.contains(point) for point in points), 'XY escaped tile bounds'
        if zs == [1, 1, 1]:
            projected.insert(db.Polygon(points))
        elif len(set(zs)) > 1:
            unique = list(dict.fromkeys((point.x, point.y) for point in points))
            assert len(unique) == 2, 'wall triangle must project to one source edge'
            actual_walls.insert(db.Edge(db.Point(*unique[0]), db.Point(*unique[1])))
    projected.merge()
    assert (expected - projected).is_empty(), 'tile lost source geometry'
    assert (projected - expected).is_empty(), 'tile added geometry or filled a hole'
    true_walls = source.edges() & expected
    assert (actual_walls - true_walls).is_empty(), 'false vertical wall at a clipping seam'
    assert (true_walls - actual_walls).is_empty(), 'missing real source wall'
    expected_all += expected
    projected_all += projected
    walls_all += actual_walls
assert (expected_all.merged() ^ projected_all.merged()).is_empty(), 'tile union differs from source'
if payload['allWalls']:
    source = db.Region(cell.begin_shapes_rec(layout.find_layer(1, 0))).merged()
    assert (source.edges() - walls_all).is_empty(), 'tile union omitted outer or hole walls'
    assert (walls_all - source.edges()).is_empty(), 'tile union introduced a seam wall'
print(json.dumps({'area': projected_all.merged().area() * dbu * dbu, 'tiles': len(payload['tiles'])}))
`,
      file,
    ],
    { input: JSON.stringify({ tiles, allWalls }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(checked.status, 0, checked.stderr);
  return JSON.parse(checked.stdout);
}

function assertMask(result, pixels) {
  const bytes = Buffer.from(result.png, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), pixels);
  assert.equal(bytes.readUInt32BE(20), pixels);
  const checked = spawnSync(
    process.env.KLAYOUT_PYTHON,
    [
      '-c',
      `
import base64, json, sys
import klayout.lay as lay
pixels = lay.PixelBuffer.from_png_data(base64.b64decode(sys.stdin.read()))
values = set()
for y in range(pixels.height()):
    for x in range(pixels.width()):
        rgb = pixels.pixel(x, y) & 0xffffff
        r, g, b = rgb >> 16, (rgb >> 8) & 255, rgb & 255
        assert r == g == b, 'overview must be a neutral coverage mask'
        values.add(r)
assert 0 in values, 'expected empty pixels in the tile'
assert max(values) > 0, 'overview silently returned an empty raster'
print(json.dumps({'levels': len(values)}))
`,
    ],
    { input: result.png, encoding: 'utf8' },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(JSON.parse(checked.stdout).levels >= 2);
}

test(
  'native adjacent exact tiles preserve holes, diagonal boundaries and transformed instances without seam walls',
  native,
  async t => {
    const subject = await nativeFixture(
      t,
      `
donut = db.Polygon(db.Box(0, 0, 12000, 10000))
donut.insert_hole(db.Box(2000, 2000, 10000, 8000))
top.shapes(layer).insert(donut)
top.shapes(layer).insert(db.Polygon([db.Point(0,12000), db.Point(12000,12000), db.Point(0,24000)]))
child = layout.create_cell('CHILD')
child.shapes(layer).insert(db.Box(0, 0, 1000, 2000))
top.insert(db.CellInstArray(child.cell_index(), db.Trans(1, False, 12000, 26000)))
top.insert(db.CellInstArray(child.cell_index(), db.Trans(0, True, 2000, 30000)))
other = layout.layer(2, 0)
top.shapes(other).insert(db.Path([db.Point(0, 33000), db.Point(12000, 33000)], 1000))
`,
    );
    const tiles = [];
    for (const box of [
      [0, 0, 6, 32],
      [6, 0, 12, 32],
    ]) {
      const tile = await subject.tile({ box, mode: 'exact' });
      assert.equal(tile.mode, 'exact');
      assert.equal(tile.token, subject.loaded.token);
      assert.equal(tile.generation, 1);
      assert.equal(tile.layer, '1/0');
      assert.deepEqual(tile.box, box);
      const points = decodePositions(tile);
      assert.ok(points.every(Number.isFinite));
      tiles.push(tile);
    }
    const oracle = regionOracle(subject.file, tiles, { allWalls: true });
    assert.equal(oracle.area, 148);
    const pathTile = await subject.tile({ layer: '2/0', box: [3, 32, 9, 34], mode: 'exact' });
    assert.equal(regionOracle(subject.file, [pathTile]).area, 6);
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test(
  'native dense multilayer full-chip requests return coverage overviews, then exact detail recovers',
  native,
  async t => {
    const subject = await nativeFixture(
      t,
      `
for number in range(1, 4):
    dense_layer = layout.layer(number, 0)
    for i in range(2501):
        x, y = (i % 51) * 1000, (i // 51) * 1000
        top.shapes(dense_layer).insert(db.Box(x, y, x + 400, y + 400))
`,
    );
    for (const layer of ['1/0', '2/0', '3/0']) {
      const tile = await subject.tile({ layer, mode: 'auto', box: [0, 0, 52, 52] });
      assert.equal(tile.mode, 'overview');
      assert.ok(tile.reason, 'fallback exposes why precise geometry was bounded');
      assert.equal(
        tile.positions,
        undefined,
        'no incomplete exact mesh masquerades as a whole tile',
      );
      assertMask(tile, 256);
    }
    const forced = await subject.tile({ layer: '1/0', mode: 'exact', box: [0, 0, 52, 52] });
    assert.equal(forced.mode, 'overview', 'explicit exact mode also remains bounded');
    const detail = await subject.tile({ layer: '1/0', generation: 2, box: [0, 0, 2, 2] });
    assert.equal(detail.mode, 'exact');
    assert.equal(regionOracle(subject.file, [detail]).area, 0.64);
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test(
  'native single huge OASIS polygon falls back to a valid overview instead of rejecting the viewport',
  native,
  async t => {
    const subject = await nativeFixture(
      t,
      `
points = []
for i in range(12002):
    angle = i * 2 * math.pi / 12002
    radius = 1000000 + 10000 * (i % 2)
    points.append(db.Point(round(radius * math.cos(angle)), round(radius * math.sin(angle))))
top.shapes(layer).insert(db.Polygon(points))
`,
      'oas',
    );
    assert.ok(
      subject.stats.largestPolygon > 10000,
      'OASIS must preserve one genuinely complex polygon',
    );
    const tile = await subject.tile({ box: [-1100, -1100, 1100, 1100], pixels: 128 });
    assert.equal(tile.mode, 'overview');
    assert.ok(tile.reason);
    assertMask(tile, 128);
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test(
  'native tile identity and parameter rejection leave the worker usable; offscreen tiles are explicitly empty',
  native,
  async t => {
    const subject = await nativeFixture(t, 'top.shapes(layer).insert(db.Box(0, 0, 10000, 10000))');
    await assert.rejects(subject.tile({ token: 'wrong-token' }), /selection changed/);
    for (const overrides of [
      { box: [0, 0, 0, 10] },
      { box: [0, 0, 1e100, 10] },
      { box: [0, 0, null, 10] },
      { pixels: 4096 },
      { mode: 'invalid' },
      { layer: '99/0' },
    ])
      await assert.rejects(subject.tile(overrides));
    const empty = await subject.tile({ box: [20, 20, 30, 30] });
    assert.equal(empty.mode, 'empty');
    assert.equal(empty.shapeCount, 0);
    assert.equal(empty.triangleCount, 0);
    const valid = await subject.tile({ mode: 'exact' });
    assert.equal(valid.mode, 'exact');
    assert.equal(regionOracle(subject.file, [valid], { allWalls: true }).area, 100);
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test('unavailable worker resource monitoring explicitly refuses tiles while legacy 2D stays available', async t => {
  const { service, workers } = await fakeService(
    t,
    (worker, request) => {
      worker.respond(request, { png: 'legacy-2d' });
    },
    { loadResource: { peakRssBytes: null, monitor: 'unavailable' } },
  );
  await assert.rejects(
    service.call(tileRequest()),
    /resource monitoring is unavailable on this platform/,
  );
  assert.equal(workers[0].requests.filter(request => request.op === 'tile').length, 0);
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: 'legacy-2d' });
});

test('blocked external RSS monitoring falls back to worker self-RSS without reporting a false zero', async t => {
  let measurements = 0;
  const { service, workers } = await fakeService(
    t,
    (worker, request) => {
      if (request.op === 'render') worker.respond(request, { png: 'legacy-2d' });
    },
    {
      rssIntervalMs: 5,
      readRss: async () => {
        measurements += 1;
        throw Error('ps denied');
      },
    },
  );
  const pending = service.call(tileRequest());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.externalMonitorStatus, 'unavailable');
  assert.equal(measurements, 1, 'stop probing a denied external monitor');
  const worker = workers[0];
  const request = worker.requests.find(item => item.op === 'tile');
  worker.preview(request, {
    ...overviewResult(request),
    resource: { peakRssBytes: 200, monitor: 'self-rss' },
  });
  worker.respond(request, {
    ...exactResult(request),
    resource: { peakRssBytes: 300, monitor: 'self-rss' },
  });
  assert.equal((await pending).mode, 'exact');
  assert.equal(worker.killed, undefined);
  assert.equal(service.memoryStats.peakRssBytes, 300);
  assert.ok(service.memoryStats.samples >= 3);
  assert.equal(service.memoryStats.source, 'self-rss');
  assert.equal(worker.args[worker.args.indexOf('--max-rss-bytes') + 1], String(768 * 1024 * 1024));
  assert.deepEqual(await service.call({ op: 'render', token: 'source-a' }), { png: 'legacy-2d' });
});

test(
  'native shared tile edges quantize consistently at exact, fractional and negative-half DBU boundaries',
  native,
  async t => {
    const subject = await nativeFixture(
      t,
      'top.shapes(layer).insert(db.Box(-10000, 0, 50000, 1000))',
    );
    for (const [boundary, expectedBoundary] of [
      [32.01, 32.01],
      [32.0104, 32.01],
      [-0.0005, 0],
    ]) {
      const left = await subject.tile({ mode: 'exact', box: [-10, 0, boundary, 1] });
      const right = await subject.tile({ mode: 'exact', box: [boundary, 0, 50, 1] });
      assert.equal(left.mode, 'exact');
      assert.equal(right.mode, 'exact');
      assert.equal(left.clipBox[2], right.clipBox[0]);
      assert.ok(Math.abs(left.clipBox[2] - expectedBoundary) < 1e-12);
      assert.equal(regionOracle(subject.file, [left, right], { allWalls: true }).area, 60);
    }
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test(
  'native worker enforces its own RSS budget during load without waiting for an external monitor',
  native,
  async t => {
    const subject = await nativeFixture(t, 'top.shapes(layer).insert(db.Box(0, 0, 10000, 10000))');
    const limited = new RasterService(process.env.KLAYOUT_PYTHON, {
      maxRssBytes: 1,
      rssIntervalMs: 0,
      loadTimeoutMs: 2000,
    });
    t.after(() => limited.close());
    await assert.rejects(
      limited.call({ op: 'load', path: subject.file, token: 'memory-limited' }),
      /memory budget/,
    );
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test(
  'native exact caps retain positive winding for tiny geometry at a large world origin',
  native,
  async t => {
    const subject = await nativeFixture(
      t,
      'top.shapes(layer).insert(db.Box(2000000000, 2000000000, 2000000010, 2000000020))',
    );
    const tile = await subject.tile({ mode: 'exact' });
    assert.equal(tile.mode, 'exact');
    const vertices = decodePositions(tile);
    let caps = 0;
    for (let i = 0; i < vertices.length; i += 9) {
      const triangle = vertices.slice(i, i + 9);
      if (triangle[2] !== 1 || triangle[5] !== 1 || triangle[8] !== 1) continue;
      const signedArea =
        ((triangle[3] - triangle[0]) * (triangle[7] - triangle[1]) -
          (triangle[6] - triangle[0]) * (triangle[4] - triangle[1])) /
        2;
      assert.ok(
        signedArea > 0,
        'top-cap orientation must not suffer cancellation at a large origin',
      );
      caps += 1;
    }
    assert.ok(caps >= 2);
    assert.equal(regionOracle(subject.file, [tile], { allWalls: true }).area, 0.0002);
    assert.deepEqual(fs.readFileSync(subject.file), subject.original);
  },
);

test('fatal self-RSS rejection retires the worker before queued recovery starts', async t => {
  const { service, workers } = await fakeService(t, (worker, request) => {
    if (request.op === 'tile')
      worker.stdout.write(
        JSON.stringify({
          id: request.id,
          error: 'KLayout worker exceeded its memory budget.',
          fatal: true,
        }) + '\n',
      );
    else worker.respond(request, { png: 'recovered-2d' });
  });
  const rejected = assert.rejects(service.call(tileRequest()), /memory budget/);
  const recovered = service.call({ op: 'render', token: 'source-a' });
  await rejected;
  assert.deepEqual(await recovered, { png: 'recovered-2d' });
  assert.equal(workers[0].killed, 'SIGKILL');
  assert.equal(workers.length, 2);
  assert.equal(workers[1].requests[0].op, 'load');
  assert.equal(workers[0].requests.filter(request => request.op === 'render').length, 0);
});
