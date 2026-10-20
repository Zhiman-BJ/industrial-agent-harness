const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  MODEL_LIMITS,
  prepareModelResources,
  modelManifest,
  recheckModel,
} = require('./model-resources.cjs');

const limits = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 32,
  depth: 128,
  // The official four-layer video demo has 1.07M tokens in 5.8MB. Bound
  // source parsing separately from the 3D renderer's primitive/vertex budgets.
  tokens: 1250000,
  sessions: 16,
  sessionBytes: 256 * 1024 * 1024,
});
class SessionLimitError extends Error {}
const snapshotBytes = (sources, models = []) =>
  [...new Set([...sources, ...models].map(entry => entry.data).filter(Boolean))].reduce(
    (total, data) => total + data.length,
    0,
  );
function jsonSnapshot(value, maximumBytes = 16384) {
  let nodes = 0;
  const active = new Set();
  const copy = (item, depth) => {
    if (++nodes > 4096 || depth > 16) throw Error('Invalid resource provenance.');
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return item;
    if (typeof item === 'string' && item.length <= maximumBytes) return item;
    if (
      !item ||
      typeof item !== 'object' ||
      active.has(item) ||
      (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
    )
      throw Error('Invalid resource provenance.');
    active.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Object.keys(item).sort();
    if (keys.length > 2048 || keys.some(key => !Object.hasOwn(descriptors[key], 'value')))
      throw Error('Invalid resource provenance.');
    const output = Array.isArray(item)
      ? item.map((_, index) => copy(descriptors[index].value, depth + 1))
      : Object.fromEntries(keys.map(key => [key, copy(descriptors[key].value, depth + 1)]));
    active.delete(item);
    return output;
  };
  const data = JSON.stringify(copy(value, 0));
  if (Buffer.byteLength(data) > maximumBytes) throw Error('Invalid resource provenance.');
  return JSON.parse(data);
}
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function hasControl(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
const isKiCadFile = file => ['.kicad_pcb', '.kicad_sch'].includes(path.extname(file));

// Only inspect structure and sheet references here. KiCanvas owns CAD parsing/rendering.
function inspectSource(text, extension, modelReferences) {
  const expected = extension === '.kicad_pcb' ? 'kicad_pcb' : 'kicad_sch';
  const stack = [],
    sheets = [];
  let roots = 0,
    count = 0,
    version;
  const tokens = text.matchAll(/"(?:\\.|[^"\\])*"|[()]|[^\s()"]+/g);
  let end = 0;
  for (const match of tokens) {
    if (text.slice(end, match.index).trim()) throw Error('Malformed KiCad source.');
    end = match.index + match[0].length;
    if (++count > limits.tokens) throw Error('KiCad source exceeds Viewer token limit.');
    const token = match[0];
    if (token === '(') {
      if (!stack.length && ++roots > 1) throw Error('Malformed KiCad source.');
      if (stack.length >= limits.depth) throw Error('KiCad source exceeds Viewer depth limit.');
      stack.push({ head: null, values: [] });
    } else if (token === ')') {
      const node = stack.pop();
      if (!node?.head) throw Error('Malformed KiCad source.');
      if (stack.length === 1 && node.head === 'version') version = Number(node.values[0]);
      if (
        modelReferences &&
        node.head === 'model' &&
        stack.at(-1)?.head === 'footprint' &&
        typeof node.values[0] === 'string'
      )
        modelReferences.add(node.values[0]);
      if (
        node.head === 'property' &&
        stack.at(-1)?.head === 'sheet' &&
        ['Sheetfile', 'Sheet file'].includes(node.values[0])
      )
        sheets.push(node.values[1]);
    } else {
      const node = stack.at(-1);
      if (!node) throw Error('Malformed KiCad source.');
      let value = token;
      if (token.startsWith('"')) {
        try {
          value = JSON.parse(token);
        } catch {
          throw Error('Malformed KiCad string.');
        }
      }
      if (!node.head) {
        node.head = value;
        if (stack.length === 1 && value !== expected)
          throw Error('File is not a matching KiCad document.');
      } else if (node.values.length < 2) node.values.push(value);
    }
  }
  if (text.slice(end).trim() || stack.length || roots !== 1) throw Error('Malformed KiCad source.');
  if (!Number.isInteger(version) || version < 20211014)
    throw Error('The KiCad Viewer requires KiCad 6 or later S-expression files.');
  return sheets;
}

function readBounded(file, root) {
  const canonical = fs.realpathSync(file);
  if (!canonical.startsWith(root + path.sep))
    throw Error('KiCad source is outside the selected project.');
  const fd = fs.openSync(canonical, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limits.fileBytes)
      throw Error('KiCad source exceeds Viewer file limit.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw Error('KiCad source changed; reopen the file.');
      offset += read;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw Error('KiCad source changed; reopen the file.');
    return { file: canonical, data, sha256: hash(data) };
  } finally {
    fs.closeSync(fd);
  }
}

const csp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors app://viewer http://127.0.0.1:5173";
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': csp,
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};
const assets = {
  'bridge.js': ['bridge.js', 'text/javascript'],
  'embed.css': ['embed.css', 'text/css'],
  'kicanvas.js': ['vendor/kicanvas.js', 'text/javascript'],
  'symbols.ttf': ['vendor/symbols.ttf', 'font/ttf'],
  'geometry3d.js': ['geometry3d.js', 'text/javascript'],
  'scene3d.js': ['scene3d.js', 'text/javascript'],
  'component-loader.js': ['component-loader.js', 'text/javascript'],
  'component-worker.js': ['component-worker.js', 'text/javascript'],
  'component-wasm.js': ['component-wasm.js', 'text/javascript'],
  'component-vrml.js': ['component-vrml.js', 'text/javascript'],
  'vendor/occt-import/occt-import-js.js': [
    'vendor/occt-import/occt-import-js.js',
    'text/javascript',
  ],
  'vendor/occt-import/occt-import-js.wasm': [
    'vendor/occt-import/occt-import-js.wasm',
    'application/wasm',
  ],
  'three/three.module.js': ['vendor/three/three.module.js', 'text/javascript'],
  'three/controls/OrbitControls.js': ['vendor/three/controls/OrbitControls.js', 'text/javascript'],
  'three/loaders/VRMLLoader.js': ['vendor/three/loaders/VRMLLoader.js', 'text/javascript'],
  'three/libs/chevrotain.module.min.js': [
    'vendor/three/libs/chevrotain.module.min.js',
    'text/javascript',
  ],
};

class KiCadRuntimeManager {
  constructor({ modelProvider, sessionLimits = {} } = {}) {
    this.sessions = new Map();
    this.modelProvider = modelProvider;
    this.revision = 0;
    this.openings = new Map();
    this.sessionLimits = {
      bytes:
        Number.isSafeInteger(sessionLimits.bytes) && sessionLimits.bytes > 0
          ? Math.min(limits.sessionBytes, sessionLimits.bytes)
          : limits.sessionBytes,
      sessions:
        Number.isSafeInteger(sessionLimits.sessions) && sessionLimits.sessions > 0
          ? Math.min(limits.sessions, sessionLimits.sessions)
          : limits.sessions,
    };
  }
  assertCapacity() {
    if (this.sessions.size + this.openings.size > this.sessionLimits.sessions)
      throw new SessionLimitError('Too many open KiCad views. Close a tab, then retry.');
    const bytes = this.snapshotUsage();
    if (bytes > this.sessionLimits.bytes)
      throw new SessionLimitError(
        'Open KiCad views exceed the snapshot memory limit. Close a tab, then retry.',
      );
  }
  snapshotUsage() {
    return (
      [...this.sessions.values()].reduce(
        (total, session) => total + Math.max(session.bytes, session.pendingBytes || 0),
        0,
      ) + [...this.openings.values()].reduce((total, opening) => total + opening.bytes, 0)
    );
  }
  checkSession(token, expected) {
    const session = this.sessions.get(token);
    if (!session || (expected && session !== expected))
      throw Error('The KiCad view is no longer active.');
    for (const entry of session.sources) {
      const current = readBounded(entry.path, session.root);
      if (current.file !== entry.file || current.sha256 !== entry.sha256)
        throw Error('KiCad source changed; reopen the file.');
    }
    return session;
  }
  async modelState(context, { signal, onSnapshot } = {}) {
    const references = context.references.slice(0, MODEL_LIMITS.references);
    const requestFor = refs => ({
      references: refs,
      source: context.source,
      root: context.root,
      sha256: context.sha256,
    });
    const cancelled = () => {
      if (signal?.aborted)
        throw new DOMException('Model resource preparation cancelled.', 'AbortError');
    };
    cancelled();
    let models = prepareModelResources(references, context.source, context.root);
    let modelByteBudget = onSnapshot?.(models) ?? MODEL_LIMITS.totalBytes;
    let providerUnavailable = false;
    let resolvedLibraries = [];
    if (models.some(entry => entry.status === 'missing') && this.modelProvider?.resolve) {
      try {
        const result = await this.modelProvider.resolve(
          requestFor(
            models.filter(entry => entry.status === 'missing').map(entry => entry.sourceRef),
          ),
          { signal },
        );
        cancelled();
        resolvedLibraries = Array.isArray(result?.summary?.libraries)
          ? result.summary.libraries
          : [];
        models = prepareModelResources(
          references,
          context.source,
          context.root,
          Array.isArray(result?.resources) ? result.resources : [],
        );
        modelByteBudget = onSnapshot?.(models) ?? MODEL_LIMITS.totalBytes;
      } catch (error) {
        cancelled();
        if (error instanceof SessionLimitError) throw error;
        providerUnavailable = true;
      }
    }
    const missing = models
      .filter(entry => entry.status === 'missing')
      .map(entry => entry.sourceRef);
    let plan;
    if (missing.length && this.modelProvider?.plan && !providerUnavailable) {
      try {
        plan = await this.modelProvider.plan(requestFor(missing), { signal });
        cancelled();
      } catch {
        cancelled();
        providerUnavailable = true;
      }
    }
    const candidates = new Map();
    for (const resource of Array.isArray(plan?.resources)
      ? plan.resources.slice(0, MODEL_LIMITS.references)
      : []) {
      if (!missing.includes(resource?.sourceRef)) continue;
      candidates.set(resource.sourceRef, candidates.has(resource.sourceRef) ? null : resource);
    }
    const unique = new Map(
      models.filter(entry => entry.status === 'ready').map(entry => [entry.sha256, entry.size]),
    );
    let bytes = [...unique.values()].reduce((total, size) => total + size, 0);
    const selected = [],
      downloads = new Map(),
      libraryKeys = new Set(),
      selectedResources = [];
    for (const sourceRef of missing) {
      const resource = candidates.get(sourceRef);
      if (
        !resource ||
        typeof resource.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(resource.sha256) ||
        !Number.isSafeInteger(resource.size) ||
        resource.size <= 0 ||
        resource.size > MODEL_LIMITS.fileBytes ||
        ![resource.libraryId, resource.version].every(
          value => typeof value === 'string' && value.length > 0 && value.length <= 200,
        )
      )
        continue;
      if (!unique.has(resource.sha256)) {
        if (
          unique.size >= MODEL_LIMITS.files ||
          bytes + resource.size > Math.min(MODEL_LIMITS.totalBytes, modelByteBudget)
        )
          continue;
        unique.set(resource.sha256, resource.size);
        bytes += resource.size;
      }
      selected.push(sourceRef);
      selectedResources.push({
        sourceRef,
        sha256: resource.sha256,
        size: resource.size,
        libraryId: resource.libraryId,
        version: resource.version,
      });
      if (resource.cached !== true) downloads.set(resource.sha256, resource.size);
      libraryKeys.add(resource.libraryId + '\0' + resource.version);
    }
    const safeString = value =>
      typeof value === 'string' && value.length <= 2048 && !hasControl(value);
    const provenance = new Map();
    for (const library of [
      ...resolvedLibraries,
      ...(Array.isArray(plan?.summary?.libraries) ? plan.summary.libraries : []),
    ]) {
      if (![library.id, library.version, library.label, library.origin].every(safeString)) continue;
      const value = {
        id: library.id,
        version: library.version,
        label: library.label,
        origin: library.origin,
      };
      if (safeString(library.catalogSha256)) value.catalogSha256 = library.catalogSha256;
      if (safeString(library.revision)) value.revision = library.revision;
      if (library.license && safeString(library.license.spdx) && safeString(library.license.url)) {
        try {
          value.license = jsonSnapshot(library.license);
        } catch {
          providerUnavailable = true;
        }
      }
      provenance.set(value.id + '\0' + value.version, value);
    }
    const libraries = [...provenance]
      .filter(([key]) => libraryKeys.has(key))
      .map(([, value]) => value);
    const expectedResources = [
      ...models
        .filter(entry => entry.status === 'ready' && entry.libraryId)
        .map(({ sourceRef, sha256, size, libraryId, version }) => ({
          sourceRef,
          sha256,
          size,
          libraryId,
          version,
        })),
      ...selectedResources,
    ].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
    const bindingMap = new Map([
      ...models
        .filter(entry => entry.status === 'ready')
        .map(({ sourceRef, sha256, size, libraryId, version }) => [
          sourceRef,
          { sourceRef, sha256, size, libraryId, version },
        ]),
      ...selectedResources.map(resource => [resource.sourceRef, resource]),
    ]);
    const boundLibraries = new Set(
      expectedResources.map(resource => resource.libraryId + '\0' + resource.version),
    );
    const expectedLibraries = [...provenance]
      .filter(([key]) => boundLibraries.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
    const fingerprint = hash(
      Buffer.from(
        JSON.stringify({
          resources: context.references
            .map(sourceRef => bindingMap.get(sourceRef) || { sourceRef, unavailable: true })
            .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)),
          libraries: expectedLibraries,
        }),
      ),
    );
    return {
      models,
      downloadReferences: selected,
      plannedModelBytes: bytes,
      fingerprint,
      expectedResources,
      expectedLibraries,
      summary: {
        downloadFiles: downloads.size,
        downloadBytes: [...downloads.values()].reduce((total, size) => total + size, 0),
        unavailableFiles:
          context.references.length -
          references.length +
          models.filter(entry => entry.status === 'unavailable').length +
          missing.length -
          selected.length,
        libraries,
        ...(providerUnavailable
          ? { error: 'Component model resources are unavailable. Retry downloading models.' }
          : {}),
      },
    };
  }
  async prepareModels(token, { signal, onProgress } = {}) {
    const session = this.checkSession(token);
    if (!this.modelProvider?.ensure) throw Error('Component model downloads are unavailable.');
    if (session.preparing) throw Error('Component models are already being prepared.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    session.preparing = controller;
    const onSnapshot = models => {
      session.pendingBytes = snapshotBytes(session.sources, models);
      this.assertCapacity();
      return (
        this.sessionLimits.bytes -
        (this.snapshotUsage() - Math.max(session.bytes, session.pendingBytes)) -
        snapshotBytes(session.sources)
      );
    };
    const check = () => {
      if (controller.signal.aborted)
        throw new DOMException('Model resource preparation cancelled.', 'AbortError');
      this.checkSession(token, session);
    };
    try {
      check();
      const before = await this.modelState(session.context, {
        signal: controller.signal,
        onSnapshot,
      });
      check();
      if (before.summary.error) throw Error(before.summary.error);
      if (before.fingerprint !== session.planFingerprint)
        throw Error('Component model download plan changed. Reopen the document.');
      session.pendingBytes = snapshotBytes(session.sources) + before.plannedModelBytes;
      this.assertCapacity();
      if (before.downloadReferences.length)
        await this.modelProvider.ensure(
          { ...session.context, references: before.downloadReferences },
          {
            signal: controller.signal,
            expectedResources: before.expectedResources,
            expectedLibraries: before.expectedLibraries,
            onProgress: progress => {
              if (!controller.signal.aborted && this.sessions.get(token) === session)
                onProgress?.(progress);
            },
          },
        );
      check();
      const after = await this.modelState(session.context, {
        signal: controller.signal,
        onSnapshot,
      });
      check();
      if (after.fingerprint !== before.fingerprint)
        throw Error('Component model download plan changed. Reopen the document.');
      session.models = after.models;
      session.modelDownloads = after.summary;
      session.bytes = snapshotBytes(session.sources, after.models);
      session.planFingerprint = after.fingerprint;
      return { token, modelDownloads: after.summary };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (session.preparing === controller) delete session.preparing;
      delete session.pendingBytes;
    }
  }
  async open(file, artifactHash, projectRoot) {
    if (!isKiCadFile(file)) throw Error('Choose a .kicad_pcb or .kicad_sch file.');
    const root = fs.realpathSync(projectRoot);
    const controller = new AbortController(),
      openingId = crypto.randomUUID();
    const opening = { controller, bytes: 0 };
    const revision = this.revision;
    this.openings.set(openingId, opening);
    try {
      this.assertCapacity();
      const base = path.dirname(file),
        sources = [],
        seen = new Set(),
        active = new Set();
      let total = 0;
      const modelReferences = new Set();
      const visit = source => {
        if (active.has(source)) throw Error('Cyclic KiCad sheet reference.');
        if (seen.has(source)) return;
        seen.add(source);
        active.add(source);
        if (sources.length >= limits.files)
          throw Error('KiCad project exceeds Viewer file count limit.');
        const entry = readBounded(source, root);
        total += entry.data.length;
        if (total > limits.totalBytes)
          throw Error('KiCad project exceeds Viewer total size limit.');
        const name = path.relative(base, source).split(path.sep).join('/');
        sources.push({ ...entry, path: source, name });
        opening.bytes = total;
        this.assertCapacity();
        const sheets = inspectSource(
          entry.data.toString('utf8'),
          path.extname(source),
          modelReferences,
        );
        for (const reference of sheets) {
          if (
            typeof reference !== 'string' ||
            path.isAbsolute(reference) ||
            reference.includes('\\') ||
            reference.includes('\0') ||
            /[:$]/.test(reference) ||
            path.extname(reference) !== '.kicad_sch'
          )
            throw Error('Unsupported KiCad sheet reference.');
          const child = path.resolve(path.dirname(source), reference);
          if (!child.startsWith(base + path.sep))
            throw Error('KiCad sheet is outside the selected document directory.');
          visit(child);
        }
        active.delete(source);
      };
      visit(file);
      if (sources[0].sha256 !== artifactHash) throw Error('KiCad source changed; reopen the file.');
      const context = {
        references: [...modelReferences],
        source: sources[0].file,
        root,
        sha256: artifactHash,
      };
      const state =
        path.extname(file) === '.kicad_pcb'
          ? await this.modelState(context, {
              signal: controller.signal,
              onSnapshot: models => {
                opening.bytes = snapshotBytes(sources, models);
                this.assertCapacity();
                return (
                  this.sessionLimits.bytes -
                  (this.snapshotUsage() - opening.bytes) -
                  snapshotBytes(sources)
                );
              },
            })
          : { models: [], summary: undefined };
      if (controller.signal.aborted || revision !== this.revision)
        throw new DOMException('The KiCad view is no longer active.', 'AbortError');
      const token = crypto.randomUUID();
      this.openings.delete(openingId);
      this.sessions.set(token, {
        root,
        sources,
        models: state.models,
        context,
        modelDownloads: state.summary,
        bytes: snapshotBytes(sources, state.models),
        planFingerprint: state.fingerprint,
      });
      try {
        this.checkSession(token);
      } catch (error) {
        this.sessions.delete(token);
        throw error;
      }
      return {
        token,
        name: path.basename(file),
        document: path.extname(file) === '.kicad_pcb' ? 'board' : 'schematic',
        url: `app://kicad/${token}/index.html`,
        modelDownloads: state.summary,
      };
    } finally {
      this.openings.delete(openingId);
    }
  }
  async handle(request) {
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== 'app:' ||
        url.hostname !== 'kicad' ||
        (request.method && request.method !== 'GET')
      )
        return new Response('Forbidden', { status: 403 });
      const parts = url.pathname.split('/').slice(1);
      const session = this.sessions.get(parts[0]);
      if (!session) return new Response('Unknown KiCad view', { status: 404 });
      const resource = parts.slice(1).join('/');
      // Recheck every companion, including its real path; serve the exact verified snapshot.
      for (const entry of session.sources) {
        const current = readBounded(entry.path, session.root);
        if (current.file !== entry.file || current.sha256 !== entry.sha256)
          return new Response('KiCad source changed; reopen the file.', { status: 409, headers });
      }
      if (resource === 'index.html')
        return new Response(
          '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="embed.css"></head><body><script type="module" src="bridge.js"></script></body></html>',
          { headers: { ...headers, 'Content-Type': 'text/html' } },
        );
      if (resource === 'manifest.json') {
        for (const entry of session.models)
          if (entry.status === 'ready' && !recheckModel(entry, session.root))
            return new Response('PCB component model changed; reopen the file.', {
              status: 409,
              headers,
            });
        return new Response(
          JSON.stringify({
            boardSha256: session.sources[0].sha256,
            modelDownloads: session.modelDownloads,
            models: modelManifest(session.models),
            sources: session.sources.map((entry, index) => ({
              name: entry.name,
              sha256: entry.sha256,
              url: `source/${index}`,
            })),
          }),
          { headers: { ...headers, 'Content-Type': 'application/json' } },
        );
      }
      if (/^models\/(0|[1-9]\d*)$/.test(resource)) {
        const entry = session.models[Number(resource.split('/')[1])];
        if (entry?.status === 'ready') {
          if (!recheckModel(entry, session.root))
            return new Response('PCB component model changed; reopen the file.', {
              status: 409,
              headers,
            });
          return new Response(entry.data, {
            headers: {
              ...headers,
              'Content-Type':
                entry.format === 'wrl' ? 'model/vrml; charset=utf-8' : 'application/octet-stream',
            },
          });
        }
      }
      if (/^source\/(0|[1-9]\d*)$/.test(resource)) {
        const entry = session.sources[Number(resource.split('/')[1])];
        if (entry)
          return new Response(entry.data, {
            headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
          });
      }
      if (Object.hasOwn(assets, resource)) {
        const [relative, type] = assets[resource];
        return new Response(fs.readFileSync(path.join(__dirname, relative)), {
          headers: { ...headers, 'Content-Type': type },
        });
      }
      return new Response('Not found', { status: 404, headers });
    } catch {
      return new Response('KiCad source unavailable; reopen the file.', { status: 409, headers });
    }
  }
  close(token) {
    if (token !== undefined) {
      const session = this.sessions.get(token);
      session?.preparing?.abort();
      return this.sessions.delete(token);
    }
    this.revision++;
    for (const opening of this.openings.values()) opening.controller.abort();
    this.openings.clear();
    for (const session of this.sessions.values()) session.preparing?.abort();
    this.sessions.clear();
  }
}
module.exports = { KiCadRuntimeManager, isKiCadFile, inspectSource, limits };
