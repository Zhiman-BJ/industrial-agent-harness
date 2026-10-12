const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDependencyResolver } = require('./runtime-dependencies.cjs');
test('Runtime dependencies resolve only exact owner pins and reject undeclared paths', () => {
  const resolve = createDependencyResolver({ '@modelcontextprotocol/sdk': '1.30.1' });
  const file = resolve('@modelcontextprotocol/sdk/client/index.js');
  assert.equal(typeof require(file).Client, 'function');
  for (const request of [
    'ajv',
    'node:fs',
    '@modelcontextprotocol/sdk/../package.json',
    file,
    '@modelcontextprotocol/sdk\\client\\index.js',
  ])
    assert.throws(() => resolve(request));
  for (const dependencies of [
    null,
    [],
    { '@modelcontextprotocol/sdk': '^1.30.1' },
    { '@modelcontextprotocol/sdk': '1.29.1' },
    { undeclared: '1.0.0' },
  ])
    assert.throws(() => createDependencyResolver(dependencies));
});
test('Project node_modules cannot replace a pinned Runtime dependency', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-dependency-project-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const impostor = path.join(directory, 'node_modules/ajv');
  fs.mkdirSync(impostor, { recursive: true });
  fs.writeFileSync(
    path.join(impostor, 'package.json'),
    JSON.stringify({ name: 'ajv', version: '8.17.1', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(impostor, 'index.js'),
    'throw Error("untrusted project dependency loaded");',
  );
  const current = process.cwd();
  try {
    process.chdir(directory);
    const resolved = createDependencyResolver({ ajv: '8.17.1' })('ajv');
    assert.ok(!resolved.startsWith(directory + path.sep));
    assert.equal(typeof require(resolved), 'function');
  } finally {
    process.chdir(current);
  }
});
