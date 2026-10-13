// Explicit legacy/standalone fixture: this pack is intentionally absent from
// the product's offered catalog. Never use it to populate default choices.
const fs = require('node:fs');
const path = require('node:path');
const owner = require('@zhiman-bj/industrial-domain-packs');
const source = owner.sourceDirectory('cuda-pack');
const pack = require(path.join(source, 'harness-pack.json'));
const skill = {
  id: 'cuda.kernel.optimize', domain: 'cuda', title: 'CUDA kernel optimization',
  file: 'skills/cuda.kernel.optimize/SKILL.md',
};
function registry() {
  return {
    domains: [{ id: 'cuda', label: 'CUDA', emoji: '⚡' }],
    capabilities: pack.capabilities,
    skills: [{ ...skill, file: path.join(source, 'skills/cuda-kernel-optimize/SKILL.md') }],
    providerPacks: [pack],
    runtimePacks: [{
      id: pack.id, domain: pack.domain, version: pack.version, runtime: pack.runtime,
      directory: source,
      resolveDependency: require('../../packages/domain-skills/src/runtime-dependencies.cjs')
        .createDependencyResolver(pack.runtime.dependencies),
      runtimeProtectedPaths: [owner.root],
    }],
  };
}
function writeBundle(directory, { transportFixturePlatform } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(source, path.join(directory, 'domain-packs/cuda'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'skills/cuda.kernel.optimize'), { recursive: true });
  fs.copyFileSync(path.join(source, 'skills/cuda-kernel-optimize/SKILL.md'), path.join(directory, skill.file));
  const bundle = {
    schemaVersion: 1, domain: 'cuda', label: 'CUDA', emoji: '⚡', version: pack.version,
    coreApi: 1, sourceRelease: owner.identity, capabilities: pack.capabilities,
    skills: [skill], providerPacks: [pack], runtimeAssets: [],
    executionProfiles: transportFixturePlatform
      ? pack.executionProfiles.map(profile => ({ ...profile, platforms: [transportFixturePlatform] }))
      : pack.executionProfiles,
  };
  fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify(bundle));
  return bundle;
}
module.exports = { registry, writeBundle };
