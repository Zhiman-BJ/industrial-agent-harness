const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 64,
  references: 256,
});
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const contained = (file, root) => file.startsWith(root + path.sep);

function resolveModelReference(reference, source, root) {
  if (
    typeof reference !== 'string' ||
    !reference ||
    reference.length > 2048 ||
    /[\x00-\x1f\x7f\\:]/.test(reference) ||
    path.isAbsolute(reference)
  )
    throw Error('unsupported-path');
  let base = path.dirname(source),
    relative = reference;
  const variable = /^\$\{([^}]+)\}\//.exec(reference);
  if (variable) {
    if (variable[1] === 'KIPRJMOD') base = root;
    else if (/^KICAD\d+_3DMODEL_DIR$/.test(variable[1]) || variable[1] === 'KISYS3DMOD')
      base = path.join(root, '3dmodels');
    else throw Error('unknown-variable');
    relative = reference.slice(variable[0].length);
  }
  if (!relative || /[$]/.test(relative)) throw Error('unsupported-path');
  const file = path.resolve(base, relative);
  if (!contained(file, root) || !contained(file, base)) throw Error('outside-project');
  return file;
}

function readModelSnapshot(file, root) {
  const canonical = fs.realpathSync(file);
  if (!contained(canonical, root)) throw Error('outside-project');
  const fd = fs.openSync(canonical, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !before.size || before.size > MODEL_LIMITS.fileBytes)
      throw Error('file-limit');
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw Error('model-changed');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw Error('model-changed');
    return { file: canonical, path: file, data, sha256: hash(data), size: data.length };
  } finally {
    fs.closeSync(fd);
  }
}

function prepareModelResources(references, source, root) {
  const resources = [],
    seen = new Set(),
    unique = new Map();
  let total = 0;
  for (const sourceRef of references) {
    if (seen.has(sourceRef) || resources.length >= MODEL_LIMITS.references) continue;
    seen.add(sourceRef);
    const entry = { id: 'model-' + resources.length, sourceRef, status: 'missing' };
    resources.push(entry);
    try {
      const file = resolveModelReference(sourceRef, source, root);
      const extension = path.extname(file).toLowerCase();
      if (!['.wrl', '.step', '.stp'].includes(extension)) throw Error('unsupported-format');
      entry.format = extension === '.wrl' ? 'wrl' : 'step';
      const snapshot = readModelSnapshot(file, root);
      if (!unique.has(snapshot.sha256)) {
        if (unique.size >= MODEL_LIMITS.files || total + snapshot.size > MODEL_LIMITS.totalBytes)
          throw Error('total-limit');
        unique.set(snapshot.sha256, snapshot.data);
        total += snapshot.size;
      }
      Object.assign(entry, snapshot, {
        data: unique.get(snapshot.sha256),
        status: 'ready',
        url: 'models/' + (resources.length - 1),
      });
    } catch (error) {
      entry.reason = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing-file' : error.message;
      entry.status = entry.reason === 'missing-file' ? 'missing' : 'unavailable';
    }
  }
  return resources;
}

function modelManifest(resources) {
  return resources.map(({ id, sourceRef, status, reason, format, sha256, size, url }) => ({
    id,
    sourceRef,
    status,
    reason,
    format,
    sha256,
    size,
    url,
  }));
}

function recheckModel(entry, root) {
  const current = readModelSnapshot(entry.path, root);
  return current.file === entry.file && current.sha256 === entry.sha256;
}

module.exports = {
  MODEL_LIMITS,
  resolveModelReference,
  readModelSnapshot,
  prepareModelResources,
  modelManifest,
  recheckModel,
};
