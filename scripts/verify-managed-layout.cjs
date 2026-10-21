const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { PackManager } = require('../packages/pack-manager/src/index.cjs');
const { describeInstalled } = require('../packages/pack-manager/src/catalog.cjs');
const { domainPacks, resolveViewerPython } = require('../packages/domain-skills');
const { RasterService } = require('../packages/viewer-builtin/src/layout/raster.cjs');
const {
  ResolvedViewerService,
  resolveViewerInterpreter,
} = require('../apps/desktop/electron/viewer-dependency.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Opt-in network diagnostic. All installation, deliberate damage and repair
// occur below a new explicit output directory; the source GDS stays read-only.
async function main() {
  const requested = process.argv[2];
  if (!requested || !path.isAbsolute(requested) || fs.existsSync(requested))
    throw Error('Usage: node scripts/verify-managed-layout.cjs <new-absolute-output-directory>');
  const contribution = domainPacks.find(pack =>
    pack.pythonEnvironments?.some(item => item.viewer === 'layout'),
  );
  assert.ok(contribution, 'the consumed immutable owner must declare layout Viewer support');
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  const output = fs.realpathSync(requested),
    bundleOutput = path.join(output, 'bundles');
  const root = path.resolve(__dirname, '..');
  const buildEnv = {
    ...process.env,
    INDUSTRIAL_HARNESS_PACK_STORE: '',
    HARNESS_PACK_CHANNEL: 'beta',
    HARNESS_PACK_DOMAINS: contribution.domain,
    HARNESS_PACK_PLATFORMS: `${process.platform}-${process.arch}`,
  };
  for (const key of [
    'HARNESS_PACK_SIGNING_KEY_FILE',
    'HARNESS_PACK_SIGNING_KEY_ID',
    'HARNESS_PACK_OMIT_CONTAINER_IMAGES',
  ])
    delete buildEnv[key];
  const built = spawnSync(
    process.execPath,
    [path.join(__dirname, 'build-pack-distribution.cjs'), bundleOutput],
    {
      env: buildEnv,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  assert.equal(built.status, 0, built.stderr || String(built.error));
  const store = path.join(output, 'store'),
    manager = new PackManager({ directory: store });
  const selected = manager
    .bundledCatalog(bundleOutput)
    .packs.find(item => item.domain === contribution.domain);
  assert.ok(selected);
  let requests = 0,
    containerCalls = 0;
  const urls = [],
    phases = [];
  manager.pythonEnvironments.fetch = async (url, options) => {
    requests++;
    const parsed = new URL(url);
    urls.push(parsed.origin + parsed.pathname); // Never retain signed redirect query tokens.
    return fetch(url, options);
  };
  for (const method of ['preflight', 'ensure']) {
    const original = manager.containerImages[method].bind(manager.containerImages);
    manager.containerImages[method] = (...args) => {
      containerCalls++;
      return original(...args);
    };
  }
  const start = performance.now();
  const installed = await manager.install(selected, {
    prepareRuntime: true,
    runtimeScope: 'viewer',
    onProgress: item => {
      if (phases.at(-1) !== item.phase) phases.push(item.phase);
    },
  });
  const coldMs = performance.now() - start;
  assert.equal(
    containerCalls,
    0,
    'Viewer-only installation must not preflight or prepare containers',
  );
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = store;
  const readiness = describeInstalled(manager, installed);
  assert.equal(readiness.viewerState, 'ready');
  assert.notEqual(
    readiness.runtimeState,
    'ready',
    'Viewer readiness must not certify engineering dependencies',
  );
  const declaration = installed.pythonEnvironments.find(item => item.viewer === 'layout');
  const python = resolveViewerPython(installed.domain, 'layout');
  assert.ok(python && python.startsWith(manager.pythonEnvironments.directory + path.sep));
  let resolutions = 0;
  const host = new ResolvedViewerService(
    () => {
      resolutions++;
      return resolveViewerInterpreter({
        resolveManaged: () => resolveViewerPython(installed.domain, 'layout'),
        allowLegacy: false,
        unavailableMessage: 'Managed Viewer is unavailable.',
      });
    },
    interpreter => new RasterService(interpreter),
  );
  const source = path.join(root, 'examples/chip-sobel/outputs/sobel_layout.gds');
  const sourceSha256 = digest(fs.readFileSync(source));
  let loaded, png;
  try {
    const renderer = host.get(true);
    loaded = await renderer.call({ op: 'load', path: source, token: 'managed-sobel' });
    const rendered = await renderer.call({
      op: 'render',
      token: 'managed-sobel',
      box: loaded.bbox,
      width: 1200,
      height: 800,
      visible: loaded.layers.map(layer => layer.key),
      quality: 'fine',
    });
    png = Buffer.from(rendered.png, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    fs.writeFileSync(path.join(output, 'sobel-managed.png'), png);
    for (let i = 0; i < 50; i++) assert.equal(host.get(), renderer);
    assert.equal(resolutions, 1, 'continuous rendering must not rescan installed Packs');
  } finally {
    host.close();
  }
  assert.equal(manager.pythonEnvironments.status([declaration])[0].ready, true);
  let offlineRequests = 0;
  manager.pythonEnvironments.fetch = async () => {
    offlineRequests++;
    throw Error('Offline diagnostic');
  };
  const warmStart = performance.now();
  await manager.prepareRuntime(manager.list()[0], { scope: 'viewer', recheck: true });
  const warmMs = performance.now() - warmStart;
  const environment = manager.pythonEnvironments.location(declaration);
  const receipt = JSON.parse(fs.readFileSync(path.join(environment, 'receipt.json')));
  const extension = receipt.files.find(
    item =>
      item.type === 'file' && item.path.includes('/klayout/') && /\.(?:so|pyd)$/.test(item.path),
  );
  assert.ok(extension, 'the real installed wheel must contain its compiled module');
  fs.unlinkSync(path.join(environment, ...extension.path.split('/')));
  // A fresh open must detect nested damage without a status query clearing a cache first.
  assert.equal(resolveViewerPython(installed.domain, 'layout'), undefined);
  assert.equal(describeInstalled(manager, manager.list()[0]).viewerState, 'needs-preparation');
  const repairStart = performance.now();
  await manager.prepareRuntime(manager.list()[0], { scope: 'viewer', recheck: true });
  const repairMs = performance.now() - repairStart;
  assert.equal(describeInstalled(manager, manager.list()[0]).viewerState, 'ready');
  assert.equal(offlineRequests, 0, 'verified cache must support offline recheck and repair');
  assert.equal(containerCalls, 0);
  assert.equal(digest(fs.readFileSync(source)), sourceSha256);
  const report = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    scope:
      'real official downloads, production bundle/installer/resolver/worker, CPU GDS rendering and offline repair; no native GUI or engineering acceptance',
    platform: `${process.platform}-${process.arch}`,
    owner: require('@zhiman-bj/industrial-domain-packs').identity,
    domain: installed.domain,
    packVersion: installed.version,
    pythonVersion: declaration.pythonVersion,
    klayoutVersion: declaration.version,
    requests,
    urls,
    phases,
    containerCalls,
    coldMs: +coldMs.toFixed(2),
    warmMs: +warmMs.toFixed(2),
    repairMs: +repairMs.toFixed(2),
    sourceSha256,
    sourceUnchanged: true,
    cell: loaded.cell,
    layers: loaded.layers.length,
    png: {
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      sha256: digest(png),
      bytes: png.length,
    },
    repeatedRenderResolutions: resolutions,
    offlineRequests,
    freshResolutionDetectedDamage: true,
    damagedModuleRepaired: true,
    ok: true,
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
