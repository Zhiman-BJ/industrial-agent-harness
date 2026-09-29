const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');

const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2'};
const maxFile = 1024 * 1024 * 1024;
const maxTotal = 2 * 1024 * 1024 * 1024;
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function exportFiles(html) {
  if (path.extname(html).toLowerCase() !== '.html') throw Error('Choose a Godot Web Export HTML file.');
  const root = fs.realpathSync(path.dirname(html));
  const name = path.basename(html, '.html');
  const files = new Map();
  let total = 0;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.startsWith(`${name}.`) || !mime[path.extname(entry.name).toLowerCase()]) continue;
    const file = fs.realpathSync(path.join(root, entry.name));
    if (path.dirname(file) !== root) continue;
    const size = fs.statSync(file).size;
    if (size > maxFile || (total += size) > maxTotal) throw Error('Godot export exceeds Viewer resource limits.');
    files.set(entry.name, {file, size});
  }
  if (!files.has(path.basename(html)) || !files.has(`${name}.js`) || !files.has(`${name}.wasm`) || !files.has(`${name}.pck`)) throw Error('Godot Web Export requires matching HTML, JS, WASM, and PCK files.');
  return {name, files};
}

function isGodotExport(file) {
  try {exportFiles(file); return true;} catch {return false;}
}

class GodotRuntimeManager {
  constructor() {this.sessions = new Map();}
  async open(html, artifactHash) {
    const {name, files} = exportFiles(html);
    const hash = await digest(html);
    if (hash !== artifactHash) throw Error('Godot export changed; reopen the file.');
    const fingerprints = new Map();
    for (const [entry, {file}] of files) fingerprints.set(entry, await digest(file));
    const token = crypto.randomUUID();
    this.sessions.clear();
    this.sessions.set(token, {name, files, fingerprints});
    return {token, name, url: `app://godot/${token}/${encodeURIComponent(path.basename(html))}`};
  }
  async handle(request) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'app:' || url.hostname !== 'godot') return new Response('Forbidden', {status: 403});
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 2) return new Response('Not found', {status: 404});
      const session = this.sessions.get(parts[0]);
      const name = decodeURIComponent(parts[1]);
      if (!session) return new Response('Unknown Godot view', {status: 404});
      const headers = {'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; img-src 'self' blob: data:; media-src 'self' blob: data:; object-src 'none'; frame-ancestors app://viewer http://127.0.0.1:5173"};
      if (name === '_harness_bridge.js') return new Response(Readable.toWeb(fs.createReadStream(path.join(__dirname, 'bridge.js'))), {headers: {...headers, 'Content-Type': 'text/javascript'}});
      const entry = session.files.get(name);
      if (!entry) return new Response('Not found', {status: 404});
      if (await digest(entry.file) !== session.fingerprints.get(name)) return new Response('Export changed', {status: 409});
      if (name.endsWith('.html')) {
        const html = fs.readFileSync(entry.file, 'utf8');
        const script = `<script src="_harness_bridge.js"></script>`;
        const injected = html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
        if (injected === html) return new Response('Invalid Godot export HTML', {status: 422});
        return new Response(injected, {headers: {...headers, 'Content-Type': 'text/html'}});
      }
      return new Response(Readable.toWeb(fs.createReadStream(entry.file)), {headers: {...headers, 'Content-Type': mime[path.extname(name).toLowerCase()]}});
    } catch {return new Response('Not found', {status: 404});}
  }
  close() {this.sessions.clear();}
}

module.exports = {GodotRuntimeManager, exportFiles, isGodotExport};
