#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { copyReleaseNotices, copyDesktopNotices } = require('./release-notices.cjs');

const root = path.resolve(__dirname, '..');
const target = path.resolve(process.argv[2] || path.join(root, 'dist', 'desktop-stage'));
if (
  !target.startsWith(path.join(root, 'dist') + path.sep) ||
  target === root ||
  fs.existsSync(target)
)
  throw Error('Use a new directory under dist for desktop staging.');
const built = path.join(root, 'apps', 'desktop', 'dist', 'index.html');
if (!fs.existsSync(built)) throw Error('Build the desktop renderer first.');
const deployed =
  process.platform === 'win32'
    ? spawnSync(
        'cmd.exe',
        [
          '/d',
          '/c',
          `pnpm --filter @industrial-agent-harness/desktop deploy --legacy --prod "${target}"`,
        ],
        { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true },
      )
    : spawnSync(
        'pnpm',
        ['--filter', '@industrial-agent-harness/desktop', 'deploy', '--legacy', '--prod', target],
        { cwd: root, stdio: 'inherit' },
      );
if (deployed.error) throw deployed.error;
if (deployed.status !== 0) process.exit(deployed.status || 1);
// Deploy omits the workspace lockfile and root packageManager field. Preserve
// the pinned manager so electron-builder collects the staged pnpm dependency
// graph instead of falling back to npm's scan of the virtual store.
const stageManifestPath = path.join(target, 'package.json');
const stageManifest = JSON.parse(fs.readFileSync(stageManifestPath, 'utf8'));
stageManifest.packageManager = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
).packageManager;
fs.writeFileSync(stageManifestPath, JSON.stringify(stageManifest, null, 2) + '\n');
// Legacy deploy can retain the root application's self-link to its checkout.
const selfLink = path.join(
  target,
  'node_modules',
  '.pnpm',
  'node_modules',
  '@industrial-agent-harness',
  'desktop',
);
if (fs.lstatSync(selfLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
  fs.unlinkSync(selfLink);
  fs.symlinkSync(path.relative(path.dirname(selfLink), target), selfLink, 'dir');
}
copyReleaseNotices(target);
copyDesktopNotices(target);
for (const name of ['.venv-kimi', '.venv-klayout', 'src', 'scripts', 'viewer-host'])
  fs.rmSync(path.join(target, name), { recursive: true, force: true });
const requireFromApp = createRequire(path.join(target, 'electron', 'main.cjs'));
requireFromApp.resolve('../i18n.config.json');
// electron-builder removes lock files from node_modules by default. Stage the
// complete immutable release separately so its content lock remains valid.
const packRelease = requireFromApp('@zhiman-bj/industrial-domain-packs');
fs.cpSync(packRelease.root, path.join(target, 'domain-pack-release'), {
  recursive: true,
  filter: file => path.basename(file) !== 'node_modules',
});
const skillsRoot = path.dirname(
  path.dirname(requireFromApp.resolve('@industrial-agent-harness/domain-skills')),
);
const { listSkills, skillFile } = require(path.join(skillsRoot, 'src/consumer.cjs'));
const commonSkills = listSkills().filter(skill => skill.domain === '*');
const commonDirectories = new Set(
  commonSkills.map(skill => path.basename(path.dirname(skillFile(skill.id)))),
);
// Professional Skills ship in installable Packs; common Skills belong to Core.
for (const name of fs.readdirSync(path.join(skillsRoot, 'skills')))
  if (!commonDirectories.has(name))
    fs.rmSync(path.join(skillsRoot, 'skills', name), { recursive: true, force: true });
const packsDirectory = path.join(skillsRoot, 'packs');
fs.rmSync(packsDirectory, { recursive: true, force: true });
fs.mkdirSync(packsDirectory);
for (const skill of commonSkills) skillFile(skill.id);
for (const packageName of [
  '@industrial-agent-harness/viewer-builtin/runtime/layout',
  '@industrial-agent-harness/viewer-builtin/runtime/godot',
  '@industrial-agent-harness/agent-kimi',
  '@industrial-agent-harness/pack-manager',
  'electron-updater',
])
  requireFromApp.resolve(packageName);
const feedUrl = process.env.HARNESS_PACK_CATALOG_URL;
const keysFile = process.env.HARNESS_PACK_PUBLIC_KEYS_FILE;
const coreUrl = process.env.HARNESS_CORE_UPDATE_URL;
if (process.env.HARNESS_RELEASE_BUILD === '1' && (!feedUrl || !keysFile || !coreUrl))
  throw Error('Release build requires Pack catalog, public keys and Core update URL.');
const keys = keysFile ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : {};
const channel = process.env.HARNESS_RELEASE_CHANNEL || 'beta';
if (!['stable', 'beta'].includes(channel)) throw Error('Invalid release channel.');
// Core-owned optional Packs let first install and add-ons work without a feed.
// It remains a user-selected Pack, never a pre-enabled project resource.
const bootstrapDomains =
  process.env.HARNESS_BOOTSTRAP_DOMAINS ??
  (process.platform === 'darwin' && process.arch === 'arm64'
    ? packRelease
        .consumerMetadata()
        .domains.filter(
          item =>
            !item.qualifiedBundlePlatforms ||
            item.qualifiedBundlePlatforms.includes(`${process.platform}-${process.arch}`),
        )
        .map(item => item.id)
        .join(',')
    : '');
const bootstrap = path.join(target, 'bootstrap-packs');
if (bootstrapDomains) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/build-pack-distribution.cjs'), bootstrap],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        INDUSTRIAL_HARNESS_PACK_STORE: '',
        HARNESS_PACK_DOMAINS: bootstrapDomains,
        HARNESS_PACK_PLATFORMS: `${process.platform}-${process.arch}`,
        HARNESS_PACK_SIGNING_KEY_FILE: '',
      },
    },
  );
  if (result.status !== 0) throw Error('Could not prepare bundled optional Packs.');
  for (const name of fs.readdirSync(bootstrap))
    if (fs.statSync(path.join(bootstrap, name)).isDirectory())
      fs.rmSync(path.join(bootstrap, name), { recursive: true });
} else {
  fs.mkdirSync(bootstrap);
  fs.writeFileSync(
    path.join(bootstrap, 'catalog.unsigned.json'),
    JSON.stringify({ schemaVersion: 1, packs: [] }),
  );
}
if (process.env.HARNESS_RELEASE_BUILD === '1') {
  for (const [name, value] of [
    ['Pack catalog', feedUrl],
    ['Core update', coreUrl],
  ])
    if (new URL(value).protocol !== 'https:') throw Error(`${name} URL must use HTTPS.`);
  if (
    !Object.keys(keys).length ||
    Object.values(keys).some(
      value => typeof value !== 'string' || !value.includes('BEGIN PUBLIC KEY'),
    )
  )
    throw Error('Release build requires Pack verification public keys.');
}
fs.writeFileSync(
  path.join(target, 'pack-feed.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      channel,
      catalogUrl: feedUrl || null,
      publicKeys: keys,
      coreUpdateEnabled: Boolean(coreUrl),
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`${target}\n`);
