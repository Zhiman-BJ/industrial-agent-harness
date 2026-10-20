const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  validateDataLibrary,
  validateDataCatalog,
  DEFAULT_DATA_LIBRARY_LIMITS,
} = require('./data-libraries.cjs');

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCES = 256;
const SHA = /^[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function hasControl(value, includeSpace = false) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= (includeSpace ? 32 : 31) || code === 127) return true;
  }
  return false;
}

function safeCatalogPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    /[\\:%?#]/.test(value) ||
    hasControl(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..') ||
    path.posix.normalize(value) !== value
  )
    throw Error('Unsafe data library catalog path.');
  return value;
}

function validateDataLibraries(libraries = []) {
  if (!Array.isArray(libraries) || libraries.length > 16)
    throw Error('Invalid data library declarations.');
  const ids = new Set(),
    prefixes = [];
  for (const library of libraries) {
    validateDataLibrary(library);
    safeCatalogPath(library.catalog);
    if (
      ids.has(library.id) ||
      typeof library.label !== 'string' ||
      !library.label.trim() ||
      library.label.length > 200 ||
      !SHA.test(library.catalogSha256 || '') ||
      !Array.isArray(library.referencePrefixes) ||
      !library.referencePrefixes.length ||
      library.referencePrefixes.length > 64
    )
      throw Error('Invalid or duplicate data library declaration.');
    ids.add(library.id);
    for (const prefix of library.referencePrefixes) {
      if (
        typeof prefix !== 'string' ||
        !prefix ||
        prefix.length > 512 ||
        !prefix.endsWith('/') ||
        prefix.includes('\\') ||
        hasControl(prefix, true) ||
        prefixes.some(other => other.startsWith(prefix) || prefix.startsWith(other))
      )
        throw Error('Invalid or ambiguous data library reference prefix.');
      prefixes.push(prefix);
    }
  }
  return libraries;
}

function readCatalogBytes(directory, relative) {
  const root = fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) throw Error('Data library owner must be a directory.');
  let file = root;
  for (const segment of safeCatalogPath(relative).split('/')) {
    file = path.join(file, segment);
    if (fs.lstatSync(file).isSymbolicLink())
      throw Error('Data library catalogs cannot contain symbolic links.');
  }
  if (!fs.realpathSync(file).startsWith(root + path.sep))
    throw Error('Data library catalog is outside its owner.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !before.size || before.size > MAX_CATALOG_BYTES)
      throw Error('Data library catalog exceeds its size limit.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('Data library catalog changed while reading.');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error('Data library catalog changed while reading.');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

// Callers supply declarations from a verified Pack or the pinned owner package.
// Never discover catalogs through project files, environment roots, or parent
// directory searches. Archive decoding supplies already verified file bytes.
function readDataLibraryBindings(libraries = [], { directory, files } = {}) {
  validateDataLibraries(libraries);
  return libraries.map(library => {
    const bytes = files
      ? files.find(file => file.path === library.catalog)?.bytes
      : readCatalogBytes(directory, library.catalog);
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > MAX_CATALOG_BYTES ||
      hash(bytes) !== library.catalogSha256
    )
      throw Error('Data library catalog is missing or its digest differs.');
    const catalog = validateDataCatalog(JSON.parse(bytes.toString('utf8')), library);
    if (
      typeof catalog.source?.revision !== 'string' ||
      !catalog.source.revision ||
      catalog.source.revision.length > 256 ||
      typeof catalog.license?.spdx !== 'string' ||
      !catalog.license.spdx ||
      catalog.license.spdx.length > 200 ||
      typeof catalog.license.url !== 'string'
    )
      throw Error('Data library catalog requires source and license provenance.');
    const licenseUrl = new URL(catalog.license.url);
    if (licenseUrl.protocol !== 'https:' || licenseUrl.username || licenseUrl.password)
      throw Error('Invalid data library license URL.');
    return { library: { ...library, referencePrefixes: [...library.referencePrefixes] }, catalog };
  });
}

function limitsFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid data library registry limits.');
  const limits = { ...DEFAULT_DATA_LIBRARY_LIMITS };
  for (const [name, value] of Object.entries(input)) {
    if (
      !Object.hasOwn(limits, name) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > limits[name]
    )
      throw Error('Data library registry limits may only reduce the default budget.');
    limits[name] = value;
  }
  return limits;
}

function verifyExpectedPlan(current, options) {
  const { expectedResources, expectedLibraries } = options;
  if (expectedResources === undefined && expectedLibraries === undefined) return;
  const changed = () => {
    throw Error('Component model download plan changed. Reopen the document.');
  };
  if (!Array.isArray(expectedResources) || !Array.isArray(expectedLibraries)) changed();
  const resourceFields = ['sourceRef', 'sha256', 'size', 'libraryId', 'version'];
  const libraryFields = [
    'id',
    'version',
    'catalogSha256',
    'revision',
    'origin',
    'license',
    'label',
  ];
  const index = (entries, key) => {
    const result = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) changed();
      const identity = key(entry);
      if (result.has(identity)) changed();
      result.set(identity, entry);
    }
    return result;
  };
  const libraryKey = entry => JSON.stringify([entry.id, entry.version]);
  const resources = index(expectedResources, entry => entry.sourceRef);
  const libraries = index(expectedLibraries, libraryKey);
  const matches = (actual, expected, fields) =>
    expected &&
    isDeepStrictEqual(
      fields.map(field => actual[field]),
      fields.map(field => expected[field]),
    );
  for (const resource of current.resources) {
    if (!matches(resource, resources.get(resource.sourceRef), resourceFields)) changed();
  }
  for (const library of current.summary.libraries) {
    if (!matches(library, libraries.get(libraryKey(library)), libraryFields)) changed();
  }
  // Expected entries outside this request may already be ready. An entry in
  // this request that disappeared from the approved plan must not be ignored.
  if (current.unavailable.some(entry => resources.has(entry.sourceRef))) changed();
}

class DataLibraryRegistry {
  constructor({ manager, libraries } = {}) {
    if (
      !manager ||
      typeof manager.resolve !== 'function' ||
      typeof manager.ensure !== 'function' ||
      typeof manager.directory !== 'string' ||
      typeof libraries !== 'function'
    )
      throw Error('Data library registry requires a manager and trusted library provider.');
    this.manager = manager;
    this.libraries = libraries;
  }

  selection(context, options = {}) {
    if (
      !context ||
      !SHA.test(context.sha256 || '') ||
      typeof context.source !== 'string' ||
      !path.isAbsolute(context.source) ||
      typeof context.root !== 'string' ||
      !path.isAbsolute(context.root) ||
      !context.source.startsWith(
        context.root.endsWith(path.sep) ? context.root : context.root + path.sep,
      ) ||
      !(Array.isArray(context.references) || context.references instanceof Set)
    )
      throw Error('Invalid project data library context.');
    const references = [...context.references];
    if (
      references.length > MAX_REFERENCES ||
      references.some(ref => typeof ref !== 'string' || !ref || ref.length > 2048)
    )
      throw Error('Invalid data library reference selection.');
    const bindings = this.libraries();
    if (!Array.isArray(bindings)) throw Error('Invalid trusted data library bindings.');
    validateDataLibraries(bindings.map(binding => binding.library));
    const groups = bindings.map(({ library, catalog }) => {
      validateDataCatalog(catalog, library);
      return {
        library,
        catalog,
        byPath: new Map(catalog.files.map(file => [file.path, file])),
        selected: [],
      };
    });
    const limits = limitsFor(options.limits);
    const hashes = new Map();
    const unavailable = [];
    let totalBytes = 0;
    for (const sourceRef of new Set(references)) {
      const group = groups.find(item =>
        item.library.referencePrefixes.some(prefix => sourceRef.startsWith(prefix)),
      );
      if (!group) {
        unavailable.push({ sourceRef, reason: 'unmatched-reference' });
        continue;
      }
      const prefix = group.library.referencePrefixes.find(value => sourceRef.startsWith(value));
      const catalogPath = sourceRef.slice(prefix.length);
      const entry = group.byPath.get(catalogPath);
      if (!entry) {
        unavailable.push({ sourceRef, reason: 'not-in-catalog' });
        continue;
      }
      if (hashes.has(entry.sha256) && hashes.get(entry.sha256) !== entry.size)
        throw Error('Data library content identity has conflicting sizes.');
      const extra = hashes.has(entry.sha256) ? 0 : entry.size;
      if (
        entry.size > limits.fileBytes ||
        (!hashes.has(entry.sha256) && hashes.size >= limits.files) ||
        totalBytes + extra > limits.totalBytes
      ) {
        unavailable.push({ sourceRef, reason: 'preview-budget' });
        continue;
      }
      hashes.set(entry.sha256, entry.size);
      totalBytes += extra;
      group.selected.push({ sourceRef, ...entry });
    }
    return { groups: groups.filter(group => group.selected.length), unavailable, limits };
  }

  requestedPaths(group) {
    // One verified content object can satisfy several declared paths and aliases.
    return [...new Map(group.selected.map(entry => [entry.sha256, entry.path])).values()];
  }

  result(selection, includeMissing) {
    const resources = [],
      needed = new Map(),
      libraries = [];
    for (const group of selection.groups) {
      const resolved = this.manager.resolve(
        group.library,
        group.catalog,
        this.requestedPaths(group),
        {
          limits: selection.limits,
        },
      );
      const cached = new Map(resolved.files.map(file => [file.sha256, file]));
      libraries.push({
        id: group.library.id,
        version: group.library.version,
        label: group.library.label,
        origin: new URL(group.library.baseUrl).origin,
        license: structuredClone(group.catalog.license),
        catalogSha256: group.library.catalogSha256,
        revision: group.catalog.source?.revision,
      });
      for (const entry of group.selected) {
        const ready = cached.get(entry.sha256);
        if (!ready) needed.set(entry.sha256, entry.size);
        if (!ready && !includeMissing) continue;
        resources.push({
          sourceRef: entry.sourceRef,
          catalogPath: entry.path,
          sha256: entry.sha256,
          size: entry.size,
          libraryId: group.library.id,
          version: group.library.version,
          cached: Boolean(ready),
          ...(ready ? { path: ready.file, root: this.manager.directory } : {}),
        });
      }
    }
    return {
      resources,
      summary: {
        downloadFiles: needed.size,
        downloadBytes: [...needed.values()].reduce((sum, value) => sum + value, 0),
        unavailableFiles: selection.unavailable.length,
        libraries,
      },
      unavailable: selection.unavailable,
    };
  }

  resolve(context, options = {}) {
    return this.result(this.selection(context, options), false);
  }

  plan(context, options = {}) {
    return this.result(this.selection(context, options), true);
  }

  async ensure(context, options = {}) {
    options.signal?.throwIfAborted();
    const selection = this.selection(context, options);
    if (options.expectedResources !== undefined || options.expectedLibraries !== undefined)
      verifyExpectedPlan(this.result(selection, true), options);
    for (const group of selection.groups) {
      options.signal?.throwIfAborted();
      await this.manager.ensure(group.library, group.catalog, this.requestedPaths(group), {
        signal: options.signal,
        onProgress: options.onProgress,
        offline: options.offline,
        limits: selection.limits,
      });
    }
    options.signal?.throwIfAborted();
    return this.result(selection, false);
  }
}

module.exports = {
  DataLibraryRegistry,
  validateDataLibraries,
  readDataLibraryBindings,
};
