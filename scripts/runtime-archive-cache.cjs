const fs = require('node:fs');
const path = require('node:path');

// Qualification-only cache input. This supplies archive bytes, never native
// executable paths or prepared receipts; the production installer still verifies
// the complete SHA-256, extracts/copies, checks signatures and probes versions.
function stageRuntimeArchiveCache(directory, assets, environment = process.env) {
  const sources = JSON.parse(environment.HARNESS_RUNTIME_ARCHIVES || '{}');
  const target = path.join(directory, '.runtime-assets', 'cache');
  const used = [];
  for (const asset of assets) {
    if (!['macos-app-dmg', 'macos-app-zip'].includes(asset.type)) continue;
    if (!sources[asset.id]) continue;
    const source = path.resolve(sources[asset.id]);
    if (!fs.statSync(source).isFile() || fs.statSync(source).size !== asset.size)
      throw Error(`Qualification archive size differs from the release declaration: ${asset.id}`);
    fs.mkdirSync(target, { recursive: true });
    const destination = path.join(
      target,
      `${asset.sha256}.${asset.type === 'macos-app-zip' ? 'zip' : 'dmg'}`,
    );
    if (!fs.existsSync(destination)) {
      // A distinct inode avoids sharing an already-mounted DMG's device lock.
      // APFS cloning reuses storage when supported, while preserving isolation.
      fs.copyFileSync(
        source,
        destination,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
    }
    used.push({ id: asset.id, sha256: asset.sha256, size: asset.size });
  }
  return used;
}
module.exports = { stageRuntimeArchiveCache };
