const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const limits = Object.freeze({fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, files: 32, depth: 128, tokens: 500000});
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const isKiCadFile = file => ['.kicad_pcb', '.kicad_sch'].includes(path.extname(file));

// Only inspect structure and sheet references here. KiCanvas owns CAD parsing/rendering.
function inspectSource(text, extension) {
  const expected = extension === '.kicad_pcb' ? 'kicad_pcb' : 'kicad_sch';
  const stack = [], sheets = [];
  let roots = 0, count = 0, version;
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
      stack.push({head: null, values: []});
    } else if (token === ')') {
      const node = stack.pop();
      if (!node?.head) throw Error('Malformed KiCad source.');
      if (stack.length === 1 && node.head === 'version') version = Number(node.values[0]);
      if (node.head === 'property' && stack.at(-1)?.head === 'sheet' && ['Sheetfile', 'Sheet file'].includes(node.values[0])) sheets.push(node.values[1]);
    } else {
      const node = stack.at(-1);
      if (!node) throw Error('Malformed KiCad source.');
      let value = token;
      if (token.startsWith('"')) {
        try {value = JSON.parse(token);} catch {throw Error('Malformed KiCad string.');}
      }
      if (!node.head) {
        node.head = value;
        if (stack.length === 1 && value !== expected) throw Error('File is not a matching KiCad document.');
      } else if (node.values.length < 2) node.values.push(value);
    }
  }
  if (text.slice(end).trim() || stack.length || roots !== 1) throw Error('Malformed KiCad source.');
  if (!Number.isInteger(version) || version < 20211014) throw Error('The KiCad Viewer requires KiCad 6 or later S-expression files.');
  return sheets;
}

function readBounded(file, root) {
  const canonical = fs.realpathSync(file);
  if (!canonical.startsWith(root + path.sep)) throw Error('KiCad source is outside the selected project.');
  const fd = fs.openSync(canonical, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limits.fileBytes) throw Error('KiCad source exceeds Viewer file limit.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw Error('KiCad source changed; reopen the file.');
      offset += read;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw Error('KiCad source changed; reopen the file.');
    return {file: canonical, data, sha256: hash(data)};
  } finally {fs.closeSync(fd);}
}

const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors app://viewer http://127.0.0.1:5173";
const headers = {'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff'};
const assets = {'bridge.js': ['bridge.js', 'text/javascript'], 'embed.css': ['embed.css', 'text/css'], 'kicanvas.js': ['vendor/kicanvas.js', 'text/javascript'], 'symbols.ttf': ['vendor/symbols.ttf', 'font/ttf']};

class KiCadRuntimeManager {
  constructor() {this.sessions = new Map();}
  async open(file, artifactHash, projectRoot) {
    if (!isKiCadFile(file)) throw Error('Choose a .kicad_pcb or .kicad_sch file.');
    const root = fs.realpathSync(projectRoot);
    const base = path.dirname(file), sources = [], seen = new Set(), active = new Set();
    let total = 0;
    const visit = source => {
      if (active.has(source)) throw Error('Cyclic KiCad sheet reference.');
      if (seen.has(source)) return;
      seen.add(source);
      active.add(source);
      if (sources.length >= limits.files) throw Error('KiCad project exceeds Viewer file count limit.');
      const entry = readBounded(source, root);
      total += entry.data.length;
      if (total > limits.totalBytes) throw Error('KiCad project exceeds Viewer total size limit.');
      const name = path.relative(base, source).split(path.sep).join('/');
      sources.push({...entry, path: source, name});
      const sheets = inspectSource(entry.data.toString('utf8'), path.extname(source));
      for (const reference of sheets) {
        if (typeof reference !== 'string' || path.isAbsolute(reference) || reference.includes('\\') || reference.includes('\0') || /[:$]/.test(reference) || path.extname(reference) !== '.kicad_sch') throw Error('Unsupported KiCad sheet reference.');
        const child = path.resolve(path.dirname(source), reference);
        if (!child.startsWith(base + path.sep)) throw Error('KiCad sheet is outside the selected document directory.');
        visit(child);
      }
      active.delete(source);
    };
    visit(file);
    if (sources[0].sha256 !== artifactHash) throw Error('KiCad source changed; reopen the file.');
    const token = crypto.randomUUID();
    this.sessions.clear();
    this.sessions.set(token, {root, sources});
    return {token, name: path.basename(file), document: path.extname(file) === '.kicad_pcb' ? 'board' : 'schematic', url: `app://kicad/${token}/index.html`};
  }
  async handle(request) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'app:' || url.hostname !== 'kicad' || (request.method && request.method !== 'GET')) return new Response('Forbidden', {status: 403});
      const parts = url.pathname.split('/').slice(1);
      const session = this.sessions.get(parts[0]);
      if (!session) return new Response('Unknown KiCad view', {status: 404});
      const resource = parts.slice(1).join('/');
      // Recheck every companion, including its real path; serve the exact verified snapshot.
      for (const entry of session.sources) {
        const current = readBounded(entry.path, session.root);
        if (current.file !== entry.file || current.sha256 !== entry.sha256) return new Response('KiCad source changed; reopen the file.', {status: 409, headers});
      }
      if (resource === 'index.html') return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="embed.css"></head><body><script type="module" src="bridge.js"></script></body></html>', {headers: {...headers, 'Content-Type': 'text/html'}});
      if (resource === 'manifest.json') return new Response(JSON.stringify({sources: session.sources.map((entry, index) => ({name: entry.name, sha256: entry.sha256, url: `source/${index}`}))}), {headers: {...headers, 'Content-Type': 'application/json'}});
      if (/^source\/(0|[1-9]\d*)$/.test(resource)) {
        const entry = session.sources[Number(resource.split('/')[1])];
        if (entry) return new Response(entry.data, {headers: {...headers, 'Content-Type': 'text/plain; charset=utf-8'}});
      }
      if (Object.hasOwn(assets, resource)) {
        const [relative, type] = assets[resource];
        return new Response(fs.readFileSync(path.join(__dirname, relative)), {headers: {...headers, 'Content-Type': type}});
      }
      return new Response('Not found', {status: 404, headers});
    } catch {return new Response('KiCad source unavailable; reopen the file.', {status: 409, headers});}
  }
  close() {this.sessions.clear();}
}
module.exports = {KiCadRuntimeManager, isKiCadFile, inspectSource, limits};
