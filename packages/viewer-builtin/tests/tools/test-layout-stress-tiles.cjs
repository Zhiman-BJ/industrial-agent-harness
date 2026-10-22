#!/usr/bin/env node
// Optional, real KLayout integration acceptance against generated stress fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { RasterService } = require('../../src/layout/raster.cjs');
const manifestFile = process.argv[2];
const output = process.argv[3];
const python = process.env.KLAYOUT_PYTHON;
if (!manifestFile || !output || !python)
  throw Error(
    'Usage: KLAYOUT_PYTHON=... node test-layout-stress-tiles.cjs manifest.json evidence-directory',
  );
fs.mkdirSync(output, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  platform: process.platform,
  manifest: manifestFile,
  fixtures: [],
  status: 'running',
};
const writeReport = () =>
  fs.writeFileSync(
    path.join(output, 'tile-stress-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
function validate(result, request) {
  assert.equal(result.token, request.token);
  assert.equal(result.generation, request.generation);
  assert.equal(result.layer, request.layer);
  assert.deepEqual(result.box, request.box);
  assert.ok(['overview', 'exact', 'empty'].includes(result.mode));
  assert.ok(result.triangleCount <= 20000);
  if (result.mode === 'exact') {
    assert.equal(result.encoding, 'f64le-xyz');
    const bytes = Buffer.from(result.positions, 'base64');
    assert.equal(bytes.length, result.triangleCount * 9 * 8);
    for (let i = 0; i < bytes.length; i += 8) assert.ok(Number.isFinite(bytes.readDoubleLE(i)));
  } else if (result.mode === 'overview') {
    const png = Buffer.from(result.png, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    assert.ok(width >= 1 && height >= 1 && width <= request.pixels && height <= request.pixels);
  } else assert.equal(result.triangleCount, 0);
}
(async () => {
  for (const fixture of manifest.fixtures) {
    let maxLiveWorkers = 0;
    const liveWorkers = new Set();
    const record = {
      name: fixture.name,
      sourceSha256: hash(fixture.path),
      calls: [],
      workerResource: { peakRssBytes: 0, samples: 0, monitor: 'worker-self-rss' },
      status: 'running',
    };
    report.fixtures.push(record);
    writeReport();
    const service = new RasterService(python, {
      spawn: (...args) => {
        const child = spawn(...args);
        liveWorkers.add(child);
        maxLiveWorkers = Math.max(maxLiveWorkers, liveWorkers.size);
        child.once('exit', () => liveWorkers.delete(child));
        return child;
      },
      rssIntervalMs: 100,
    });
    const job = { source: fixture.path, tiles: [], seams: [] };
    let generation = 1;
    const token = `stress-${fixture.name}`;
    async function tile(label, layer, box, mode = 'auto', pixels = 128) {
      const request = { op: 'tile', token, generation, layer, box, mode, pixels };
      const started = performance.now();
      const result = await service.call(request);
      validate(result, request);
      if (!result.cacheHit) {
        assert.ok(
          Number.isFinite(result.resource?.peakRssBytes) && result.resource.peakRssBytes > 0,
          'Real worker RSS measurement is required',
        );
        record.workerResource.peakRssBytes = Math.max(
          record.workerResource.peakRssBytes,
          result.resource.peakRssBytes,
        );
        record.workerResource.samples++;
        assert.ok(
          result.resource.peakRssBytes <= 768 * 1024 * 1024,
          'Worker exceeds the soft memory budget',
        );
      }
      record.calls.push({
        case: label,
        layer,
        mode: result.mode,
        reason: result.reason,
        cacheHit: !!result.cacheHit,
        shapeCount: result.shapeCount,
        triangleCount: result.triangleCount,
        milliseconds: Math.round((performance.now() - started) * 1000) / 1000,
      });
      return result;
    }
    try {
      assert.equal(
        record.sourceSha256,
        fixture.sha256,
        'Fixture matches its reproducible manifest',
      );
      const started = performance.now();
      const loaded = await service.call({ op: 'load', path: fixture.path, token });
      record.loadMilliseconds = Math.round(performance.now() - started);
      assert.equal(loaded.layers.length, 32);
      const keys = loaded.layers.map(layer => layer.key);
      for (const key of keys) {
        const result = await tile('whole-layout', key, fixture.boxes.full);
        if (fixture.kind !== 'complex')
          assert.equal(result.mode, 'overview', 'Dense whole-layout uses an honest overview');
        if (fixture.kind === 'complex' && key === '1/0')
          assert.equal(result.mode, 'overview', 'A huge individual polygon falls back to overview');
      }
      const overview = await tile('forced-overview', '1/0', fixture.boxes.full, 'overview');
      assert.equal(overview.mode, 'overview');
      const cached = await tile('cached-overview', '1/0', fixture.boxes.full, 'overview');
      assert.equal(cached.cacheHit, true);
      assert.equal(cached.png, overview.png);
      generation++;
      const renewed = await tile('cache-new-generation', '1/0', fixture.boxes.full, 'overview');
      assert.equal(renewed.cacheHit, true);
      assert.equal(renewed.generation, generation);
      if (fixture.kind !== 'complex') {
        for (const key of keys) {
          const result = await tile('detail', key, fixture.boxes.detail, 'exact');
          assert.ok(
            ['exact', 'empty'].includes(result.mode),
            'Small detail must have exact geometry',
          );
          job.tiles.push({ case: 'detail', response: result });
          const [l, b, r, t] = fixture.boxes.seam,
            mid = Math.round((l + r) * 500) / 1000;
          const left = await tile('seam-left', key, [l, b, mid, t], 'exact');
          const right = await tile('seam-right', key, [mid, b, r, t], 'exact');
          assert.ok(
            ['exact', 'empty'].includes(left.mode) && ['exact', 'empty'].includes(right.mode),
          );
          job.tiles.push(
            { case: 'seam-left', response: left },
            { case: 'seam-right', response: right },
          );
          job.seams.push({ layer: key, box: [l, b, r, t], x: mid, left, right });
        }
      } else {
        const result = await tile('complex-small-detail', '1/0', fixture.boxes.detail, 'exact');
        assert.equal(result.mode, 'overview');
      }
      const pendingGeneration = ++generation;
      const obsolete = keys.slice(0, 3).map(layer =>
        service
          .call({
            op: 'tile',
            token,
            generation: pendingGeneration,
            layer,
            box: fixture.boxes.full,
            mode: 'overview',
            pixels: 512,
          })
          .then(
            result => ({ result }),
            error => ({ error: error.message }),
          ),
      );
      service.setGeneration(token, ++generation);
      const discarded = await Promise.all(obsolete);
      assert.ok(
        discarded.every(result => result.error && /superseded/.test(result.error)),
        JSON.stringify(discarded),
      );
      await tile('new-generation-after-cancel', '1/0', fixture.boxes.detail, 'auto');
      record.cancellation = { discarded: discarded.length, currentGeneration: generation };
      if (job.tiles.length) {
        const jobFile = path.join(output, `${fixture.name}-exact-tiles.json`);
        const oracleFile = path.join(output, `${fixture.name}-oracle.json`);
        fs.writeFileSync(jobFile, JSON.stringify(job));
        const checked = spawnSync(
          python,
          [path.join(__dirname, 'verify-layout-tiles.py'), jobFile, '--output', oracleFile],
          { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        if (fs.existsSync(oracleFile))
          record.xyOracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
        assert.equal(checked.status, 0, checked.stderr || checked.stdout);
      }
      assert.ok(maxLiveWorkers <= 1, 'Only one KLayout worker may be live');
      assert.ok(service.cacheBytes <= 64 * 1024 * 1024, 'Response cache stays below 64 MiB');
      assert.equal(hash(fixture.path), record.sourceSha256);
      record.sourceUnchanged = true;
      record.status = 'passed';
    } catch (error) {
      record.status = 'failed';
      record.error = error.stack || String(error);
      record.sourceUnchanged = hash(fixture.path) === record.sourceSha256;
    } finally {
      record.memoryStats = service.memoryStats || {
        status: 'unavailable',
        reason: 'Service has no memory observation counters',
      };
      record.maxLiveWorkers = maxLiveWorkers;
      record.cacheBytes = service.cacheBytes;
      service.close();
      writeReport();
      console.log(
        JSON.stringify({
          fixture: record.name,
          status: record.status,
          calls: record.calls.length,
          memoryStats: record.memoryStats,
          workerResource: record.workerResource,
          oracle: record.xyOracle && {
            passed: record.xyOracle.passed,
            tileChecks: record.xyOracle.tileChecks,
            seamChecks: record.xyOracle.seamChecks,
            tileFailureCount: record.xyOracle.tileFailures.length,
            seamFailureCount: record.xyOracle.seamFailures.length,
          },
          error: record.error?.split('\n')[0],
        }),
      );
    }
  }
  report.status = report.fixtures.every(item => item.status === 'passed') ? 'passed' : 'failed';
  writeReport();
  process.exitCode = report.status === 'passed' ? 0 : 1;
})().catch(error => {
  report.status = 'failed';
  report.error = error.stack;
  writeReport();
  console.error(error);
  process.exitCode = 1;
});
