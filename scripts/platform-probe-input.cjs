const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// This is a publisher-local build input. Consumers trust the resulting signed
// hpack, never a remote unsigned component index or its executable paths.
function inspectPlatformProbe(indexFile, { owner, sourceCommit }) {
  const input = path.resolve(indexFile);
  const base = fs.realpathSync(path.dirname(input));
  function regular(relative) {
    if (
      typeof relative !== 'string' ||
      !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(relative) ||
      relative.split('/').some(part => part === '.' || part === '..')
    )
      throw Error('Unsafe platform component path.');
    let file = base;
    for (const part of relative.split('/')) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink())
        throw Error('Platform components cannot contain symlinks.');
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1)
      throw Error('Platform component must be an ordinary file.');
    return { file, stat };
  }
  regular(path.basename(input));
  const index = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (
    index.schemaVersion !== 2 ||
    index.kind !== 'platform-components' ||
    index.sourceState !== 'committed' ||
    index.sourceCommit !== sourceCommit ||
    !/^[a-f0-9]{40}$/.test(sourceCommit)
  )
    throw Error('Platform probe must be built from the pinned committed Pack owner.');
  const sourceFiles = Object.fromEntries(
    Object.entries(require(path.join(owner.root, 'content-lock.json')).files).filter(([file]) =>
      file.startsWith('mcp/environment-probe/'),
    ),
  );
  const sorted = object =>
    JSON.stringify(Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)));
  if (!Object.keys(sourceFiles).length || sorted(index.sourceFiles) !== sorted(sourceFiles))
    throw Error('Platform probe sources do not match the pinned Pack owner.');
  owner.verifyIntegrity();
  if (!Array.isArray(index.components) || !index.components.length)
    throw Error('Missing platform components.');
  const components = new Map();
  for (const component of index.components) {
    if (
      component.id !== 'environment-probe' ||
      !/^(darwin-arm64|linux-x64)$/.test(component.platform) ||
      components.has(component.platform) ||
      component.file !== `${component.platform}/industrial-environment-probe` ||
      !/^[a-f0-9]{64}$/.test(component.sha256) ||
      !Number.isSafeInteger(component.sizeBytes) ||
      component.sizeBytes < 1 ||
      component.sizeBytes > 32 * 1024 * 1024
    )
      throw Error('Invalid platform probe component.');
    const { file, stat } = regular(component.file);
    if (stat.size !== component.sizeBytes || hash(fs.readFileSync(file)) !== component.sha256)
      throw Error('Platform probe bytes differ from the build index.');
    components.set(component.platform, { ...component, source: file });
  }
  return components;
}
module.exports = { inspectPlatformProbe };
