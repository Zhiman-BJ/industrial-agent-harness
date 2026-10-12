#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createArchive, digest, signCatalog } = require('../packages/pack-manager/src/index.cjs');
const owner = require('@zhiman-bj/industrial-domain-packs');
const metadata = owner.consumerMetadata();
const ownerPin =
  require('../package.json').dependencies['@zhiman-bj/industrial-domain-packs'].match(
    /\/([a-f0-9]{40})$/,
  )?.[1];
const defaultProbeIndex = path.resolve(
  __dirname,
  '../dist/platform-probe/platform-probe-index.json',
);
const probeIndex =
  process.env.HARNESS_PLATFORM_PROBE_INDEX ||
  (fs.existsSync(defaultProbeIndex) ? defaultProbeIndex : null);
const probes = probeIndex
  ? require('./platform-probe-input.cjs').inspectPlatformProbe(probeIndex, {
      owner,
      sourceCommit: ownerPin,
    })
  : null;
const developmentProbe =
  process.env.HARNESS_ALLOW_JS_ENVIRONMENT_PROBE === '1' &&
  process.env.HARNESS_RELEASE_BUILD !== '1' &&
  !process.env.HARNESS_PACK_SIGNING_KEY_FILE;
const capabilities = metadata.capabilities;
const { loadDomainPacks } = require('../packages/domain-skills/src/packs.cjs');
const { listSkills, skillPackaging } = require('../packages/domain-skills/src/consumer.cjs');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist', 'domain-packs'));
const channel = process.env.HARNESS_PACK_CHANNEL || 'beta';
if (!['stable', 'beta'].includes(channel)) throw Error('Invalid Pack channel.');
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
  const platforms = [
    ...new Set(
      (process.env.HARNESS_PACK_PLATFORMS || `${process.platform}-${process.arch}`).split(','),
    ),
  ].filter(
    platform =>
      !declaration.qualifiedBundlePlatforms ||
      declaration.qualifiedBundlePlatforms.includes(platform),
  );
  if (!platforms.length) continue;
  const directory = path.join(output, domain);
  fs.mkdirSync(directory, { recursive: true });
  const providers = providerPacks.filter(pack => pack.domain === domain);
  const executionProfiles = providers.flatMap(pack => pack.executionProfiles || []);
  const nativePlatforms = [
    ...new Set(
      executionProfiles
        .filter(profile => profile.kind === 'native' && profile.assetIds.length)
        .flatMap(profile => profile.platforms.filter(platform => platforms.includes(platform))),
    ),
  ];
  let platformProbe;
  if (nativePlatforms.length) {
    if (nativePlatforms.length !== 1 || platforms.some(platform => platform !== nativePlatforms[0]))
      throw Error('Build native Pack components for one platform at a time.');
    const component = probes?.get(nativePlatforms[0]);
    if (!component && !developmentProbe)
      throw Error(
        `Set HARNESS_PLATFORM_PROBE_INDEX to a trusted committed platform build for ${domain}. Source-only development tests may explicitly set HARNESS_ALLOW_JS_ENVIRONMENT_PROBE=1.`,
      );
    if (component) {
      platformProbe = {
        schemaVersion: 1,
        platform: component.platform,
        file: `components/${component.file}`,
        sha256: component.sha256,
        sizeBytes: component.sizeBytes,
      };
      const target = path.join(directory, platformProbe.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(component.source, target);
      fs.chmodSync(target, 0o755);
    }
  }
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
    executionProfiles,
    ...(platformProbe ? { platformProbe } : {}),
  };
  fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  const archive = createArchive(directory);
  const file = `${domain}-${version}.hpack`;
  fs.writeFileSync(path.join(output, file), archive);
  entries.push({
    domain,
    label,
    emoji,
    version,
    summary: bundle.summary,
    prerequisites: bundle.prerequisites,
    sha256: digest(archive),
    size: archive.length,
    executionProfiles: bundle.executionProfiles,
    runtimeDownloadSize: bundle.runtimeAssets.reduce((sum, asset) => sum + asset.size, 0),
    runtimeInstalledSize: bundle.runtimeAssets.reduce(
      (sum, asset) => sum + (asset.installedSize || asset.size * 4),
      0,
    ),
    runtimeAssets: bundle.runtimeAssets,
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
