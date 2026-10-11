# @industrial-agent-harness/harness-docs

Internal docs center data core (#103). Scans an explicitly allowed internal
doc subset into a versioned manifest (IH-DOCS-001) and serves it through a
restricted provider that answers **manifest IDs only** — never filesystem
paths. Internal-edition material: the manifest is marked `internal-only` and
the panel/IPC wiring belongs to the #102 internal extension surface.

## Scope

- **Index builder** (`buildDocsIndex`): allowed-subset scan with hard caps
  (per-doc 256 KiB matching the viewer document service, per-asset 4 MiB,
  16 MiB total, 300 docs). Extracts first-heading titles, the link/image
  reference graph (code fences and inline code are stripped first — example
  URLs never enter the graph), and sha256 per file. Broken references are
  recorded in the manifest as explicit gaps, not build failures.
- **Provider** (`createDocsProvider`): the only docs surface. Manifest-ID
  access, per-segment symlink refusal, no `..`/absolute/backslash/
  drive-letter paths, size check before read, and sha256 verification on
  every read — tampered content surfaces as `docs:hash-mismatch`, never as
  silently-served new bytes. Link resolution classifies doc/anchor/external/
  missing (external schemes require ≥2 characters, so `C:` stays rejected).
  CJK-friendly substring search (case-insensitive for latin) with result
  caps, `hasMore`, and typed empty/too-long query errors. The same provider
  serves a development checkout and a packaged bundle — only the root
  differs.
- **Navigation** (`createDocsNavigation`): pure path/anchor jump stack with
  back, depth cap, and reset — the panel adapter stays thin.

## Usage

```js
const {
  buildDocsIndex,
  writeDocsIndex,
  createDocsProvider,
} = require('@industrial-agent-harness/harness-docs');
const manifest = buildDocsIndex(docRoot, { include: ['*.md', 'images/*'], sourceVersion });
writeDocsIndex(manifest, 'dist/docs-index.json');
const docs = createDocsProvider({ manifest, root: docRoot });
docs.search('架构'); // { results, hasMore, matched }
```

CLI: `node scripts/build-index.cjs --root <dir> --out <file> --include <glob>…
[--version <sha>] [--display-name <name>]`.

## Not in this package (yet)

- The docs panel UI, IPC surface, and app entry — #102 internal extension
  wiring.
- Rendering: the panel will reuse the existing restricted Markdown renderer
  (skipHtml + no remote resources), not a new one.

The real `doc/` tree indexes cleanly today (65 docs, 0.54 MB, well under
caps); its 47 recorded broken refs are the honest gap list for maintainers.
