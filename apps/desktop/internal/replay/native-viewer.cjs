'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createViewerRegistry } = require('../../../../packages/viewer-core/src/registry.cjs');
const {
  limits: sourceLimits,
} = require('../../../../packages/viewer-builtin/src/kicad/runtime.cjs');
const {
  createReadOnlyKiCadViewer,
} = require('../../../../packages/viewer-builtin/src/kicad/recorded-plugin.cjs');
const {
  MODEL_LIMITS,
  resolveModelReference,
} = require('../../../../packages/viewer-builtin/src/kicad/model-resources.cjs');
const {
  isSafeRelativePath,
  uuidLike,
} = require('../../../../packages/harness-recording/src/manifest.cjs');

const HASH = /^[a-f0-9]{64}$/;
const PREVIEW_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_FILES = 128;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safeRelative = value =>
  isSafeRelativePath(value) &&
  ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function createRecordedViewerHost(bundle, { projectId = 'recorded-project' } = {}) {
  const stages = new Map();
  const assets = new Map();
  for (const asset of bundle.manifest.assets || []) {
    if (!safeRelative(asset.relativePath)) throw Error('Invalid recorded asset path.');
    if (assets.has(asset.relativePath)) throw Error('Duplicate recorded asset path.');
    assets.set(asset.relativePath, asset);
  }
  for (const stage of bundle.manifest.replayStages || []) {
    const snapshotId = stage.provenance?.snapshotId;
    if (!snapshotId) continue;
    if (!uuidLike(stage.id) || !uuidLike(snapshotId) || stages.has(stage.id))
      throw Error('Invalid recorded native stage identity.');
    const prefix = `assets/source/snapshots/${snapshotId}/`;
    const board = assets.get(`${prefix}board.kicad_pcb`);
    if (!board || board.sha256 !== stage.provenance.sourceBoardSha256)
      throw Error('Native stage board does not match its recorded source hash.');
    const files = new Map();
    let totalBytes = 0;
    for (const [relative, asset] of assets) {
      if (!relative.startsWith(prefix)) continue;
      if (
        asset.status !== 'present' ||
        !HASH.test(asset.sha256) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0 ||
        asset.bytes > sourceLimits.fileBytes
      )
        throw Error('Native snapshot assets require bounded, present, hash-bound files.');
      const file = relative.slice(prefix.length);
      if (/\.(?:wrl|step|stp)$/i.test(file) && asset.bytes > MODEL_LIMITS.fileBytes)
        throw Error('Recorded component model exceeds Viewer limits.');
      totalBytes += asset.bytes;
      files.set(file, asset);
    }
    if (files.size > SNAPSHOT_FILES || totalBytes > SNAPSHOT_BYTES)
      throw Error('Recorded native snapshot exceeds Viewer limits.');
    stages.set(stage.id, { stage, prefix, files, board });
  }
  if (stages.size && !bundle.sourceDirectory)
    throw Error('Recorded native snapshots require a bounded bundle directory.');
  const sourceDirectory = bundle.sourceDirectory && path.resolve(bundle.sourceDirectory);
  const artifacts = new Map();
  const tokens = new Set();
  let active = null;
  let epoch = 0;

  function checked(asset) {
    let file = sourceDirectory;
    for (const part of ['', ...asset.relativePath.split('/')]) {
      if (part) file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('Recorded asset links are forbidden.');
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== asset.bytes)
        throw Error('Recorded asset size changed.');
      const bytes = Buffer.alloc(asset.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw Error('Recorded asset changed during read.');
        offset += count;
      }
      const after = fs.fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw Error('Recorded asset changed during read.');
      if (hash(bytes) !== asset.sha256) throw Error('Recorded asset hash changed.');
      return { file, bytes };
    } finally {
      fs.closeSync(fd);
    }
  }
  function current() {
    if (!active) throw Error('No recorded native snapshot is active.');
    return active;
  }
  function entryFor(relative) {
    if (!safeRelative(relative)) throw Error('Choose a declared recorded project file.');
    const snapshot = current();
    const asset = snapshot.files.get(relative);
    if (!asset) throw Error('File is outside the active recorded snapshot.');
    return { snapshot, asset, ...checked(asset) };
  }
  function clear() {
    epoch++;
    runtime.close();
    artifacts.clear();
    tokens.clear();
  }
  const runtime = createReadOnlyKiCadViewer({
    async validateOpened({ artifact, file, snapshot, generation, data }, manager) {
      if (generation !== epoch || snapshot !== active)
        throw Error('Recorded snapshot changed while opening the Viewer.');
      const response = await manager.handle(
        new Request(data.url.replace('index.html', 'manifest.json')),
      );
      if (!response.ok) throw Error('Recorded native Viewer source is unavailable.');
      const manifest = await response.json();
      if (manifest.boardSha256 !== artifact.sha256)
        throw Error('Recorded native Viewer source hash changed.');
      for (const source of manifest.sources) {
        const relative = path
          .relative(snapshot.root, path.resolve(path.dirname(file), source.name))
          .split(path.sep)
          .join('/');
        const declared = snapshot.files.get(relative);
        if (!declared || declared.sha256 !== source.sha256)
          throw Error('Viewer source differs from its recorded snapshot hash.');
        checked(declared);
      }
      for (const model of manifest.models) {
        if (model.status !== 'ready')
          throw Error(`Recorded component model is unavailable: ${model.sourceRef}`);
        const modelFile = resolveModelReference(model.sourceRef, file, snapshot.root);
        const relative = path.relative(snapshot.root, modelFile).split(path.sep).join('/');
        const declared = snapshot.files.get(relative);
        if (!declared || declared.sha256 !== model.sha256 || declared.bytes !== model.size)
          throw Error('Viewer component model differs from its recorded snapshot hash.');
        checked(declared);
      }
      if (generation !== epoch || snapshot !== active)
        throw Error('Recorded snapshot changed while opening the Viewer.');
      tokens.add(data.token);
    },
  });
  const registry = createViewerRegistry([runtime.plugin]);
  function snapshot() {
    return {
      projectId,
      stageId: active?.stage.id || null,
      projectRoot: active?.root || null,
      boardPath: active ? 'board.kicad_pcb' : null,
      sourceSha256: active?.board.sha256 || null,
      viewerKinds: registry.list(),
    };
  }
  return {
    protocolHosts: runtime.protocolHosts,
    activateStage(stageId) {
      const next = stageId == null ? null : stages.get(stageId);
      if (stageId != null && !next) throw Error('No native snapshot is declared for this stage.');
      if (next === active) return { ...snapshot(), changed: false };
      clear();
      active = null;
      if (next) {
        for (const asset of next.files.values()) checked(asset);
        next.root = path.resolve(sourceDirectory, next.prefix);
        active = next;
      }
      return { ...snapshot(), changed: true };
    },
    listFiles() {
      if (!active) return [];
      const entries = new Map();
      for (const relative of active.files.keys()) {
        const parts = relative.split('/');
        for (let index = 1; index <= parts.length; index++) {
          const item = parts.slice(0, index).join('/');
          entries.set(item, {
            path: item,
            name: parts[index - 1],
            depth: index - 1,
            directory: index < parts.length,
          });
        }
      }
      return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    },
    readFile(relative) {
      const { asset, bytes } = entryFor(relative);
      const viewer = registry.match(relative);
      const preview = bytes.subarray(0, PREVIEW_BYTES);
      return {
        path: relative,
        name: path.basename(relative),
        sizeBytes: asset.bytes,
        viewer,
        content: viewer || preview.includes(0) ? null : preview.toString('utf8'),
        truncated: !viewer && bytes.length > PREVIEW_BYTES,
      };
    },
    openProjectFile(relative) {
      const { snapshot, asset, file } = entryFor(relative);
      const kind = registry.match(relative);
      if (!kind) throw Error('No registered Viewer supports this recorded file.');
      const artifact = {
        id: crypto.randomUUID(),
        kind,
        name: path.basename(relative),
        design: bundle.manifest.chat?.displayName || 'Recorded project',
        sizeBytes: asset.bytes,
        sha256: asset.sha256,
        source: 'project file',
      };
      artifacts.set(artifact.id, { artifact, file, asset, snapshot, generation: epoch });
      return artifact;
    },
    async openArtifact({ artifactId } = {}) {
      const entry = artifacts.get(artifactId);
      if (!entry || entry.generation !== epoch || entry.snapshot !== active)
        throw Error('Recorded artifact is no longer active.');
      checked(entry.asset);
      return registry.get(entry.artifact.kind).open({ ...entry, root: entry.snapshot.root });
    },
    handleProtocol(request) {
      return runtime.handle(request);
    },
    release({ token } = {}) {
      if (tokens.delete(token)) runtime.close(token);
    },
    close() {
      clear();
      active = null;
    },
    snapshot,
  };
}

module.exports = { createRecordedViewerHost };
