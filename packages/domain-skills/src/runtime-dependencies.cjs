const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Resolve only the published owner's pinned dependency graph. Project files and
// installed Pack directories cannot contribute Node search paths or packages.
function createDependencyResolver(dependencies = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
    throw Error('Runtime dependencies must be an exact-version map.');
  const ownerEntry = require.resolve('@zhiman-bj/industrial-domain-packs');
  const ownerRoot = path.dirname(path.dirname(ownerEntry));
  const ownerRequire = createRequire(ownerEntry);
  const declared = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'package.json'))).dependencies || {};
  const roots = new Map();
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
        !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version) || declared[name] !== version)
      throw Error('Runtime dependency is not pinned by the published Pack owner: ' + name);
    let root = path.dirname(ownerRequire.resolve(name + '/package.json'));
    while (true) {
      const file = path.join(root, 'package.json');
      const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
      if (manifest.name === name) {
        if (manifest.version !== version) throw Error('Runtime dependency version differs from its declaration: ' + name);
        roots.set(name, fs.realpathSync(root)); break;
      }
      const parent = path.dirname(root);
      if (parent === root) throw Error('Runtime dependency package identity is missing: ' + name);
      root = parent;
    }
  }
  return request => {
    if (typeof request !== 'string' || request.includes('\\') ||
        request.split('/').some(part => !part || part === '.' || part === '..'))
      throw Error('Invalid Runtime dependency request.');
    const parts = request.split('/');
    const name = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const root = roots.get(name);
    if (!root) throw Error('Runtime dependency was not declared: ' + name);
    const resolved = fs.realpathSync(ownerRequire.resolve(request));
    if (!resolved.startsWith(root + path.sep) || !fs.statSync(resolved).isFile())
      throw Error('Runtime dependency module escaped its verified package: ' + request);
    return resolved;
  };
}
module.exports = { createDependencyResolver };
