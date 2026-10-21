#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createArchive, digest, signCatalog } = require('../packages/pack-manager/src/index.cjs');
const owner = require('@zhiman-bj/industrial-domain-packs');
const metadata = owner.consumerMetadata();
const {
  LOCK_PATH,
  validateDistributionLock,
  resolveImageAsset,
} = require('../packages/pack-manager/src/container-images.cjs');
const distributionBytes = fs.readFileSync(path.join(owner.root, LOCK_PATH));
const distributionLock = validateDistributionLock(JSON.parse(distributionBytes));
const capabilities = metadata.capabilities;
const { loadDomainPacks } = require('../packages/domain-skills/src/packs.cjs');
const { listSkills, skillPackaging } = require('../packages/domain-skills/src/consumer.cjs');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist', 'domain-packs'));
const channel = process.env.HARNESS_PACK_CHANNEL || 'beta';
if (!['stable', 'beta'].includes(channel)) throw Error('Invalid Pack channel.');
// Qualification hosts without Docker (GitHub-hosted macOS) prove the native path
// from bundles that keep the owner lock but advertise no container images, so
// PackManager.prepareRuntime never reaches the Docker preflight. Production
// catalogs cannot omit images: the switch is bound to the qualification identity.
const omitContainerImages = process.env.HARNESS_PACK_OMIT_CONTAINER_IMAGES === '1';
if (omitContainerImages && process.env.HARNESS_PACK_SIGNING_KEY_ID !== 'qualification')
  throw Error(
    'HARNESS_PACK_OMIT_CONTAINER_IMAGES is only valid for qualification builds signed with HARNESS_PACK_SIGNING_KEY_ID=qualification.',
  );
if (fs.existsSync(output)) throw Error(`Output already exists: ${output}`);
fs.mkdirSync(output, { recursive: true });
const providerPacks = loadDomainPacks();
const entries = [];
const selectedDomains = process.env.HARNESS_PACK_DOMAINS?.split(',');
if (selectedDomains?.some(domain => !metadata.domains.some(item => item.id === domain)))
  throw Error('Unknown build Domain.');
for (const declaration of metadata.domains) {
  const { id: domain, label, emoji, version, ...features } = declaration;
  if (selectedDomains && !selectedDomains.includes(domain)) continue;
  const platforms = (process.env.HARNESS_PACK_PLATFORMS || `${process.platform}-${process.arch}`)
    .split(',')
    .filter(
      platform =>
        !declaration.qualifiedBundlePlatforms ||
        declaration.qualifiedBundlePlatforms.includes(platform),
    );
  if (!platforms.length) continue;
  const directory = path.join(output, domain);
  fs.mkdirSync(directory, { recursive: true });
  const providers = providerPacks.filter(pack => pack.domain === domain);
  const releasedImages = distributionLock.images
    .filter(image => image.pack === domain && image.current != null)
    .map(image => image.id);
  const containerImages = omitContainerImages ? [] : releasedImages;
  if (omitContainerImages && releasedImages.length)
    process.stderr.write(
      `${domain}: omitting released container images ${releasedImages.join(', ')} from the qualification bundle; the owner lock stays embedded.\n`,
    );
  const containerDownloadSize = containerImages.reduce(
    (total, image) => total + resolveImageAsset({ lock: distributionLock }, image).bytes,
    0,
  );
  // Preserve the immutable owner's lock verbatim inside the authenticated Pack.
  // Unreleased entries remain discoverable but are not advertised as prepared.
  fs.mkdirSync(path.join(directory, 'provenance'), { recursive: true });
  fs.writeFileSync(path.join(directory, LOCK_PATH), distributionBytes);
  const skills = listSkills(domain)
    .filter(item => item.domain !== '*')
    .map(item => ({
      id: item.id,
      domain: item.domain,
      title: item.title,
      file: `skills/${item.id}/SKILL.md`,
      ...(skillPackaging(item.id).external ? { external: skillPackaging(item.id).external } : {}),
    }));
  for (const skill of skills) {
    const target = path.join(directory, ...skill.file.split('/'));
    const { copySkillResources } = require('../packages/domain-skills/src/skill-resources.cjs');
    const resource = skillPackaging(skill.id);
    copySkillResources(resource.source, path.dirname(target));
  }
  for (const pack of providers) {
    const source = owner.sourceDirectory(pack.id);
    const destination = path.join(directory, 'domain-packs', pack.provider.packDirectory);
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: false,
      filter: file => {
        if (fs.lstatSync(file).isSymbolicLink())
          throw Error('Pack resources cannot contain symlinks.');
        return (
          ![
            '.venv',
            '.venv-kimi',
            'node_modules',
            '__pycache__',
            '.DS_Store',
            '.git',
            'dist',
            '.pytest_cache',
            '.ruff_cache',
          ].includes(path.basename(file)) && !file.endsWith('.pyc')
        );
      },
    });
  }
  for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const noticeFile = path.join(
      path.dirname(path.dirname(require.resolve('@zhiman-bj/industrial-domain-packs'))),
      notice,
    );
    if (!fs.existsSync(noticeFile)) throw Error(`Missing Pack license material: ${notice}`);
    fs.copyFileSync(noticeFile, path.join(directory, notice));
  }
  const bundle = {
    schemaVersion: 1,
    domain,
    label,
    emoji,
    version,
    coreApi: 1,
    ...features,
    sourceRelease: owner.identity,
    capabilities: [
      ...capabilities.filter(item => item.domain === domain),
      ...providers.flatMap(pack => pack.capabilities),
    ],
    skills,
    providerPacks: providers,
    runtimeAssets: providers.flatMap(pack => pack.runtimeAssets || []),
    pythonEnvironments: providers.flatMap(pack => pack.pythonEnvironments || []),
    dataLibraries: providers.flatMap(pack =>
      (pack.dataLibraries || []).map(library => ({
        ...library,
        catalog: `domain-packs/${pack.provider.packDirectory}/${library.catalog}`,
      })),
    ),
    containerImages,
  };
  fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  const archive = createArchive(directory);
  const file = `${domain}-${version}.hpack`;
  fs.writeFileSync(path.join(output, file), archive);
  // A catalog can serve multiple architectures; report the largest declared
  // platform footprint. The installer computes its exact platform and cache.
  const pythonFootprints = platforms.map(platform =>
    bundle.pythonEnvironments.reduce(
      (total, environment) => {
        const asset = environment.platforms[platform];
        if (asset) {
          total.download +=
            asset.interpreter.size + asset.wheels.reduce((sum, wheel) => sum + wheel.size, 0);
          total.installed += asset.installedSize;
        }
        return total;
      },
      { download: 0, installed: 0 },
    ),
  );
  entries.push({
    domain,
    label,
    emoji,
    version,
    summary: bundle.summary,
    prerequisites: bundle.prerequisites,
    sha256: digest(archive),
    size: archive.length,
    runtimeDownloadSize:
      bundle.runtimeAssets.reduce((sum, asset) => sum + asset.size, 0) +
      Math.max(0, ...pythonFootprints.map(item => item.download)),
    runtimeInstalledSize:
      bundle.runtimeAssets.reduce(
        (sum, asset) => sum + (asset.installedSize || asset.size * 4),
        0,
      ) + Math.max(0, ...pythonFootprints.map(item => item.installed)),
    runtimeAssets: bundle.runtimeAssets,
    pythonEnvironments: bundle.pythonEnvironments,
    containerDownloadSize,
    url: file,
    platforms,
  });
}
const payload = {
  schemaVersion: 1,
  channel,
  generatedAt: new Date().toISOString(),
  packs: entries,
};
const keyFile = process.env.HARNESS_PACK_SIGNING_KEY_FILE;
if (keyFile) {
  const keyId = process.env.HARNESS_PACK_SIGNING_KEY_ID;
  if (!keyId) throw Error('Set HARNESS_PACK_SIGNING_KEY_ID.');
  fs.writeFileSync(
    path.join(output, 'catalog.json'),
    JSON.stringify(signCatalog(payload, keyId, fs.readFileSync(keyFile)), null, 2) + '\n',
  );
} else
  fs.writeFileSync(
    path.join(output, 'catalog.unsigned.json'),
    JSON.stringify(payload, null, 2) + '\n',
  );
process.stdout.write(`${output}\n`);
