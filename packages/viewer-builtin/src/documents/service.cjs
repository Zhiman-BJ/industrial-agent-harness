const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');

const limits = Object.freeze({bytes: 4 * 1024 * 1024, markdownBytes: 256 * 1024, lines: 100000, rows: 100000, columns: 256, cells: 250000, jsonNodes: 100000, depth: 64});
const extensions = Object.freeze({table: ['.csv', '.tsv'], json: ['.json'], jsonl: ['.jsonl', '.ndjson'], markdown: ['.md', '.markdown'], text: ['.txt', '.log']});

function readDocument(file, projectRoot, artifact, limit) {
  const root = fs.realpathSync(projectRoot);
  const canonical = fs.realpathSync(file);
  const relative = path.relative(root, canonical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Document is outside the selected project.');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw Error('Document is not a file.');
    if (before.size > limit) throw Error(`Document exceeds the ${limit / 1024 / 1024} MiB Viewer limit. Use an external editor for this file.`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('Document changed; reopen the file.');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.statSync(canonical);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || fs.realpathSync(file) !== canonical || fs.realpathSync(projectRoot) !== root || crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw Error('Document changed; reopen the file.');
    if (bytes.includes(0)) throw Error('Document contains binary data; UTF-8 text is required.');
    let text;
    try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);}
    catch {throw Error('Document is not valid UTF-8 text.');}
    let lines = 1;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n' && ++lines > limits.lines) throw Error('Document exceeds the line limit. Use an external editor for this file.');
    return text;
  } finally {fs.closeSync(fd);}
}

// RFC-style quoted fields, doubled quotes, embedded newlines, and empty cells.
// Values remain strings: spreadsheet formulas and large numeric IDs are inert.
function parseDelimited(source, delimiter) {
  const text = source.replace(/^\uFEFF/, '');
  if (!text.length) return {rows: [], columns: 0, ragged: false};
  const rows = [];
  let row = [], field = '', state = 'start', cells = 0, ended = false;
  const cell = () => {
    if (row.length >= limits.columns || ++cells > limits.cells) throw Error('Table exceeds the column/cell limit.');
    row.push(field); field = ''; state = 'start';
  };
  const record = () => {
    cell();
    if (rows.length >= limits.rows) throw Error('Table exceeds the row limit.');
    rows.push(row); row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; ended = false;
    if (state === 'quoted') {
      if (c === '"') {
        if (text[i + 1] === '"') {field += '"'; i++;}
        else state = 'closed';
      } else field += c;
    } else if (c === delimiter) cell();
    else if (c === '\r' || c === '\n') {
      record(); ended = true;
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (state === 'closed') throw Error('Unexpected text after a quoted field.');
    else if (c === '"') {
      if (state !== 'start') throw Error('Unexpected quote in an unquoted field.');
      state = 'quoted';
    } else {field += c; state = 'plain';}
  }
  if (state === 'quoted') throw Error('Unclosed quoted field.');
  if (!ended) record();
  return {rows, columns: rows.reduce((max, item) => Math.max(max, item.length), 0), ragged: rows.some(item => item.length !== rows[0].length)};
}

function validateJson(value, budget = {nodes: 0, unsafeNumbers: 0}) {
  const stack = [{value, depth: 0}];
  while (stack.length) {
    const current = stack.pop();
    if (++budget.nodes > limits.jsonNodes || current.depth > limits.depth) throw Error('JSON exceeds the node/depth limit.');
    if (typeof current.value === 'number' && (!Number.isFinite(current.value) || Number.isInteger(current.value) && !Number.isSafeInteger(current.value))) budget.unsafeNumbers++;
    if (current.value && typeof current.value === 'object') {
      const children = Object.values(current.value);
      if (budget.nodes + stack.length + children.length > limits.jsonNodes) throw Error('JSON exceeds the node/depth limit.');
      for (const child of children) stack.push({value: child, depth: current.depth + 1});
    }
  }
  return budget;
}

function parseDocument(kind, text, extension) {
  const data = {text};
  try {
    if (kind === 'table') Object.assign(data, parseDelimited(text, extension === '.tsv' ? '\t' : ','));
    if (kind === 'json') {
      const budget = validateJson(JSON.parse(text.replace(/^\uFEFF/, '')));
      if (budget.unsafeNumbers) data.warning = 'Some numbers exceed exact JavaScript representation. Source preserves the original values.';
    }
    if (kind === 'jsonl') {
      const budget = {nodes: 0, unsafeNumbers: 0};
      let records = 0;
      for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        try {validateJson(JSON.parse(line), budget);}
        catch (error) {throw Error(`Line ${index + 1}: ${error.message}`);}
        records++;
      }
      data.records = records;
      if (budget.unsafeNumbers) data.warning = 'Some numbers exceed exact JavaScript representation. Source preserves the original values.';
    }
  } catch (error) {data.error = error.message;}
  return data;
}

function createDocumentPlugins({projectRoot}) {
  return Object.entries(extensions).map(([id, formats]) => ({
    id, matches: file => formats.includes(path.extname(file).toLowerCase()),
    open: ({artifact, file}) => {
      const text = readDocument(file, projectRoot(), artifact, id === 'markdown' ? limits.markdownBytes : limits.bytes);
      return {kind: id, artifact, data: parseDocument(id, text, path.extname(file).toLowerCase())};
    },
  }));
}
module.exports = {createDocumentPlugins, parseDelimited, parseDocument, limits};
