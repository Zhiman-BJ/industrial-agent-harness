'use strict';

// Hard limits for the internal docs center (#103): total/per-file byte
// budgets, catalog caps, and search caps. Mirrors the viewer document
// service's markdown budget so docs render under the same constraints as
// project files.

const LIMITS = {
  maxDocBytes: 256 * 1024, // per markdown file (matches documents service)
  maxAssetBytes: 4 * 1024 * 1024, // per image/asset file
  maxTotalBytes: 16 * 1024 * 1024, // whole allowed subset
  maxDocs: 300,
  maxAssets: 200,
  maxResults: 50,
  maxQueryChars: 100,
  maxStackDepth: 100,
};

const ASSET_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const DOC_EXTENSION = '.md';

module.exports = { LIMITS, ASSET_MEDIA_TYPES, DOC_EXTENSION };
