#!/usr/bin/env node
// Acquire a domain-pack container image through the release tarball channel:
// read provenance/runtime-distribution.json from the domain-pack tree, fetch
// the GitHub Release oci-archive anonymously, stream/verify sha256, validate
// OCI config/platform and load/tag the verified classic or containerd identity. Usage:
//   node scripts/acquire-container-image.cjs <pack-directory> <image> [--keep-archive]
// <image> is the lock id (industrial-chip-tools), repository[:tag] or a
// registry-prefixed reference.
const { acquireImage } = require('../packages/pack-manager/src/container-images.cjs');

const [packDirectory, image, ...rest] = process.argv.slice(2);
if (!packDirectory || !image) {
  console.error('usage: acquire-container-image.cjs <pack-directory> <image> [--keep-archive]');
  process.exit(2);
}
const controller = new AbortController();
const cancel = () => controller.abort(Error('Image acquisition cancelled.'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
acquireImage({
  packDirectory,
  image,
  keepArchive: rest.includes('--keep-archive'),
  signal: controller.signal,
})
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  });
