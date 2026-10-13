const fs = require('node:fs');
const path = require('node:path');
const {
  RuntimeAssetManager,
  validateRuntimeAssets,
} = require('../../../packages/pack-manager/src/runtime-assets.cjs');
const { prepareArchives } = require('../../../scripts/prepare-ci-runtime-archives.cjs');

const applications = {
  freecad: ['HARNESS_FREECAD_APP_PATH', '/Applications/FreeCAD.app'],
  kicad: ['HARNESS_KICAD_APP_PATH', '/Applications/KiCad/KiCad.app'],
  godot: ['HARNESS_GODOT_APP_PATH', '/Applications/Godot.app'],
};
function canonical(file) {
  if (fs.existsSync(file)) return fs.realpathSync(file);
  const parent = path.dirname(file);
  if (parent === file) throw Error('Cannot resolve fixture directory.');
  return path.join(canonical(parent), path.basename(file));
}
function outside(file, store) {
  const candidate = canonical(path.resolve(file));
  const root = canonical(path.resolve(store));
  if (candidate === root || candidate.startsWith(root + path.sep))
    throw Error('Native application prerequisite must be outside the product Pack store.');
  return candidate;
}

// Test prerequisite only: reuse the maintained extraction/signature/version
// implementation in a separate fixture store. Its receipt is never installed in
// the product store; the product later performs ordinary external association.
// No URL fallback is possible, including if input changes after initial hashing.
async function prepareNativeApplication({
  asset,
  packStore,
  directory,
  environment = process.env,
  command,
  platform,
  defaultApplication,
}) {
  validateRuntimeAssets([asset]);
  if (!['macos-app-dmg', 'macos-app-zip'].includes(asset.type) || !applications[asset.id])
    throw Error('Unsupported native application prerequisite.');
  const [variable, defaultApp] = applications[asset.id];
  const fallback = defaultApplication || defaultApp;
  const selected = environment[variable] || (fs.existsSync(fallback) ? fallback : null);
  if (selected) {
    const app = outside(fs.realpathSync(selected), packStore);
    if (!fs.statSync(app).isDirectory()) throw Error('External application must be a directory.');
    return app;
  }
  const sources = JSON.parse(environment.HARNESS_RUNTIME_ARCHIVES || '{}');
  const input =
    sources[asset.id] || (asset.id === 'freecad' && environment.HARNESS_FREECAD_ARCHIVE);
  if (typeof input !== 'string' || !input)
    throw Error(
      `Provide ${variable} or an explicit local archive for ${asset.id}; fixture downloads are disabled.`,
    );
  const archive = fs.realpathSync(input);
  await prepareArchives([{ ...asset, file: archive }], { download: false });
  const root = outside(directory, packStore);
  fs.mkdirSync(root, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, asset.id + '-'));
  const maintenance = new RuntimeAssetManager({
    directory: fixture,
    ...(command ? { command } : {}),
    ...(platform ? { platform } : {}),
    fetchArchive: async () => {
      throw Error('Offline native fixture cannot download archives.');
    },
  });
  // On failure, the maintained extractor detaches mounts and removes staging;
  // retain its cache and diagnostics, including any detach failure.
  const cache = path.join(maintenance.directory, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const local = path.join(
    cache,
    asset.sha256 + (asset.type === 'macos-app-dmg' ? '.dmg' : '.zip'),
  );
  fs.copyFileSync(archive, local, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  await prepareArchives([{ ...asset, file: local }], { download: false });
  const [status] = await maintenance.ensure([asset]);
  if (!status.ready) throw Error('Offline native fixture did not pass its identity checks.');
  return outside(path.join(maintenance.location(asset), asset.app), packStore);
}
module.exports = { prepareNativeApplication };
