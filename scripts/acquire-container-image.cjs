#!/usr/bin/env node
// Acquire a domain-pack container image through the release tarball channel:
// read provenance/runtime-distribution.json from the domain-pack tree, fetch
// the GitHub Release oci-archive anonymously, verify sha256, `docker load`
// and confirm the config digest. Usage:
//   node scripts/acquire-container-image.cjs <pack-directory> <image> [--keep-archive]
// <image> is the lock id (industrial-chip-tools), repository[:tag] or a
// registry-prefixed reference.
const { acquireImage } = require('../packages/pack-manager/src/container-images.cjs');

const [packDirectory, image, ...rest] = process.argv.slice(2);
if (!packDirectory || !image) {
  console.error('usage: acquire-container-image.cjs <pack-directory> <image> [--keep-archive]');
  process.exit(2);
}
acquireImage({ packDirectory, image, keepArchive: rest.includes('--keep-archive') })
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
