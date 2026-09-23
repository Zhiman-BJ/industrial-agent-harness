const fs = require('node:fs');
const path = require('node:path');

function initialVcdSignals(file) {
  if (path.extname(file).toLowerCase() !== '.vcd') return [];
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 1024 * 1024));
  try {fs.readSync(fd, buffer, 0, buffer.length, 0);} finally {fs.closeSync(fd);}
  const header = buffer.toString('utf8').split('$enddefinitions')[0];
  const scopes = [];
  const signals = [];
  for (const match of header.matchAll(/\$(scope|upscope|var)\s+([^]*?)\$end/g)) {
    const fields = match[2].trim().split(/\s+/);
    if (match[1] === 'scope') scopes.push(fields[1]);
    else if (match[1] === 'upscope') scopes.pop();
    else if (match[1] === 'var' && scopes.length && fields.length >= 4) {
      const name = fields[3];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Z_0-9]+$/.test(name)) signals.push([...scopes, name].join('.'));
    }
  }
  const preferred = ['clk', 'rst_n', 'reset', 'in_valid', 'in_pixel', 'out_valid', 'out_pixel'];
  const shallowest = new Map();
  for (const signal of signals) {
    const name = signal.split('.').at(-1);
    if (!shallowest.has(name) || signal.split('.').length < shallowest.get(name).split('.').length) shallowest.set(name, signal);
  }
  return [...shallowest.values()].sort((a, b) => {
    const score = name => {const index = preferred.indexOf(name.split('.').at(-1)); return index < 0 ? preferred.length : index;};
    return score(a) - score(b);
  }).slice(0, 6);
}

module.exports = {initialVcdSignals};
