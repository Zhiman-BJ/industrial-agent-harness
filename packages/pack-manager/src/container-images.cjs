const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Transfer, TransferProgress } = require('./transfer.cjs');
const { availableSpace, footprint, checkSpace } = require('./install-space.cjs');
const { run } = require('./runtime-assets.cjs');
const { inspectOciArchive } = require('./oci-archive.cjs');
const {
  dockerCli: { resolveDockerCli, resolveDockerCliSync, dockerSearchLocations },
} = require('@industrial-agent-harness/domain-runtime');

const LOCK_PATH = 'provenance/runtime-distribution.json';
const SHA = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function distributionLockFile(from) {
  const override = process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION;
  if (override) return path.resolve(override);
  let directory = path.resolve(from);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(directory, LOCK_PATH);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function validateDistributionLock(lock) {
  if (
    lock?.schemaVersion !== 1 ||
    !Array.isArray(lock.images) ||
    lock.images.length > 64 ||
    !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(lock.registry || '') ||
    !NAME.test(lock.imageNamespace || '')
  )
    throw Error('Invalid runtime distribution lock.');
  const ids = new Set(),
    repositories = new Set();
  for (const entry of lock.images) {
    if (
      !NAME.test(entry?.id || '') ||
      !NAME.test(entry.repository || '') ||
      ids.has(entry.id) ||
      repositories.has(entry.repository) ||
      !/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(entry.platform || '')
    )
      throw Error('Invalid image declaration in runtime distribution lock.');
    ids.add(entry.id);
    repositories.add(entry.repository);
    if (entry.current == null) continue;
    const current = entry.current;
    if (
      !TAG.test(current.tag || '') ||
      !SHA.test(current.imageDigest || '') ||
      !SHA.test(current.configDigest || '') ||
      !/^[a-f0-9]{64}$/.test(current.ociArchiveSha256 || '') ||
      !Number.isSafeInteger(current.ociArchiveBytes) ||
      current.ociArchiveBytes < 1 ||
      current.ociArchiveBytes > 64 * 1024 ** 3 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar$/.test(current.ociArchive || '')
    )
      throw Error(`Invalid released image identity: ${entry.id}`);
    const template = lock.releaseAssetUrlTemplate;
    if (
      typeof template !== 'string' ||
      !template.includes('{tag}') ||
      !template.includes('{archive}')
    )
      throw Error('Lock has no HTTPS release asset template.');
    const url = new URL(
      template.replace('{tag}', current.tag).replace('{archive}', current.ociArchive),
    );
    if (url.protocol !== 'https:' || url.username || url.password || /[{}]/.test(url.href))
      throw Error('Release assets require an anonymous HTTPS URL.');
  }
  return lock;
}

function readDistributionLock(from) {
  const file = distributionLockFile(from);
  return file
    ? { file, lock: validateDistributionLock(JSON.parse(fs.readFileSync(file, 'utf8'))) }
    : null;
}

function validateImageSelection(images = []) {
  if (
    !Array.isArray(images) ||
    images.length > 8 ||
    new Set(images).size !== images.length ||
    images.some(image => typeof image !== 'string' || !image || image.length > 512)
  )
    throw Error('Invalid container image selection.');
  return images;
}

// Bare IDs select the locked current release. An explicit registry, namespace,
// tag or digest is a constraint, never a hint that can be silently discarded.
function resolveImageAsset({ lock }, image) {
  validateDistributionLock(lock);
  const reference = String(image || '').trim();
  const match = /^([^@\s]+?)(?:@(sha256:[a-f0-9]{64}))?$/.exec(reference);
  if (!match) throw Error('Invalid container image reference.');
  const parts = match[1].split('/');
  const leaf = parts.pop();
  const pieces = leaf.split(':');
  if (pieces.length > 2 || !NAME.test(pieces[0]) || (pieces.length === 2 && !TAG.test(pieces[1])))
    throw Error('Invalid container image reference.');
  const [name, tag] = pieces;
  const entry = lock.images.find(item => item.id === name || item.repository === name);
  if (!entry) return null;
  if (
    parts.length &&
    (parts.join('/') !== `${lock.registry}/${lock.imageNamespace}` || name !== entry.repository)
  )
    throw Error(`Image reference ${reference} does not match the locked registry and namespace.`);
  const current = entry.current;
  if (!current) return { released: false, entry };
  if ((tag && tag !== current.tag) || (match[2] && match[2] !== current.imageDigest))
    throw Error(`Image reference ${reference} does not match the locked release ${current.tag}.`);
  return {
    released: true,
    entry,
    imageRef: `${entry.repository}:${current.tag}`,
    tag: current.tag,
    url: lock.releaseAssetUrlTemplate
      .replace('{tag}', current.tag)
      .replace('{archive}', current.ociArchive),
    sha256: current.ociArchiveSha256,
    bytes: current.ociArchiveBytes,
    configDigest: current.configDigest,
    platform: entry.platform,
  };
}

function selectedAssets(lock, images = [], domain) {
  validateImageSelection(images);
  if (!images.length) return [];
  return images.map(image => {
    const asset = resolveImageAsset({ lock }, image);
    if (!asset) throw Error(`Image ${image} is not registered in the distribution lock.`);
    if (!asset.released)
      throw Error(`Image ${asset.entry.id} has no released version in the distribution lock yet.`);
    if (domain && asset.entry.pack !== domain)
      throw Error('Container image belongs to another Domain Pack.');
    return asset;
  });
}

async function download(asset, archive, options) {
  await new Transfer({ ...options, timeoutMs: options.timeoutMs ?? 2 * 60 * 60 * 1000 }).run(
    async transfer => {
      const response = await transfer.response(asset.url);
      const file = await fs.promises.open(archive, 'wx', 0o600);
      const hash = crypto.createHash('sha256'),
        progress = new TransferProgress(asset.bytes);
      let received = 0,
        reported = 0;
      try {
        options.onProgress?.(progress.update(0));
        for await (const chunk of response.body) {
          transfer.signal.throwIfAborted();
          transfer.touch();
          received += chunk.length;
          if (received > asset.bytes)
            throw Error('Release archive size exceeds the distribution lock.');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw Error('Could not write release archive.');
            offset += bytesWritten;
          }
          if (received - reported >= 1024 * 1024 || received === asset.bytes) {
            options.onProgress?.(progress.update(received));
            reported = received;
          }
        }
        transfer.signal.throwIfAborted();
        if (received !== asset.bytes)
          throw Error(
            `Release archive size mismatch: expected ${asset.bytes}, downloaded ${received}.`,
          );
        if (hash.digest('hex') !== asset.sha256) throw Error('Release archive sha256 mismatch.');
      } finally {
        await file.close();
      }
    },
  );
}

async function checkLinuxEngine({ docker, environment, command, signal }) {
  signal?.throwIfAborted();
  const execute = args => command(docker, args, { env: environment, signal, timeout: 30000 });
  let engine;
  try {
    engine = (await execute(['info', '--format', '{{.OSType}}'])).trim();
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT')
      throw Error(
        'Docker was not found. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux), make sure the docker command is available, then retry.' +
          (docker === 'docker'
            ? ' Searched the PATH and ' + dockerSearchLocations(environment).join(', ') + '.'
            : ` Docker executable not found at ${docker}.`),
        { cause: error },
      );
    throw Error(
      'Docker could not be reached. Start Docker Desktop or your Linux Docker engine, then retry. If it is already running, check the active Docker connection.\n' +
        error.message,
      { cause: error },
    );
  }
  if (engine !== 'linux')
    throw Error(
      'Release images require a Linux Docker engine. Switch Docker to Linux containers, then retry.',
    );
}

async function acquireImage({
  packDirectory,
  distribution,
  image,
  docker = 'docker',
  environment = process.env,
  signal,
  onProgress,
  keepArchive = false,
  temporaryDirectory = os.tmpdir(),
  command = run,
  space = availableSpace,
  stallMs,
  timeoutMs,
  resolveDocker = resolveDockerCli,
}) {
  // Installation supplies the lock from the authenticated .hpack bytes. Only the
  // standalone developer API performs discovery / honors the environment override.
  const found = distribution || readDistributionLock(packDirectory);
  if (!found) throw Error(`No ${LOCK_PATH} found at or above ${packDirectory}.`);
  const [asset] = selectedAssets(found.lock, [image]);
  const report = progress => onProgress?.({ label: asset.entry.id, ...progress });
  signal?.throwIfAborted();
  // A bare 'docker' relies on PATH alone; GUI-launched processes inherit
  // launchd's minimal PATH, so probe Docker Desktop's well-known installs and
  // the login-shell PATH before spawning.
  if (docker === 'docker') {
    const resolved = await resolveDocker(environment, { signal });
    if (resolved) {
      docker = resolved.docker;
      environment = resolved.environment;
    }
  }
  const execute = args =>
    command(docker, args, { env: environment, signal, timeout: 10 * 60 * 1000 });
  report({ phase: 'checking' });
  await checkLinuxEngine({ docker, environment, command, signal });
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  report({
    phase: 'checking-space',
    ...checkSpace(temporaryDirectory, footprint(asset.bytes, 0), space),
  });
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, 'industrial-image-'));
  const archive = path.join(directory, asset.entry.current.ociArchive);
  let retained = false;
  try {
    await download(asset, archive, { signal, onProgress: report, stallMs, timeoutMs });
    report({ phase: 'verifying' });
    const identity = await inspectOciArchive(archive, { ...asset, signal });
    signal?.throwIfAborted();
    report({ phase: 'extracting' });
    await execute(['load', '-i', archive]);
    report({ phase: 'checking' });
    // containerd stores use the manifest ID; the classic store uses config ID.
    // Both are derived from the hash-verified OCI archive, independently of
    // human-readable docker load output, which need not include any tag.
    let imageId;
    for (const expected of [identity.manifestDigest, identity.configDigest]) {
      try {
        const actual = (
          await execute(['image', 'inspect', '--format', '{{.Id}}', expected])
        ).trim();
        if (actual !== expected)
          throw Error('Loaded image identity does not match the verified OCI archive.');
        imageId = actual;
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (expected === identity.configDigest) throw error;
      }
    }
    await execute(['image', 'tag', imageId, asset.imageRef]);
    if (
      (await execute(['image', 'inspect', '--format', '{{.Id}}', asset.imageRef])).trim() !==
      imageId
    )
      throw Error('Loaded image tag does not match the verified OCI archive.');
    const result = {
      imageRef: asset.imageRef,
      tag: asset.tag,
      sha256: asset.sha256,
      bytes: asset.bytes,
      imageId,
      ...identity,
    };
    signal?.throwIfAborted();
    report({ phase: 'ready' });
    if (keepArchive) {
      result.archive = archive;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) fs.rmSync(directory, { recursive: true, force: true });
  }
}

class ContainerImageManager {
  constructor({
    directory,
    docker = 'docker',
    environment = process.env,
    command = run,
    space = availableSpace,
    resolveDocker = resolveDockerCli,
  }) {
    this.directory = path.join(directory, '.container-images');
    this.docker = docker;
    this.environment = environment;
    this.command = command;
    this.space = space;
    this.resolveDocker = resolveDocker;
  }
  // Resolve a bare 'docker' on demand; an explicitly injected command path is
  // honored as-is, and the resolved absolute path survives later calls.
  async resolveRuntimeCommand(signal) {
    if (this.docker !== 'docker') return;
    const resolved = await this.resolveDocker(this.environment, { signal });
    if (resolved) {
      this.docker = resolved.docker;
      this.environment = resolved.environment;
    }
  }
  receiptFile(asset) {
    return path.join(this.directory, asset.sha256 + '.json');
  }
  receipt(asset) {
    try {
      const receipt = JSON.parse(fs.readFileSync(this.receiptFile(asset), 'utf8'));
      return receipt.sha256 === asset.sha256 &&
        receipt.configDigest === asset.configDigest &&
        receipt.platform === asset.platform &&
        receipt.bytes === asset.bytes &&
        SHA.test(receipt.manifestDigest) &&
        [receipt.manifestDigest, receipt.configDigest].includes(receipt.imageId) &&
        receipt.imageRef === asset.imageRef
        ? receipt
        : null;
    } catch {
      return null;
    }
  }
  status(lock, images) {
    if (this.docker === 'docker') {
      // Sync probing only: status must stay non-async; the login-shell capture
      // runs later in preflight/ensure if these locations miss.
      const resolved = resolveDockerCliSync(this.environment);
      if (resolved) {
        this.docker = resolved.docker;
        this.environment = resolved.environment;
      }
    }
    return selectedAssets(lock, images).map(asset => {
      const receipt = this.receipt(asset);
      const child =
        receipt &&
        spawnSync(this.docker, ['image', 'inspect', '--format', '{{.Id}}', asset.imageRef], {
          env: this.environment,
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
      return {
        id: asset.entry.id,
        label: asset.entry.id,
        version: asset.tag,
        imageRef: asset.imageRef,
        ready: Boolean(child && child.status === 0 && child.stdout.trim() === receipt.imageId),
      };
    });
  }
  async preflight(lock, images, options = {}) {
    const assets = selectedAssets(lock, images);
    if (!assets.length) return;
    options.onProgress?.({ phase: 'checking', label: assets[0].entry.id });
    await this.resolveRuntimeCommand(options.signal);
    await checkLinuxEngine({
      docker: this.docker,
      environment: this.environment,
      command: this.command,
      signal: options.signal,
    });
  }
  async ensure(lock, images, options = {}) {
    await this.resolveRuntimeCommand(options.signal);
    const results = [];
    for (const asset of selectedAssets(lock, images)) {
      options.signal?.throwIfAborted();
      const receipt = this.receipt(asset);
      if (receipt) {
        try {
          const actual = await this.command(
            this.docker,
            ['image', 'inspect', '--format', '{{.Id}}', asset.imageRef],
            { env: this.environment, signal: options.signal, timeout: 10000 },
          );
          if (actual.trim() === receipt.imageId) {
            options.onProgress?.({ phase: 'ready', label: asset.entry.id, cacheReused: true });
            results.push({ ...receipt, reused: true });
            continue;
          }
        } catch {
          options.signal?.throwIfAborted();
        }
      }
      const result = await acquireImage({
        ...options,
        distribution: { lock },
        image: asset.entry.id,
        docker: this.docker,
        environment: this.environment,
        command: this.command,
        space: this.space,
        temporaryDirectory: this.directory,
        keepArchive: false,
      });
      const temporary = this.receiptFile(asset) + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, this.receiptFile(asset));
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      results.push(result);
    }
    return results;
  }
}

module.exports = {
  LOCK_PATH,
  readDistributionLock,
  resolveImageAsset,
  acquireImage,
  distributionLockFile,
  validateDistributionLock,
  validateImageSelection,
  selectedAssets,
  ContainerImageManager,
  digest,
};
