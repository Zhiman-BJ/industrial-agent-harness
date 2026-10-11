'use strict';

// Restricted docs provider (#103): the only documentation surface the
// internal docs center may read. It accepts manifest IDs only — never
// filesystem paths — verifies content hashes on read, rejects traversal and
// symlink escapes, and enforces search limits. The same provider serves
// development checkouts and packaged bundles (inject a different root).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { LIMITS, ASSET_MEDIA_TYPES } = require('./limits.cjs');
const { resolveRelative } = require('./index-builder.cjs');

class DocsError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

// Per-segment symlink guard: a symlinked component could redirect outside
// the docs root, and comparing realpaths would false-positive on legitimately
// symlinked temp roots (macOS /var).
function safeResolve(root, relativeId) {
  if (typeof relativeId !== 'string' || relativeId.length === 0) return null;
  if (relativeId.includes('\\') || /^[A-Za-z]:/.test(relativeId)) return null;
  if (relativeId.startsWith('/') || relativeId.split('/').includes('..')) return null;
  let segment = root;
  for (const part of relativeId.split('/')) {
    if (part === '' || part === '.') continue;
    segment = path.join(segment, part);
    let stat;
    try {
      stat = fs.lstatSync(segment);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
  }
  return segment;
}

function createDocsProvider({ manifest, root }) {
  if (!manifest || manifest.schemaVersion !== 1)
    throw new DocsError('docs:manifest', 'docs manifest missing or unsupported schemaVersion');
  if (typeof root !== 'string' || root.length === 0)
    throw new DocsError('docs:root', 'provider requires a docs root');

  const byId = new Map(manifest.docs.map(doc => [doc.id, doc]));
  const assetById = new Map(manifest.assets.map(asset => [asset.id, asset]));
  const bodies = new Map(); // id -> { markdown, entry }
  const realRoot = fs.realpathSync(root);

  function loadDoc(id) {
    const entry = byId.get(id);
    if (!entry)
      throw new DocsError('docs:unknown-id', `not in the docs manifest: ${JSON.stringify(id)}`);
    const cached = bodies.get(id);
    if (cached) return cached;
    const file = safeResolve(realRoot, entry.file);
    if (!file)
      throw new DocsError('docs:unsafe-path', `doc path rejected: ${JSON.stringify(entry.file)}`);
    // Size first (no read of a replaced huge file), then bytes, then hash:
    // any drift from the indexed manifest is an explicit state.
    const stat = fs.statSync(file);
    if (stat.size > LIMITS.maxDocBytes)
      throw new DocsError('docs:oversize', `doc exceeds maxDocBytes: ${id}`);
    if (stat.size !== entry.bytes)
      throw new DocsError('docs:hash-mismatch', `doc size changed since indexing: ${id}`);
    const bytes = fs.readFileSync(file);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256)
      throw new DocsError('docs:hash-mismatch', `doc content changed since indexing: ${id}`);
    const loaded = { markdown: bytes.toString('utf8'), entry };
    bodies.set(id, loaded);
    return loaded;
  }

  return {
    manifest,

    // Catalog for the TOC: id/title pairs plus recorded broken refs.
    catalog() {
      return {
        displayName: manifest.displayName,
        docs: manifest.docs.map(doc => ({ id: doc.id, title: doc.title, bytes: doc.bytes })),
        assets: manifest.assets.length,
        brokenRefs: manifest.brokenRefs,
      };
    },

    getDoc(id) {
      return loadDoc(id);
    },

    getAsset(id) {
      const entry = assetById.get(id);
      if (!entry)
        throw new DocsError('docs:unknown-id', `not in the docs manifest: ${JSON.stringify(id)}`);
      const file = safeResolve(realRoot, entry.file);
      if (!file)
        throw new DocsError(
          'docs:unsafe-path',
          `asset path rejected: ${JSON.stringify(entry.file)}`,
        );
      const bytes = fs.readFileSync(file);
      if (bytes.length !== entry.bytes)
        throw new DocsError('docs:hash-mismatch', `asset size changed: ${id}`);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== entry.sha256)
        throw new DocsError('docs:hash-mismatch', `asset content changed: ${id}`);
      return {
        bytes,
        mediaType: entry.mediaType || ASSET_MEDIA_TYPES[path.extname(entry.file).toLowerCase()],
      };
    },

    // Link resolution for rendering: doc/anchor/external/missing, never a
    // filesystem path.
    resolveLink(fromId, href) {
      const from = byId.get(fromId);
      if (!from)
        throw new DocsError(
          'docs:unknown-id',
          `not in the docs manifest: ${JSON.stringify(fromId)}`,
        );
      const baseDir =
        path.posix.dirname(from.file) === '.' ? '' : `${path.posix.dirname(from.file)}/`;
      const resolved = resolveRelative(baseDir, href);
      if (resolved === null) return { kind: 'missing', href };
      if (resolved.external) return { kind: 'external', href };
      if (resolved.anchor !== undefined && resolved.id === undefined)
        return { kind: 'anchor', anchor: resolved.anchor };
      if (byId.has(resolved.id))
        return { kind: 'doc', targetId: resolved.id, anchor: resolved.anchor ?? null };
      return { kind: 'missing', href };
    },

    // Substring search that works for CJK (no tokenization needed) and
    // case-insensitively for latin. Bounded result count with hasMore.
    search(rawQuery, { limit = LIMITS.maxResults } = {}) {
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      if (query.length === 0) throw new DocsError('docs:empty-query', 'empty search query');
      if (query.length > LIMITS.maxQueryChars)
        throw new DocsError(
          'docs:query-too-long',
          `query longer than ${LIMITS.maxQueryChars} characters`,
        );
      const needle = query.toLowerCase();
      const results = [];
      let hasMore = false;
      const ranked = [];
      for (const doc of manifest.docs) {
        const titleHit = doc.title.toLowerCase().includes(needle) ? 0 : Infinity;
        let bodyHit = Infinity;
        let snippet = null;
        if (titleHit === Infinity) {
          const { markdown } = loadDoc(doc.id);
          const haystack = markdown.toLowerCase();
          const index = haystack.indexOf(needle);
          if (index >= 0) {
            bodyHit = index;
            const start = Math.max(0, index - 30);
            snippet = markdown
              .slice(start, Math.min(markdown.length, start + query.length + 60))
              .replace(/\s+/g, ' ');
          }
        } else {
          snippet = doc.title;
        }
        if (titleHit === Infinity && bodyHit === Infinity) continue;
        ranked.push({ id: doc.id, title: doc.title, snippet, rank: Math.min(titleHit, bodyHit) });
      }
      ranked.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
      for (const item of ranked) {
        if (results.length >= Math.min(limit, LIMITS.maxResults)) {
          hasMore = true;
          break;
        }
        results.push({ id: item.id, title: item.title, snippet: item.snippet });
      }
      return { results, hasMore, matched: ranked.length };
    },
  };
}

module.exports = { createDocsProvider, DocsError };
