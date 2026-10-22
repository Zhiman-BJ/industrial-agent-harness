#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const root = path.resolve(__dirname, '..');
// Every vendor manifest that declares `sourceArchives` participates; manifests
// without the field (for example the in-installer OCCT viewer sources) are
// skipped until they migrate.
const manifests = ['packages/viewer-builtin/src/kicad/vendor/occt-import/manifest.json'];

function sourceDeclarations() {
  return manifests.flatMap(manifest => {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, manifest)));
    return (parsed.sourceArchives || []).map(archive => {
      const url = new URL(archive.url);
      const file = path.basename(url.pathname);
      if (
        parsed.schemaVersion < 2 ||
        url.protocol !== 'https:' ||
        url.host !== 'github.com' ||
        !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname) ||
        file !== archive.file ||
        file !== path.basename(file) ||
        file.includes('\\') ||
        !/^[a-f0-9]{64}$/.test(archive.sha256) ||
        !Number.isSafeInteger(archive.bytes) ||
        archive.bytes <= 0
      )
        throw Error(`Invalid vendor source archive declaration: ${manifest} ${archive.file}`);
      return { ...archive, manifest, file };
    });
  });
}

async function verify(archive, file) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return 'missing';
  if (fs.statSync(file).size !== archive.bytes) return 'size-mismatch';
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex') === archive.sha256 ? 'ready' : 'sha256-mismatch';
}

// Bytes only. The archives exist for LGPL corresponding-source distribution
// and offline rebuilds; nothing in the build consumes them automatically.
async function fetchVendorSources({
  download = true,
  fetchImpl = global.fetch,
  directory,
  declarations = sourceDeclarations(),
} = {}) {
  const target = directory || path.join(root, 'dist', 'vendor-sources');
  const results = [];
  for (const archive of declarations) {
    const file = path.join(target, archive.file);
    const state = await verify(archive, file);
    if (state === 'ready') {
      results.push({ ...archive, state });
      continue;
    }
    if (!download || state === 'sha256-mismatch' || state === 'size-mismatch')
      throw Error(`Vendor source archive ${archive.file} is ${state}. Delete it and retry.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.partial`;
    try {
      // Large release downloads traverse a CDN that resets long-running
      // connections; resume from the kept partial bytes like curl -C -.
      const attempts = 6;
      for (let attempt = 0; ; attempt++) {
        const resume = attempt > 0 && fs.existsSync(temporary) ? fs.statSync(temporary).size : 0;
        try {
          const response = await fetchImpl(archive.url, {
            headers: resume ? { Range: `bytes=${resume}-` } : {},
          });
          if (response.status === 416 && resume > 0) {
            // The file is already complete; fall through to verification.
          } else if ((response.ok && response.status === 200) || response.status === 206) {
            // Release assets redirect to the CDN; pin the final hop to the
            // GitHub asset hosts and let the size/SHA-256 check speak for the
            // bytes. A 200 answer to a resume request restarts from zero.
            const finalUrl = new URL(response.url || archive.url);
            if (
              finalUrl.protocol !== 'https:' ||
              ![
                'github.com',
                'objects.githubusercontent.com',
                'release-assets.githubusercontent.com',
              ].includes(finalUrl.host)
            )
              throw Error(`Unexpected download host: ${finalUrl.host}`);
            const append = response.status === 206 && resume > 0;
            if (!append && resume > 0) fs.rmSync(temporary, { force: true });
            await pipeline(
              response.body,
              fs.createWriteStream(temporary, append ? { flags: 'a' } : {}),
            );
          } else throw Error(`Download failed: ${response.status}`);
          const stateAfter = await verify(archive, temporary);
          if (stateAfter === 'ready') break;
          // A byte-mismatched file can never be resumed; discard and restart.
          if (stateAfter === 'sha256-mismatch') fs.rmSync(temporary, { force: true });
          throw Error(`Verification failed (${stateAfter}).`);
        } catch (error) {
          if (attempt + 1 >= attempts)
            throw Error(`${archive.file}: ${error.message}`, { cause: error });
        }
      }
      fs.renameSync(temporary, file);
      results.push({ ...archive, state: 'ready' });
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }
  return results;
}

if (require.main === module) {
  const verifyOnly = process.argv.includes('--verify');
  fetchVendorSources({ download: !verifyOnly })
    .then(results => {
      for (const archive of results)
        console.log(`${archive.state}\t${archive.file}\t${archive.url}`);
    })
    .catch(error => {
      console.error(error.message, error.cause?.message || '');
      process.exitCode = 1;
    });
}
module.exports = { sourceDeclarations, fetchVendorSources, verifyVendorArchive: verify };
