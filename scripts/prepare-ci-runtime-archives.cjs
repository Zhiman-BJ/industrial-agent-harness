#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Transfer } = require('../packages/pack-manager/src/transfer.cjs');

function archiveDeclarations(directory) {
  const { packSourceDirectory } = require('../packages/domain-skills/src/index.cjs');
  const { loadDomainPacks } = require('../packages/domain-skills/src/packs.cjs');
  const packs = loadDomainPacks();
  return [
    ['cad', 'freecad-pack'],
    ['pcb', 'pcb-pack'],
    ['godot', 'godot-pack'],
  ].map(([domain, id]) => {
    const assets = packs
      .find(pack => pack.id === id)
      ?.runtimeAssets?.filter(asset => ['macos-app-dmg', 'macos-app-zip'].includes(asset.type));
    if (assets?.length !== 1) throw Error(`Expected one declared CI runtime archive: ${id}`);
    const asset = assets[0];
    // The mirror is addressed by digest; retain the vendor archive filename
    // for existing native setup caches without downloading from that vendor.
    let archive = path.basename(new URL(asset.upstreamUrl || asset.url).pathname);
    if (domain !== 'cad') {
      const lock = JSON.parse(
        fs.readFileSync(path.join(packSourceDirectory(id), 'runtime/native-dependency.json')),
      );
      if (lock.sha256 !== asset.sha256 || lock.url !== asset.url)
        throw Error(`Owner setup and managed archive declarations differ: ${id}`);
      archive = lock.archive;
    }
    if (!archive || archive !== path.basename(archive) || archive.includes('\\'))
      throw Error(`Unsafe owner archive name: ${id}`);
    return {
      ...asset,
      file: path.resolve(directory, `${domain === 'cad' ? 'freecad' : domain}-runtime`, archive),
    };
  });
}

async function verifyArchive(asset, file) {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw Error(`Invalid owner archive identity: ${asset.id}`);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size !== asset.size)
    throw Error(`CI runtime archive size mismatch: ${asset.id}`);
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  if (hash.digest('hex') !== asset.sha256)
    throw Error(`CI runtime archive SHA-256 mismatch: ${asset.id}`);
}

// Prepare bytes only. Tests still use fresh stores and the production installer
// repeats SHA-256, extraction, signature, executable and version verification.
async function prepareArchives(assets, { download = false, fetchImpl } = {}) {
  const archives = {};
  for (const asset of assets) {
    if (!fs.existsSync(asset.file)) {
      if (!download) throw Error(`Missing prepared official archive: ${asset.file}`);
      if (new URL(asset.url).protocol !== 'https:')
        throw Error('Official runtime archives require HTTPS.');
      fs.mkdirSync(path.dirname(asset.file), { recursive: true });
      const temporary = `${asset.file}.${crypto.randomUUID()}.partial`;
      try {
        await new Transfer().run(async transfer => {
          const response = fetchImpl
            ? await fetchImpl(asset.url)
            : await transfer.response(asset.url);
          if (!response.ok || !response.body)
            throw Error(`Official runtime download failed: ${asset.id} (${response.status})`);
          const chunks = async function* () {
            for await (const chunk of response.body) {
              transfer.touch();
              yield chunk;
            }
          };
          await pipeline(
            Readable.from(chunks()),
            fs.createWriteStream(temporary, { flags: 'wx' }),
            { signal: transfer.signal },
          );
        });
        await verifyArchive(asset, temporary);
        fs.renameSync(temporary, asset.file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    } else await verifyArchive(asset, asset.file);
    archives[asset.id] = asset.file;
  }
  return archives;
}

async function main() {
  const archives = await prepareArchives(archiveDeclarations(path.resolve('dist')), {
    download: process.argv.includes('--download'),
  });
  if (process.env.GITHUB_ENV)
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `HARNESS_RUNTIME_ARCHIVES=${JSON.stringify(archives)}\nHARNESS_FREECAD_ARCHIVE=${archives.freecad}\n`,
    );
  console.log(JSON.stringify({ verifiedArchives: archives, preparedApps: 0 }));
}

module.exports = { archiveDeclarations, prepareArchives };
if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
