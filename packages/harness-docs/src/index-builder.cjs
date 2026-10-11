'use strict';

// Docs index builder (#103): scans an explicitly allowed doc subset and
// emits a versioned manifest (IH-DOCS-001) that the provider trusts as the
// complete universe of readable documents and assets. Broken references are
// recorded, not repaired — the UI shows them as gaps, exactly like missing
// recording assets.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { LIMITS, ASSET_MEDIA_TYPES, DOC_EXTENSION } = require('./limits.cjs');
const { extractReferences, titleOf } = require('./markdown-links.cjs');

const SCHEMA_VERSION = 1;
const MANIFEST_ID = 'IH-DOCS-001';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith('/') || value.includes('..')) return false;
  return value.split('/').every(part => part !== '' && part !== '.');
}

// docId: relative path minus .md ("guides/overview" from
// "guides/overview.md"); assetId: relative path as-is.
function buildDocsIndex(docRoot, options = {}) {
  const {
    include = ['*.md', 'images/*', 'assets/*'],
    sourceVersion = null,
    displayName = '研发文档',
    now = () => new Date().toISOString(),
  } = options;

  const root = fs.realpathSync(docRoot);
  const docs = [];
  const assets = [];
  let totalBytes = 0;

  const files = new Set();
  for (const pattern of include) {
    for (const file of fs.globSync(pattern, { cwd: root }))
      files.add(file.split(path.sep).join('/'));
  }

  for (const file of [...files].sort()) {
    if (!isSafeRelative(file)) continue;
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (stat.isSymbolicLink()) throw Error(`docs index refuses symbolic links: ${file}`);
    if (stat.isDirectory()) continue;

    if (file.endsWith(DOC_EXTENSION)) {
      if (docs.length >= LIMITS.maxDocs)
        throw Error(`docs index exceeds maxDocs (${LIMITS.maxDocs}): ${file}`);
      if (stat.size > LIMITS.maxDocBytes)
        throw Error(`doc exceeds maxDocBytes (${LIMITS.maxDocBytes}): ${file}`);
      const bytes = fs.readFileSync(absolute);
      totalBytes += bytes.length;
      if (totalBytes > LIMITS.maxTotalBytes)
        throw Error(`docs subset exceeds maxTotalBytes (${LIMITS.maxTotalBytes}) at ${file}`);
      const markdown = bytes.toString('utf8');
      const references = extractReferences(markdown);
      docs.push({
        id: file.slice(0, -DOC_EXTENSION.length),
        file,
        title: titleOf(markdown, file),
        bytes: stat.size,
        sha256: sha256(bytes),
        links: references.links,
        images: references.images,
      });
    } else {
      const mediaType = ASSET_MEDIA_TYPES[path.extname(file).toLowerCase()];
      if (!mediaType) continue; // not an allowed asset kind: not indexed
      if (assets.length >= LIMITS.maxAssets)
        throw Error(`docs index exceeds maxAssets (${LIMITS.maxAssets}): ${file}`);
      if (stat.size > LIMITS.maxAssetBytes)
        throw Error(`asset exceeds maxAssetBytes (${LIMITS.maxAssetBytes}): ${file}`);
      const bytes = fs.readFileSync(absolute);
      totalBytes += bytes.length;
      if (totalBytes > LIMITS.maxTotalBytes)
        throw Error(`docs subset exceeds maxTotalBytes (${LIMITS.maxTotalBytes}) at ${file}`);
      assets.push({ id: file, file, mediaType, bytes: stat.size, sha256: sha256(bytes) });
    }
  }

  const docIds = new Set(docs.map(doc => doc.id));
  const assetIds = new Set(assets.map(asset => asset.id));
  const brokenRefs = [];
  for (const doc of docs) {
    const baseDir = path.posix.dirname(doc.file) === '.' ? '' : `${path.posix.dirname(doc.file)}/`;
    for (const link of doc.links) {
      const resolved = resolveRelative(baseDir, link.target);
      if (resolved === null || (!docIds.has(resolved.id) && !isAnchorOrExternal(link.target)))
        brokenRefs.push({ from: doc.id, kind: 'link', target: link.target });
    }
    for (const image of doc.images) {
      const resolved = resolveRelative(baseDir, image.target);
      if (resolved === null || !assetIds.has(resolved.id))
        brokenRefs.push({ from: doc.id, kind: 'image', target: image.target });
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    manifestId: MANIFEST_ID,
    edition: 'internal-only',
    generatedAt: now(),
    sourceVersion,
    displayName,
    limits: LIMITS,
    root: null, // filled by the caller/packager; never a machine path in the index
    docs,
    assets,
    brokenRefs,
  };
}

function isAnchorOrExternal(target) {
  return target.startsWith('#') || /^[a-z][a-z0-9+.-]+:/i.test(target);
}

// Resolve a written link target against the doc's directory into an anchor,
// an external scheme URL, or a candidate { id } (with optional #fragment).
function resolveRelative(baseDir, target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (target.includes('\\')) return null;
  if (target.startsWith('#')) return { anchor: target.slice(1) };
  // Two-plus character schemes only: a single letter before ":" is a
  // Windows drive prefix and must be rejected, not treated as a URL.
  if (/^[a-z][a-z0-9+.-]+:/i.test(target)) return { external: target };
  const withoutFragment = target.split('#')[0];
  const anchor = target.includes('#') ? target.split('#').slice(1).join('#') : null;
  if (withoutFragment === '') return anchor !== null ? { anchor } : null;
  const joined = path.posix.normalize(path.posix.join(baseDir, withoutFragment));
  if (!isSafeRelative(joined)) return null;
  const id = joined.endsWith(DOC_EXTENSION) ? joined.slice(0, -DOC_EXTENSION.length) : joined;
  return { id, anchor };
}

function writeDocsIndex(manifest, outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temp = `${outputFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temp, outputFile);
}

module.exports = { buildDocsIndex, writeDocsIndex, resolveRelative, SCHEMA_VERSION, MANIFEST_ID };
