// Container-image acquisition through the domain-pack release surface:
// provenance/runtime-distribution.json records, per image, the GitHub
// Release tarball (compressed oci-archive) identity - url, sha256, size and
// the config digest of the pushed image. Acquiring means: anonymous HTTPS
// download, byte verification, `docker load`, and identity confirmation
// against the lock. Registry pulls remain a second channel that activates
// when the packages are public; nothing here talks to a registry.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Transfer } = require('./transfer.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function distributionLockFile(from) {
  const override = process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION;
  if (override) return path.resolve(override);
  let directory = path.resolve(from);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(directory, 'provenance', 'runtime-distribution.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

function readDistributionLock(from) {
  const file = distributionLockFile(from);
  if (!file) return null;
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (lock?.schemaVersion !== 1 || !Array.isArray(lock.images))
    throw Error(`Invalid runtime distribution lock: ${file}`);
  return { file, lock };
}

// `image` accepts the lock id (industrial-chip-tools), the bare repository
// name, `repository:tag`, or a registry-prefixed reference.
function resolveImageAsset({ lock }, image) {
  if (!lock || !Array.isArray(lock.images)) return null;
  const lastSegment = String(image || '')
    .trim()
    .split('/')
    .pop();
  const [name] = lastSegment.split(':');
  for (const entry of lock.images) {
    if (entry?.id !== name && entry?.repository !== name) continue;
    const current = entry.current;
    if (
      !current?.tag ||
      !/^sha256:[0-9a-f]{64}$/.test(current.imageDigest || '') ||
      !/^[0-9a-f]{64}$/.test(current.ociArchiveSha256 || '')
    )
      return { released: false, entry };
    const url = String(lock.releaseAssetUrlTemplate || '')
      .replace('{tag}', current.tag)
      .replace('{archive}', current.ociArchive || '');
    if (!/^https:\/\//.test(url)) throw Error('Lock has no https release asset template.');
    return {
      released: true,
      entry,
      imageRef: `${entry.repository}:${current.tag}`,
      tag: current.tag,
      url,
      sha256: current.ociArchiveSha256,
      bytes: Number.isSafeInteger(current.ociArchiveBytes) ? current.ociArchiveBytes : null,
      configDigest: /^sha256:[0-9a-f]{64}$/.test(current.configDigest || '')
        ? current.configDigest
        : null,
    };
  }
  return null;
}

function run(docker, args, environment) {
  const child = spawnSync(docker, args, {
    encoding: 'utf8',
    env: environment,
    timeout: 10 * 60 * 1000,
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`.trim();
  if (child.error) throw Error(`Cannot run ${docker}: ${child.error.message}`);
  if (child.status !== 0) throw Error(`docker ${args[0]} failed (${child.status}): ${output}`);
  return (child.stdout || '').trim();
}

function loadedImageRef(output, fallback) {
  const match = /Loaded image:\s*(\S+)/.exec(output);
  return match ? match[1] : fallback;
}

async function acquireImage({
  packDirectory,
  image,
  docker = 'docker',
  environment = process.env,
  signal,
  onProgress,
  keepArchive = false,
}) {
  const found = readDistributionLock(packDirectory);
  if (!found)
    throw Error(`No provenance/runtime-distribution.json found at or above ${packDirectory}.`);
  const asset = resolveImageAsset(found, image);
  if (!asset) throw Error(`Image ${image} is not registered in ${found.file}.`);
  if (!asset.released)
    throw Error(`Image ${asset.entry.id} has no released version in the distribution lock yet.`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-image-'));
  const archive = path.join(directory, path.basename(new URL(asset.url).pathname));
  await new Transfer({ signal }).run(async transfer => {
    const response = await transfer.response(asset.url);
    const chunks = [];
    let size = 0;
    onProgress?.({ phase: 'downloading', received: 0, total: asset.bytes });
    for await (const chunk of response.body) {
      transfer.touch();
      size += chunk.length;
      chunks.push(chunk);
      onProgress?.({ phase: 'downloading', received: size, total: asset.bytes });
    }
    if (asset.bytes != null && size !== asset.bytes)
      throw Error(`Release archive size mismatch: expected ${asset.bytes}, downloaded ${size}.`);
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== asset.sha256)
      throw Error('Release archive sha256 mismatch: the downloaded bytes differ from the lock.');
    fs.writeFileSync(archive, bytes);
  });

  const output = run(docker, ['load', '-i', archive], environment);
  const imageRef = loadedImageRef(output, asset.imageRef);
  if (asset.configDigest) {
    const identity = run(
      docker,
      ['image', 'inspect', '--format', '{{.Id}}', imageRef],
      environment,
    );
    if (identity !== asset.configDigest)
      throw Error(
        `Loaded image identity ${identity} does not match the lock config digest ${asset.configDigest}.`,
      );
  }
  const result = { imageRef, tag: asset.tag, sha256: asset.sha256, bytes: asset.bytes };
  if (keepArchive) result.archive = archive;
  else fs.rmSync(directory, { recursive: true, force: true });
  return result;
}

module.exports = { readDistributionLock, resolveImageAsset, acquireImage, distributionLockFile };
