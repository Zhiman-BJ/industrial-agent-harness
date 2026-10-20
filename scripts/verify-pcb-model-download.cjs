const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { DataLibraryManager } = require('../packages/pack-manager/src/data-libraries.cjs');
const { DataLibraryRegistry } = require('../packages/pack-manager/src/data-library-registry.cjs');
const { installedDataLibraries } = require('../packages/domain-skills');
const { KiCadRuntimeManager } = require('../packages/viewer-builtin/src/kicad/runtime.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// This opt-in network diagnostic writes only below its explicit output directory.
// It uses the installed immutable Pack catalog; unit/CI tests remain offline.
async function main() {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory))
    throw Error('Usage: node scripts/verify-pcb-model-download.cjs <absolute-output-directory>');
  fs.mkdirSync(directory, { recursive: true });
  const output = fs.realpathSync(directory);
  const bindings = installedDataLibraries('pcb');
  const binding = bindings.find(item => item.library.id === 'kicad-3d');
  assert.ok(binding, 'the consumed PCB Pack must declare its official model library');
  const paths = [
    'Resistor_SMD.3dshapes/R_0603_1608Metric.step',
    'Capacitor_SMD.3dshapes/C_0603_1608Metric.step',
  ];
  for (const file of paths) assert.ok(binding.catalog.files.some(entry => entry.path === file));
  const prefix = binding.library.referencePrefixes.find(value => value.includes('KICAD10_'));
  assert.ok(prefix);
  const references = paths.map(file => prefix + file);
  const project = path.join(output, 'project');
  fs.mkdirSync(project, { recursive: true });
  const source = path.join(project, 'official-step-contract.kicad_pcb');
  const text =
    '(kicad_pcb (version 20240108) (generator pcbnew) ' +
    references
      .map(
        (reference, index) =>
          '(footprint "Contract:ExplicitModel" (layer "' +
          (index ? 'B.Cu' : 'F.Cu') +
          '") ' +
          '(at ' +
          (10 + index * 5) +
          ' 10 ' +
          (index ? 90 : 0) +
          ') ' +
          '(model ' +
          JSON.stringify(reference) +
          ' (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))',
      )
      .join(' ') +
    ')\n';
  fs.writeFileSync(source, text);
  const sha256 = digest(Buffer.from(text));
  let requests = 0;
  const urls = [];
  const manager = new DataLibraryManager({
    directory: path.join(output, 'cache-' + crypto.randomUUID()),
    fetch: async (url, options) => {
      requests++;
      urls.push(url);
      return fetch(url, options);
    },
  });
  const provider = new DataLibraryRegistry({ manager, libraries: () => [binding] });
  const runtime = new KiCadRuntimeManager({ modelProvider: provider });
  const start = performance.now();
  const opened = await runtime.open(source, sha256, project);
  assert.equal(requests, 0, 'opening a board must never download');
  assert.equal(opened.modelDownloads.downloadFiles, 2);
  const prepared = await runtime.prepareModels(opened.token);
  assert.equal(prepared.modelDownloads.downloadFiles, 0);
  assert.equal(requests, 2);
  const coldMs = performance.now() - start;
  const manifestResponse = await runtime.handle(
    new Request(opened.url.replace('index.html', 'manifest.json')),
  );
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.models.length, 2);
  assert.ok(
    manifest.models.every(
      model => model.status === 'ready' && model.libraryId === binding.library.id,
    ),
  );
  assert.ok(!JSON.stringify(manifest).includes(output), 'manifest must not reveal host paths');
  const vendor = path.resolve(__dirname, '../packages/viewer-builtin/src/kicad/vendor/occt-import');
  const wasmSource = fs.readFileSync(path.resolve(vendor, '../../component-wasm.js'), 'utf8');
  const { boundPcbStepWasm } = await import(
    'data:text/javascript;base64,' + Buffer.from(wasmSource).toString('base64')
  );
  const wasm = await boundPcbStepWasm(fs.readFileSync(path.join(vendor, 'occt-import-js.wasm')));
  const occt = await require(path.join(vendor, 'occt-import-js.js'))({
    wasmBinary: wasm,
    print() {},
    printErr() {},
  });
  const models = [];
  for (const model of manifest.models) {
    const response = await runtime.handle(new Request(new URL(model.url, opened.url)));
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(digest(bytes), model.sha256);
    const parseStart = performance.now();
    const parsed = occt.ReadStepFile(bytes, { linearUnit: 'millimeter' });
    assert.equal(parsed.success, true);
    const triangles = parsed.meshes.reduce((sum, mesh) => sum + mesh.index.array.length / 3, 0);
    assert.ok(triangles > 0);
    models.push({
      sourceRef: model.sourceRef,
      sha256: model.sha256,
      size: bytes.length,
      triangles,
      parseMs: +(performance.now() - parseStart).toFixed(2),
    });
  }
  let offlineRequests = 0;
  const offlineManager = new DataLibraryManager({
    directory: manager.directory,
    fetch: async () => {
      offlineRequests++;
      throw Error('offline');
    },
  });
  const offlineProvider = new DataLibraryRegistry({
    manager: offlineManager,
    libraries: () => [binding],
  });
  const offlineRuntime = new KiCadRuntimeManager({ modelProvider: offlineProvider });
  const warmStart = performance.now();
  const warm = await offlineRuntime.open(source, sha256, project);
  assert.equal(warm.modelDownloads.downloadFiles, 0);
  await offlineRuntime.prepareModels(warm.token);
  assert.equal(offlineRequests, 0, 'warm cache must work without a network request');
  const warmMs = performance.now() - warmStart;
  const context = { references, source, root: project, sha256 };
  const first = provider.resolve(context).resources[0];
  fs.writeFileSync(first.path, Buffer.from('corrupted'));
  assert.equal(provider.plan(context).summary.downloadFiles, 1);
  const repairStart = performance.now();
  await provider.ensure(context);
  assert.equal(requests, 3, 'only the corrupted resource is repaired');
  assert.equal(provider.plan(context).summary.downloadFiles, 0);
  const repairMs = performance.now() - repairStart;
  assert.equal(
    digest(fs.readFileSync(source)),
    sha256,
    'all operations must leave source unchanged',
  );
  fs.appendFileSync(source, '\n');
  assert.equal(
    (await runtime.handle(new Request(opened.url.replace('index.html', 'manifest.json')))).status,
    409,
  );
  await assert.rejects(runtime.prepareModels(opened.token), /changed/);
  runtime.close();
  offlineRuntime.close();
  const report = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    scope:
      'real official HTTPS + Pack catalog + cache + Viewer runtime + CPU STEP parser; no GPU or engineering acceptance',
    library: {
      id: binding.library.id,
      version: binding.library.version,
      catalogSha256: binding.library.catalogSha256,
      source: binding.catalog.source,
    },
    modelFiles: models,
    networkRequests: requests,
    urls,
    openNetworkRequests: 0,
    offlineNetworkRequests: offlineRequests,
    coldDownloadAndOpenMs: +coldMs.toFixed(2),
    warmOfflineOpenMs: +warmMs.toFixed(2),
    repairMs: +repairMs.toFixed(2),
    sourceUnchangedBeforeMutation: true,
    changedSourceRejected: true,
    hostPathsAbsentFromManifest: true,
    ok: true,
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
