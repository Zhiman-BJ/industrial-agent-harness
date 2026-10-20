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

function hasControl(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
const reasonFor = error =>
  ['ENOENT', 'ENOTDIR'].includes(error.code)
    ? 'missing-file'
    : [
          'outside-project',
          'file-limit',
          'total-limit',
          'model-changed',
          'invalid-resource',
          'unsupported-path',
          'unsupported-format',
          'unknown-variable',
          'invalid-resource-root',
          'resource-integrity',
        ].includes(error.message)
      ? error.message
      : 'resource-unavailable';

function resolveModelReference(reference, source, root) {
  if (
    typeof reference !== 'string' ||
    !reference ||
    reference.length > 2048 ||
    /[\\:]/.test(reference) ||
    hasControl(reference) ||
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
    const current = fs.statSync(canonical);
    if (
      fs.realpathSync(file) !== canonical ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      throw Error('model-changed');
    return { file: canonical, path: file, data, sha256: hash(data), size: data.length };
  } finally {
    fs.closeSync(fd);
  }
}

function prepareModelResources(references, source, root, approvedResources = []) {
  const resources = [],
    seen = new Set(),
    unique = new Map(),
    approved = new Map();
  for (const resource of Array.isArray(approvedResources)
    ? approvedResources.slice(0, MODEL_LIMITS.references)
    : []) {
    if (typeof resource?.sourceRef !== 'string') continue;
    if (approved.has(resource.sourceRef)) approved.set(resource.sourceRef, null);
    else approved.set(resource.sourceRef, resource);
  }
  let total = 0;
  const include = (entry, snapshot) => {
    if (!unique.has(snapshot.sha256)) {
      if (unique.size >= MODEL_LIMITS.files || total + snapshot.size > MODEL_LIMITS.totalBytes)
        throw Error('total-limit');
      unique.set(snapshot.sha256, snapshot.data);
      total += snapshot.size;
    }
    Object.assign(entry, snapshot, {
      data: unique.get(snapshot.sha256),
      status: 'ready',
      url: 'models/' + resources.indexOf(entry),
    });
  };
  // Load every project-local model first. A missing reference can subsequently
  // use an exact mapping supplied by the trusted host's read-only provider.
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
      include(entry, snapshot);
    } catch (error) {
      entry.reason = reasonFor(error);
      entry.status = entry.reason === 'missing-file' ? 'missing' : 'unavailable';
    }
  }
  for (const entry of resources) {
    if (entry.status !== 'missing' || !approved.has(entry.sourceRef)) continue;
    try {
      const resource = approved.get(entry.sourceRef);
      if (
        !resource ||
        typeof resource.path !== 'string' ||
        !path.isAbsolute(resource.path) ||
        typeof resource.root !== 'string' ||
        !path.isAbsolute(resource.root) ||
        typeof resource.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(resource.sha256) ||
        !Number.isSafeInteger(resource.size) ||
        resource.size <= 0 ||
        resource.size > MODEL_LIMITS.fileBytes ||
        ![resource.libraryId, resource.version].every(
          value =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 200 &&
            !hasControl(value),
        )
      )
        throw Error('invalid-resource');
      // Content-addressed cache filenames are bare hashes. The parser format
      // comes from the exact source reference, never the host cache pathname.
      const format = resource.format ?? entry.format;
      if (!['wrl', 'step'].includes(format) || format !== entry.format)
        throw Error('unsupported-format');
      if (resource.catalogPath !== undefined) {
        if (typeof resource.catalogPath !== 'string') throw Error('unsupported-format');
        const extension = path.extname(resource.catalogPath).toLowerCase();
        if (
          !['.wrl', '.step', '.stp'].includes(extension) ||
          (extension === '.wrl' ? 'wrl' : 'step') !== format
        )
          throw Error('unsupported-format');
      }
      const resourceRoot = fs.realpathSync(resource.root);
      if (!fs.statSync(resourceRoot).isDirectory()) throw Error('invalid-resource-root');
      const snapshot = readModelSnapshot(resource.path, resourceRoot);
      if (snapshot.sha256 !== resource.sha256.toLowerCase() || snapshot.size !== resource.size)
        throw Error('resource-integrity');
      include(entry, snapshot);
      Object.assign(entry, {
        resourceRoot,
        libraryId: resource.libraryId,
        version: resource.version,
        format,
      });
      delete entry.reason;
    } catch (error) {
      entry.reason = reasonFor(error);
      entry.status = entry.reason === 'missing-file' ? 'missing' : 'unavailable';
    }
  }
  return resources;
}

function modelManifest(resources) {
  return resources.map(
    ({ id, sourceRef, status, reason, format, sha256, size, url, libraryId, version }) => ({
      id,
      sourceRef,
      status,
      reason,
      format,
      sha256,
      size,
      url,
      libraryId,
      version,
    }),
  );
}

function recheckModel(entry, root) {
  const current = readModelSnapshot(entry.path, entry.resourceRoot || root);
  return (
    current.file === entry.file && current.sha256 === entry.sha256 && current.size === entry.size
  );
}

module.exports = {
  MODEL_LIMITS,
  resolveModelReference,
  readModelSnapshot,
  prepareModelResources,
  modelManifest,
  recheckModel,
};
