const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const directory = path.resolve(__dirname, '../src/kicad');
const vendor = path.join(directory, 'vendor/occt-import');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const importSource = name => {
  const text = fs
    .readFileSync(path.join(directory, name), 'utf8')
    .replaceAll('import.meta.url', JSON.stringify('https://kicad.test/session/' + name));
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
};
const loader = importSource('component-loader.js');
const wasm = importSource('component-wasm.js');
const triangle = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [0.1, 0.2, 0.3],
});
const source = Buffer.from('ISO-10303-21; component fixture bytes');
const entry = (overrides = {}) => ({
  id: 0,
  sha256: digest(source),
  format: 'step',
  size: source.length,
  url: 'models/0',
  ...overrides,
});

test('offline STEP parser and complete corresponding source match pinned fingerprints', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json')));
  assert.equal(manifest.version, '0.0.23');
  assert.equal(manifest.revision, 'c2148e54b456b571238d35cac037d304053d64b2');
  assert.equal(manifest.occtRevision, 'd2abb6d844231cb8f29be6894440874a4700e4a5');
  for (const [name, hash] of Object.entries(manifest.files))
    assert.equal(digest(fs.readFileSync(path.join(vendor, name))), hash, name);
  // Corresponding source archives live on the immutable vendor-sources
  // release, not in the tree; scripts/fetch-vendor-sources.cjs verifies their
  // pinned size and SHA-256 when downloaded.
  assert.equal(fs.existsSync(path.join(vendor, 'source')), false);
  const archives = manifest.sourceArchives;
  assert.equal(archives.length, 2);
  for (const archive of archives) {
    assert.equal(
      archive.url,
      `https://github.com/Zhiman-BJ/industrial-agent-harness/releases/download/vendor-sources-v1/${archive.file}`,
    );
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0);
  }
});

test('bounded real WASM imports a real STEP and rejects growth beyond 256 MiB', async () => {
  const { boundPcbStepWasm, PCB_STEP_WASM_PAGES } = await wasm;
  const bytes = await boundPcbStepWasm(fs.readFileSync(path.join(vendor, 'occt-import-js.wasm')));
  assert.equal(WebAssembly.validate(bytes), true);
  let memory;
  const occt = await require(path.join(vendor, 'occt-import-js.js'))({
    wasmBinary: bytes,
    instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
      memory = instance.exports._;
      ready(instance);
      return instance.exports;
    },
    print() {},
    printErr() {},
  });
  const fixture = fs.readFileSync(path.join(vendor, 'upstream-fixtures/cube.stp'));
  const model = occt.ReadStepFile(fixture, { linearUnit: 'millimeter' });
  assert.equal(model.success, true);
  assert.equal(model.meshes.length, 1);
  assert.equal(model.meshes[0].index.array.length / 3, 12);
  const pages = memory.buffer.byteLength / 65536;
  assert.ok(pages < PCB_STEP_WASM_PAGES);
  assert.equal(memory.grow(1), pages, 'growth inside the real limit remains available');
  assert.throws(() => memory.grow(PCB_STEP_WASM_PAGES - pages), RangeError);
  assert.equal(
    memory.buffer.byteLength / 65536,
    pages + 1,
    'failed growth preserves the live heap',
  );
});

test('the memory adaptation rejects unrecognized or altered upstream binaries', async () => {
  const { boundPcbStepWasm } = await wasm;
  const bytes = fs.readFileSync(path.join(vendor, 'occt-import-js.wasm'));
  await assert.rejects(boundPcbStepWasm(bytes.subarray(1)), /Unexpected/);
  const changed = new Uint8Array(bytes);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(boundPcbStepWasm(changed), /integrity/);
});

const context = vm.createContext({
  self: {},
  Float32Array,
  Uint32Array,
  ArrayBuffer,
  TextDecoder,
});
vm.runInContext(fs.readFileSync(path.join(directory, 'component-worker.js'), 'utf8'), context);
const normalize = vm.runInContext('normalizeStepMeshes', context);

test('STEP conversion preserves source face colors and derives missing mesh normals', () => {
  const meshes = normalize(
    {
      success: true,
      meshes: [
        {
          attributes: {
            position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0] },
          },
          index: { array: [0, 1, 2, 3, 4, 5] },
          color: [0.1, 0.2, 0.3],
          brep_faces: [
            { first: 0, last: 0, color: [1, 0, 0] },
            { first: 1, last: 1, color: [0, 1, 0] },
          ],
        },
      ],
    },
    100,
    4096,
  ).meshes;
  assert.deepEqual(Array.from(meshes[0].colors.slice(0, 9)), [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(Array.from(meshes[0].colors.slice(9)), [0, 1, 0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(meshes[0].normals.slice(0, 3)), [0, 0, 1]);
});

test('mesh bounds reject invalid indices and data before admitting worker output', async () => {
  const { inspectComponentMeshes } = await loader;
  assert.deepEqual(inspectComponentMeshes([triangle()], 1, 84), { triangles: 1, bytes: 84 });
  assert.throws(() => inspectComponentMeshes([triangle()], 0, 84), /budget/);
  assert.throws(() => inspectComponentMeshes([triangle()], 1, 80), /budget/);
  const invalid = triangle();
  invalid.indices[0] = 3;
  assert.throws(() => inspectComponentMeshes([invalid], 1, 100), /coordinates/);
  invalid.indices[0] = 0;
  invalid.positions[1] = NaN;
  assert.throws(() => inspectComponentMeshes([invalid], 1, 100), /coordinates/);
});

function testRuntime({ stalled = false } = {}) {
  const state = { fetches: [], workers: [], jobs: [] };
  let started;
  state.started = new Promise(resolve => {
    started = resolve;
  });
  return {
    state,
    dependencies: {
      async fetch(url, options) {
        state.fetches.push({ url: String(url), options });
        return new Response(source, { headers: { 'Content-Length': String(source.length) } });
      },
      createWorker() {
        const worker = {
          terminate() {
            this.terminated = true;
          },
          postMessage(job) {
            state.jobs.push(job);
            started();
            if (!stalled)
              queueMicrotask(() =>
                this.onmessage?.({ data: { jobId: job.jobId, meshes: [triangle()] } }),
              );
          },
        };
        state.workers.push(worker);
        return worker;
      },
    },
  };
}

test('component loading verifies hashes and shares completed meshes for duplicate references', async () => {
  const { loadPcbComponentModels } = await loader;
  const runtime = testRuntime();
  const result = await loadPcbComponentModels(
    [entry(), entry({ id: 1, url: 'models/1' })],
    {},
    runtime.dependencies,
  );
  assert.equal(result.assets.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.stats.loadedModels, 2);
  assert.equal(result.stats.modelTriangles, 1);
  assert.equal(runtime.state.fetches.length, 1);
  assert.equal(runtime.state.jobs.length, 1);
  assert.equal(runtime.state.workers[0].terminated, true);
  assert.equal(runtime.state.fetches[0].url, 'https://kicad.test/session/models/0');
  assert.equal(runtime.state.fetches[0].options.redirect, 'error');
});

test('untrusted URLs and mismatching source hashes never reach the model parser', async () => {
  const { loadPcbComponentModels } = await loader;
  const runtime = testRuntime();
  const result = await loadPcbComponentModels(
    [
      entry({ url: 'https://external.invalid/model.step' }),
      entry({ id: 1, url: '../models/1' }),
      entry({ id: 2, url: 'models/2', sha256: 'a'.repeat(64) }),
    ],
    {},
    runtime.dependencies,
  );
  assert.equal(result.assets.length, 0);
  assert.equal(result.failures.length, 3);
  assert.equal(runtime.state.fetches.length, 1);
  assert.equal(runtime.state.workers.length, 0);
});

test('cancelling an in-flight parser terminates it without retaining a completed mesh', async () => {
  const { loadPcbComponentModels } = await loader;
  const runtime = testRuntime({ stalled: true });
  const controller = new AbortController();
  const pending = loadPcbComponentModels(
    [entry()],
    { signal: controller.signal },
    runtime.dependencies,
  );
  await runtime.state.started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(runtime.state.workers[0].terminated, true);
});

test('a parser deadline produces an explicit missing-model result and terminates the worker', async () => {
  const { loadPcbComponentModels, componentLimits } = await loader;
  const runtime = testRuntime({ stalled: true });
  const schedule = global.setTimeout;
  let expire;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === componentLimits.modelMs) {
      expire = callback;
      return schedule(() => {}, componentLimits.totalMs);
    }
    return schedule(callback, delay, ...args);
  };
  try {
    const pending = loadPcbComponentModels([entry()], {}, runtime.dependencies);
    await runtime.state.started;
    expire();
    const result = await pending;
    assert.equal(result.assets.length, 0);
    assert.match(result.failures[0].reason, /timed out/);
    assert.equal(runtime.state.workers[0].terminated, true);
  } finally {
    global.setTimeout = schedule;
  }
});
