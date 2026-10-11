'use strict';

// Builds a docs index from an allowed doc subset (#103). Example:
//   node scripts/build-index.cjs --root <repo>/doc --out <target>/docs-index.json \
//     --include '*.md' --include 'images/*' --version "$(git rev-parse HEAD)"
// The output manifest is internal-only material: it feeds the internal docs
// provider and must never ship in the public edition (editions.json governs
// export through the #106 exporter).

const fs = require('node:fs');
const path = require('node:path');

const { buildDocsIndex, writeDocsIndex } = require('../src/index-builder.cjs');

function argument(name) {
  const flag = process.argv.indexOf(`--${name}`);
  return flag > 0 ? process.argv[flag + 1] : undefined;
}

function main() {
  const root = argument('root');
  const out = argument('out');
  if (!root || !out) {
    console.error(
      JSON.stringify({
        type: 'error',
        message:
          'usage: --root <dir> --out <file> [--include <glob>]... [--version <sha>] [--display-name <name>]',
      }),
    );
    process.exit(1);
  }
  const include = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === '--include') include.push(process.argv[index + 1]);
  }
  const manifest = buildDocsIndex(root, {
    include: include.length ? include : undefined,
    sourceVersion: argument('version') ?? null,
    displayName: argument('display-name') ?? '研发文档',
  });
  writeDocsIndex(manifest, path.resolve(out));
  console.log(
    JSON.stringify({
      docs: manifest.docs.length,
      assets: manifest.assets.length,
      brokenRefs: manifest.brokenRefs.length,
      out: path.resolve(out),
    }),
  );
}

if (require.main === module) main();
