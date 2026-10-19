const fs = require('node:fs');
const path = require('node:path');
const { readBounded, utf8 } = require('./read.cjs');

// A portable display index, not engineering verification. Treat every field as
// untrusted and keep reads within this result's directory and the project.
function readArtifactBundle(file, root, sourceHash) {
  const directory = fs.realpathSync(path.dirname(file));
  const indexFile = path.join(directory, 'artifact-bundle.json');
  if (!fs.existsSync(indexFile)) return null;
  const index = readBounded(indexFile, root, null, 64 * 1024);
  const data = JSON.parse(utf8(index.bytes));
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(data.artifacts) ||
    !data.artifacts.length ||
    data.artifacts.length > 64
  )
    throw Error('Invalid artifact bundle.');
  const names = new Set();
  for (const item of data.artifacts) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(item.name || '') ||
      names.has(item.name.toLowerCase()) ||
      typeof item.kind !== 'string' ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(item.kind) ||
      !/^[a-f0-9]{64}$/.test(item.sha256 || '') ||
      !Number.isSafeInteger(item.sizeBytes) ||
      item.sizeBytes < 0 ||
      item.sizeBytes > 128 * 1048576
    )
      throw Error('Invalid artifact bundle entry.');
    names.add(item.name.toLowerCase());
  }
  if (!data.artifacts.some(item => item.name === path.basename(file) && item.sha256 === sourceHash))
    throw Error('Artifact bundle source changed.');
  return {
    entries: data.artifacts,
    read(item, limit) {
      const target = path.join(directory, item.name);
      if (path.dirname(fs.realpathSync(target)) !== directory)
        throw Error('Artifact bundle companion is outside the result directory.');
      const result = readBounded(target, root, item.sha256, Math.min(limit, item.sizeBytes));
      if (result.bytes.length !== item.sizeBytes) throw Error('Artifact bundle size changed.');
      return { ...result, file: target };
    },
    assertUnchanged() {
      readBounded(indexFile, root, index.sha256, 64 * 1024);
    },
  };
}
module.exports = { readArtifactBundle };
