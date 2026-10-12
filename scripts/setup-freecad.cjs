#!/usr/bin/env node
// Compatibility native CI mount; the maintained owner declares the Harbor bytes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { archiveDeclarations, prepareArchives } = require('./prepare-ci-runtime-archives.cjs');
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('FreeCAD native acceptance currently requires macOS arm64.');
  const root = path.resolve(process.argv[2] || 'dist/freecad-runtime');
  fs.mkdirSync(root, { recursive: true });
  const declared = archiveDeclarations(path.dirname(root)).find(asset => asset.id === 'freecad');
  const asset = { ...declared, file: path.join(root, path.basename(declared.file)) };
  const { freecad: dmg } = await prepareArchives([asset], { download: true });
  const mount = path.join(root, 'mount');
  const command = path.join(mount, 'FreeCAD.app/Contents/Resources/bin/freecadcmd');
  if (!fs.existsSync(command)) {
    const result = spawnSync(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg],
      { stdio: 'inherit' },
    );
    if (result.error || result.status !== 0)
      throw result.error || Error('FreeCAD disk-image mount failed.');
  }
  if (!fs.existsSync(command)) throw Error('Pinned FreeCAD executable is missing.');
  fs.writeFileSync(
    path.join(root, 'provenance.json'),
    JSON.stringify(
      {
        version: asset.version,
        url: asset.url,
        upstreamUrl: asset.upstreamUrl,
        sha256: asset.sha256,
        command,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_ENV)
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `INDUSTRIAL_HARNESS_FREECAD_CMD=${command}\nHARNESS_FREECAD_ARCHIVE=${dmg}\n`,
    );
  console.log(command);
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
