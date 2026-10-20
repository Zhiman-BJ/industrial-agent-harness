#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyCatalog, digest } = require('../packages/pack-manager/src/index.cjs');

function runGh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    // Large signed installers need more time than release metadata requests.
    timeout: args[1] === 'upload' ? 10 * 60 * 1000 : 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw Error(`gh ${args[0]} ${args[1]} failed: ${result.stderr}`);
  return result.status === 0;
}

// Pack trust comes from the catalog signature, independently of Core code signing.
// Authenticate every referenced archive before changing the public feed. Upload
// archives before the catalog so readers never see a catalog with missing files.
function publishFeed({ directory, channel, keys, macSigning, winSigning, sha }, gh = runGh) {
  if (!['beta', 'stable'].includes(channel)) throw Error('Invalid Desktop feed channel.');
  const catalogFile = path.join(directory, 'catalog.json');
  const catalog = verifyCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')), keys);
  if (catalog.channel !== channel) throw Error('Pack catalog channel does not match the feed.');
  const archives = catalog.packs.map(entry => {
    if (!/^[a-zA-Z0-9._-]+\.hpack$/.test(entry.url))
      throw Error('Published Pack archives must use local .hpack filenames.');
    const file = path.join(directory, entry.url);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256)
      throw Error(`Pack archive integrity mismatch: ${entry.url}`);
    return file;
  });
  const tag = `desktop-${channel}-feed`;
  if (!gh(['release', 'view', tag], { allowFailure: true }))
    gh([
      'release',
      'create',
      tag,
      '--target',
      sha,
      '--prerelease',
      '--title',
      `Desktop ${channel} update feed`,
      '--notes',
      'Signed Domain Pack catalog and archives. Core update assets require signed installers.',
    ]);
  const upload = file => gh(['release', 'upload', tag, file, '--clobber']);
  for (const file of new Set(archives)) upload(file);
  upload(catalogFile);

  // Preserve an existing signed Core feed when publishing unsigned installers.
  // Neither unsigned binaries nor their update manifests enter the shared feed.
  const corePublished = macSigning === 'signed' && winSigning === 'signed';
  if (corePublished) {
    const files = fs
      .readdirSync(directory)
      .filter(name => /\.(?:dmg|zip|exe|blockmap)$/.test(name));
    for (const file of files) upload(path.join(directory, file));
    const manifest = channel === 'beta' ? 'beta' : 'latest';
    for (const file of fs
      .readdirSync(directory)
      .filter(name => [`${manifest}.yml`, `${manifest}-mac.yml`].includes(name)))
      upload(path.join(directory, file));
  }
  return { tag, packs: archives.length, corePublished };
}

module.exports = { publishFeed };
if (require.main === module) {
  try {
    const result = publishFeed({
      directory: path.resolve(process.argv[2] || 'release-assets'),
      channel: process.env.HARNESS_RELEASE_CHANNEL,
      keys: JSON.parse(fs.readFileSync(process.env.HARNESS_PACK_PUBLIC_KEYS_FILE, 'utf8')),
      macSigning: process.env.MAC_SIGNING,
      winSigning: process.env.WIN_SIGNING,
      sha: process.env.GITHUB_SHA,
    });
    console.log(`Published ${result.packs} signed Packs to ${result.tag}.`);
    console.log(
      result.corePublished ? 'Published Core OTA assets.' : 'Skipped unsigned Core OTA assets.',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
