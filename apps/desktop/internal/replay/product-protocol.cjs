'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
function createRendererProtocol(directory) {
  const root = fs.realpathSync(directory);
  const files = new Map();
  function scan(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isSymbolicLink()) throw Error('Product renderer links are forbidden.');
      if (item.isDirectory()) scan(file);
      else if (item.isFile() && mime[path.extname(file)]) {
        const bytes = fs.readFileSync(file);
        if (bytes.length > 64 * 1024 * 1024) throw Error('Product renderer resource is too large.');
        files.set(path.relative(root, file).split(path.sep).join('/'), {
          file,
          bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  scan(root);
  if (!files.has('index.html')) throw Error('Complete production renderer index.html is required.');
  return {
    manifest: [...files].map(([relative, { bytes, sha256 }]) => ({
      path: relative,
      bytes,
      sha256,
    })),
    handle(request) {
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'app:' || url.hostname !== 'viewer')
          return new Response('Forbidden', { status: 403 });
        const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
        const entry = files.get(relative);
        if (!entry) return new Response('Not found', { status: 404 });
        if (fs.realpathSync(entry.file) !== entry.file || fs.lstatSync(entry.file).isSymbolicLink())
          return new Response('Changed resource', { status: 409 });
        const bytes = fs.readFileSync(entry.file);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
          return new Response('Changed resource', { status: 409 });
        return new Response(bytes, {
          headers: { 'Content-Type': mime[path.extname(entry.file)], 'Cache-Control': 'no-store' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}
module.exports = { createRendererProtocol };
