const { availableSpace, footprint, checkSpace } = require('./install-space.cjs');
const { inspectRuntimeZip } = require('./runtime-zip.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function matchesImage(asset, image) {
  // Classic Docker reports the config digest as Id; the containerd image store
  // reports the manifest digest and supplies config.digest on its descriptor.
  const config = image.Descriptor?.annotations?.['config.digest'] || image.Id;
  return (
    config === asset.imageId &&
    image.Os + '/' + image.Architecture === asset.imagePlatform &&
    (image.RepoDigests || []).includes(asset.image)
  );
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Footprint metadata does not change executable identity or invalidate old receipts.
function declarationHash(asset) {
  const { installedSize, discoveryPaths, installUrl, ...execution } = asset;
  return hash(Buffer.from(JSON.stringify(execution)));
}
function matchesDeclaration(receipt, asset) {
  return (
    receipt.declarationHash === declarationHash(asset) ||
    receipt.declarationHash === hash(Buffer.from(JSON.stringify(asset)))
  );
}
const safe = value =>
  typeof value === 'string' &&
  /^[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');
const native = asset => ['native-runtime-zip', 'native-executable'].includes(asset.type);
const rootName = asset => (native(asset) ? asset.directory : asset.app);
const probeArgs = asset =>
  native(asset) ? [asset.probeId === 'version-short' ? '-V' : '--version'] : asset.versionArgs;
// Bind immutable runtime libraries and data as well as the launch executable.
// Probe homes and caches live outside this root, so every entry participates.
function treeIdentity(directory) {
  const digest = crypto.createHash('sha256');
  let count = 0,
    bytes = 0;
  const visit = (file, relative) => {
    if (++count > 200000) throw Error('Runtime contains too many files.');
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      throw Error('Native runtime contains a link or special file.');
    digest.update(
      JSON.stringify([relative, stat.isDirectory() ? 'directory' : 'file', stat.mode & 0o777]),
    );
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name), relative + '/' + name);
    } else {
      bytes += stat.size;
      if (bytes > 32 * 1024 ** 3) throw Error('Runtime exceeds installation size limit.');
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
          digest.update(buffer.subarray(0, read));
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  visit(directory, '');
  return { hash: digest.digest('hex'), bytes };
}
const runtimePlatforms = asset =>
  asset.type === 'docker-image' ? asset.platforms || [asset.platform] : [asset.platform];
function validateRuntimeAssets(assets = []) {
  if (!Array.isArray(assets) || assets.length > 8) throw Error('Invalid runtime assets.');
  const ids = new Set(),
    variables = new Set();
  for (const asset of assets) {
    if (
      asset.discoveryPaths != null &&
      (!Array.isArray(asset.discoveryPaths) ||
        asset.discoveryPaths.length > 32 ||
        asset.discoveryPaths.some(
          value =>
            typeof value !== 'string' ||
            !(path.isAbsolute(value) || value.startsWith('~/')) ||
            value.includes('\0'),
        ))
    )
      throw Error('Invalid runtime discovery paths.');
    if (
      asset.installUrl != null &&
      (typeof asset.installUrl !== 'string' || !/^https:\/\//.test(asset.installUrl))
    )
      throw Error('Invalid runtime installation URL.');
    if (asset?.type === 'docker-image') {
      const platforms = runtimePlatforms(asset);
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(asset.id || '') ||
        ids.has(asset.id) ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(asset.version || '') ||
        typeof asset.label !== 'string' ||
        !asset.label ||
        !Array.isArray(platforms) ||
        !platforms.length ||
        platforms.length > 2 ||
        new Set(platforms).size !== platforms.length ||
        !platforms.includes(asset.platform) ||
        platforms.some(platform => !['darwin-arm64', 'linux-x64'].includes(platform)) ||
        !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(asset.image || '') ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.imageId || '') ||
        asset.sha256 !== asset.imageId.slice(7) ||
        !/^linux\/(amd64|arm64)$/.test(asset.imagePlatform || '') ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1 ||
        asset.size > 64 * 1024 ** 3 ||
        !Number.isSafeInteger(asset.installedSize) ||
        asset.installedSize < 1 ||
        asset.installedSize > 128 * 1024 ** 3 ||
        !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(asset.environment || '') ||
        variables.has(asset.environment)
      )
        throw Error('Invalid managed container declaration.');
      ids.add(asset.id);
      variables.add(asset.environment);
      continue;
    }
    if (native(asset)) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(asset.id || '') ||
        ids.has(asset.id) ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(asset.version || '') ||
        typeof asset.label !== 'string' ||
        !asset.label ||
        asset.platform !== 'darwin-arm64' ||
        !['version', 'version-short'].includes(asset.probeId) ||
        typeof asset.versionText !== 'string' ||
        !asset.versionText ||
        asset.versionText.length > 100 ||
        !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(asset.environment || '') ||
        variables.has(asset.environment) ||
        asset.profileEnvironment != null ||
        asset.versionArgs != null
      )
        throw Error('Invalid native runtime declaration.');
      if (asset.type === 'native-runtime-zip') {
        if (
          !safe(asset.directory) ||
          asset.directory.includes('/') ||
          !safe(asset.executable) ||
          !/^https:\/\//.test(asset.url || '') ||
          !/^[a-f0-9]{64}$/.test(asset.sha256 || '') ||
          !Number.isSafeInteger(asset.size) ||
          asset.size < 1 ||
          asset.size > 2 * 1024 ** 3 ||
          !Number.isSafeInteger(asset.installedSize) ||
          asset.installedSize < 1 ||
          asset.installedSize > 32 * 1024 ** 3
        )
          throw Error('Invalid native runtime archive declaration.');
        const url = new URL(asset.url);
        if (url.username || url.password) throw Error('Runtime URL cannot contain credentials.');
      } else if (
        asset.environmentExecutables != null ||
        asset.url != null ||
        asset.directory != null
      )
        throw Error('External executable cannot declare a managed archive.');
      variables.add(asset.environment);
      if (
        asset.environmentExecutables != null &&
        (typeof asset.environmentExecutables !== 'object' ||
          Array.isArray(asset.environmentExecutables) ||
          Object.keys(asset.environmentExecutables).length > 8)
      )
        throw Error('Invalid runtime executable environment.');
      for (const [variable, executable] of Object.entries(asset.environmentExecutables || {})) {
        if (
          !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(variable) ||
          variables.has(variable) ||
          !safe(executable)
        )
          throw Error('Invalid runtime executable environment.');
        variables.add(variable);
      }
      ids.add(asset.id);
      continue;
    }
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(asset?.id || '') ||
      ids.has(asset.id) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(asset.version || '') ||
      typeof asset.label !== 'string' ||
      !asset.label ||
      !['macos-app-dmg', 'macos-app-zip'].includes(asset.type) ||
      asset.platform !== 'darwin-arm64' ||
      !/^https:\/\//.test(asset.url || '') ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 || '') ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > 2 * 1024 ** 3 ||
      (asset.installedSize != null &&
        (!Number.isSafeInteger(asset.installedSize) ||
          asset.installedSize < 1 ||
          asset.installedSize > 32 * 1024 ** 3)) ||
      (asset.archiveApp != null &&
        (!safe(asset.archiveApp) || !asset.archiveApp.endsWith('.app'))) ||
      !safe(rootName(asset)) ||
      asset.app.includes('/') ||
      !asset.app.endsWith('.app') ||
      !safe(asset.executable) ||
      !asset.executable.startsWith('Contents/') ||
      !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(asset.environment || '') ||
      variables.has(asset.environment) ||
      !Array.isArray(asset.versionArgs) ||
      !asset.versionArgs.length ||
      asset.versionArgs.length > 4 ||
      asset.versionArgs.some(arg => !/^--[a-z-]+$/.test(arg)) ||
      typeof asset.versionText !== 'string' ||
      !asset.versionText ||
      asset.versionText.length > 100
    )
      throw Error('Invalid managed runtime declaration.');
    const url = new URL(asset.url);
    if (url.username || url.password) throw Error('Runtime URL cannot contain credentials.');
    if (
      asset.profileEnvironment != null &&
      (typeof asset.profileEnvironment !== 'object' ||
        Array.isArray(asset.profileEnvironment) ||
        Object.entries(asset.profileEnvironment).some(
          ([key, value]) =>
            !/^[A-Z][A-Z0-9_]+$/.test(key) ||
            ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS'].includes(key) ||
            !['home', 'data', 'temp'].includes(value),
        ))
    )
      throw Error('Invalid runtime probe profile.');
    variables.add(asset.environment);
    if (
      asset.environmentExecutables != null &&
      (typeof asset.environmentExecutables !== 'object' ||
        Array.isArray(asset.environmentExecutables) ||
        Object.keys(asset.environmentExecutables).length > 8)
    )
      throw Error('Invalid runtime executable environment.');
    for (const [variable, executable] of Object.entries(asset.environmentExecutables || {})) {
      if (
        !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(variable) ||
        variables.has(variable) ||
        !safe(executable) ||
        !executable.startsWith('Contents/')
      )
        throw Error('Invalid runtime executable environment.');
      variables.add(variable);
    }
    ids.add(asset.id);
  }
  return assets;
}
function validateAppTree(directory) {
  const root = fs.realpathSync(directory);
  let bytes = 0,
    count = 0;
  const visit = file => {
    if (++count > 200000) throw Error('Runtime app contains too many files.');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(file);
      if (resolved !== root && !resolved.startsWith(root + path.sep))
        throw Error('Runtime app contains an escaping symbolic link.');
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry));
    } else if (stat.isFile()) bytes += stat.size;
    else throw Error('Runtime app contains a special file.');
    if (bytes > 32 * 1024 ** 3) throw Error('Runtime app exceeds installation size limit.');
  };
  visit(root);
  return bytes;
}
async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
function run(command, args, { cwd, env, signal, timeout = 60000, captureOutput = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      stdout = '',
      stderr = '',
      failure,
      settled = false,
      forceKill;
    const diagnostic = error => {
      const elapsed = Math.round(performance.now() - startedAt);
      const detail = Error(
        `${error.message || String(error)}\nCommand: ${path.basename(command)}; elapsed: ${elapsed} ms` +
          (output ? `\nOutput (last 2000 characters): ${output.slice(-2000)}` : ''),
        { cause: error },
      );
      detail.name = error.name || 'Error';
      if (error.code !== undefined) detail.code = error.code;
      return detail;
    };
    const kill = mode => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(mode);
        else process.kill(-child.pid, mode);
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(mode);
      }
    };
    const stop = error => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      // Settle only on close: installers must finish exiting before their
      // destination is removed or their image is detached.
      forceKill = setTimeout(() => kill('SIGKILL'), 5000);
      forceKill.unref?.();
    };
    const aborted = () => stop(signal.reason || Error('Runtime preparation cancelled.'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    const timer = setTimeout(
      () => stop(Error(`Runtime preparation timed out after ${timeout / 1000} seconds.`)),
      timeout,
    );
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener('abort', aborted);
    };
    const receive = bytes => {
      if (output.length > 1024 * 1024) return;
      output += bytes;
      if (output.length > 1024 * 1024)
        stop(Error('Runtime preparation output exceeded its limit.'));
    };
    child.stdout.on('data', bytes => {
      if (stdout.length <= 1024 * 1024) stdout += bytes;
      receive(bytes);
    });
    child.stderr.on('data', bytes => {
      if (stderr.length <= 1024 * 1024) stderr += bytes;
      receive(bytes);
    });
    child.on('error', error => {
      failure ||= error;
      if (!child.pid && !settled) {
        settled = true;
        cleanup();
        reject(diagnostic(error));
      }
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure)
        reject(signal?.aborted && failure === signal.reason ? failure : diagnostic(failure));
      else if (code === 0) resolve(captureOutput ? { stdout, stderr } : output);
      else reject(diagnostic(Error(`Runtime preparation failed (${code}).`)));
    });
  });
}
function sourceIsMounted(directory) {
  // Reading the mountpoint's own metadata never traverses its contents. Images
  // have a distinct device; an unexpected link is never safe to remove.
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  return Boolean(
    info && (info.isSymbolicLink() || info.dev !== fs.statSync(path.dirname(directory)).dev),
  );
}
const {
  downloadRuntimeArchive: download,
  resumableRuntimeBytes,
} = require('./runtime-download.cjs');
class RuntimeAssetManager {
  constructor({
    directory,
    platform = `${process.platform}-${process.arch}`,
    command = run,
    fetchArchive = download,
    space = availableSpace,
    inspectImage,
  } = {}) {
    if (!directory) throw Error('Runtime asset store is required.');
    this.directory = path.join(path.resolve(directory), '.runtime-assets');
    this.platform = platform;
    this.command = command;
    this.fetchArchive = fetchArchive;
    this.space = space;
    this.inspectImage =
      inspectImage ||
      (image => {
        const result = spawnSync('docker', ['image', 'inspect', image], {
          encoding: 'utf8',
          timeout: 10000,
        });
        if (result.status !== 0)
          throw Error(
            'Docker runtime is unavailable. Prepare and start Docker externally, then detect and associate the existing container environment. ' +
              String(result.stderr || result.error || '').slice(0, 1000),
          );
        return JSON.parse(result.stdout)[0];
      });
  }
  location(asset) {
    validateRuntimeAssets([asset]);
    const base = path.join(this.directory, asset.id, `${asset.version}-${asset.sha256}`);
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(base, 'receipt.json'), 'utf8'));
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        !/^[a-f0-9]{64}$/.test(receipt.declarationHash || '')
      )
        return base;
      // A changed probe/environment/app recipe must not replace the runtime used
      // by an old active Pack before the new Pack itself can be activated.
      if (!matchesDeclaration(receipt, asset)) return `${base}-${declarationHash(asset)}`;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return base;
  }
  estimate(assets = [], { verifiedCache = new Set() } = {}) {
    validateRuntimeAssets(assets);
    let downloadBytes = 0,
      installedBytes = 0,
      estimated = false,
      cacheReused = false;
    for (const asset of assets) {
      if (asset.type === 'native-executable' || this.status([asset])[0].ready) continue;
      if (verifiedCache.has(asset.sha256)) cacheReused = true;
      else downloadBytes += asset.size;
      installedBytes += asset.installedSize || Math.min(32 * 1024 ** 3, asset.size * 8);
      estimated ||= asset.installedSize == null;
    }
    return {
      ...footprint(downloadBytes, installedBytes, { estimated, cacheReused }),
      availableBytes: this.space(this.directory),
    };
  }
  executables(asset, location) {
    const root = fs.realpathSync(path.join(location, rootName(asset)));
    const entries = { [asset.environment]: asset.executable, ...asset.environmentExecutables };
    return Object.fromEntries(
      Object.entries(entries).map(([variable, relative]) => {
        const executable = path.join(location, rootName(asset), relative);
        if (
          !fs.realpathSync(executable).startsWith(root + path.sep) ||
          !fs.statSync(executable).isFile()
        )
          throw Error('Runtime executable escaped its app or is not a file.');
        return [variable, executable];
      }),
    );
  }
  inspectExistingImage(asset) {
    validateRuntimeAssets([asset]);
    try {
      if (asset.type !== 'docker-image' || !runtimePlatforms(asset).includes(this.platform))
        throw Error('Container dependency does not support this platform.');
      if (!matchesImage(asset, this.inspectImage(asset.image)))
        throw Error(
          'Existing container digest, config or platform does not match the declared dependency.',
        );
      return {
        id: asset.id,
        label: asset.label,
        version: asset.version,
        ready: true,
        executable: asset.image,
        executables: { [asset.environment]: asset.image },
        source: 'external',
      };
    } catch (error) {
      return { id: asset.id, ready: false, message: error.message };
    }
  }
  status(assets = []) {
    validateRuntimeAssets(assets);
    return assets.map(asset => {
      try {
        if (!runtimePlatforms(asset).includes(this.platform))
          throw Error('Runtime does not support this platform.');
        if (asset.type === 'native-executable')
          throw Error('Choose and associate an existing executable file.');
        const location = this.location(asset),
          receipt = JSON.parse(fs.readFileSync(path.join(location, 'receipt.json'), 'utf8'));
        if (asset.type === 'docker-image') {
          const image = this.inspectImage(asset.image);
          if (
            receipt.sha256 !== asset.sha256 ||
            !matchesDeclaration(receipt, asset) ||
            !matchesImage(asset, image)
          )
            throw Error('Managed container identity changed.');
          return {
            id: asset.id,
            label: asset.label,
            version: asset.version,
            ready: true,
            executable: asset.image,
            executables: { [asset.environment]: asset.image },
            checkedAt: receipt.checkedAt,
          };
        }
        const executable = path.join(location, rootName(asset), asset.executable);
        const executables = this.executables(asset, location);
        if (
          fs.existsSync(path.join(location, '.needs-repair')) ||
          receipt.sha256 !== asset.sha256 ||
          !matchesDeclaration(receipt, asset) ||
          !fs.realpathSync(executable).startsWith(fs.realpathSync(location) + path.sep) ||
          receipt.executableSha256 !== hash(fs.readFileSync(executable)) ||
          (native(asset) &&
            receipt.treeHash !== treeIdentity(path.join(location, rootName(asset))).hash) ||
          Object.entries(executables).some(
            ([variable, file]) =>
              variable !== asset.environment &&
              receipt.executableHashes?.[variable] !== hash(fs.readFileSync(file)),
          )
        )
          throw Error('Runtime installation changed.');
        return {
          id: asset.id,
          label: asset.label,
          version: asset.version,
          ready: true,
          executable,
          executables,
          checkedAt: receipt.checkedAt,
        };
      } catch (error) {
        return {
          id: asset.id,
          label: asset.label,
          version: asset.version,
          ready: false,
          message:
            error.code === 'ENOENT'
              ? 'Prepare this dependency externally, then detect and associate it.'
              : error.message,
        };
      }
    });
  }
  environment(assets = []) {
    const statuses = this.status(assets);
    return Object.fromEntries(
      assets.flatMap((asset, index) =>
        Object.keys({ [asset.environment]: asset.executable, ...asset.environmentExecutables }).map(
          variable => [variable, statuses[index].executables?.[variable] || ''],
        ),
      ),
    );
  }
  async probe(asset, location, { signal } = {}) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runtime-check-'));
    for (const name of ['data', 'temp']) fs.mkdirSync(path.join(profile, name));
    try {
      const output = await this.command(
        path.join(location, rootName(asset), asset.executable),
        probeArgs(asset),
        {
          signal,
          cwd: profile,
          // First macOS launch can spend over 30s in system signature checks.
          timeout: 120000,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: profile,
            TMPDIR: path.join(profile, 'temp') + '/',
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            QT_QPA_PLATFORM: 'offscreen',
            ...Object.fromEntries(
              Object.entries(asset.profileEnvironment || {}).map(([key, value]) => [
                key,
                value === 'home' ? profile : path.join(profile, value),
              ]),
            ),
          },
        },
      );
      const text = String(output),
        index = text.indexOf(asset.versionText);
      if (
        index < 0 ||
        (index > 0 && /[0-9]/.test(text[index - 1])) ||
        (/[0-9]$/.test(asset.versionText) &&
          /[0-9]/.test(text[index + asset.versionText.length] || ''))
      )
        throw Error('Runtime version check failed.');
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  async ensureImage(asset, target, { signal, report, recheck }) {
    if (!recheck && this.status([asset])[0].ready) {
      report({ phase: 'ready' });
      return;
    }
    report({ phase: 'checking' });
    await this.command('docker', ['info', '--format', '{{.OSType}}'], {
      signal,
      timeout: 15000,
    }).catch(error => {
      throw Error(
        'Docker runtime is unavailable. Install and start Docker (Docker Desktop on macOS), then retry preparation. ' +
          error.message,
      );
    });
    const estimate = footprint(asset.size, asset.installedSize);
    report({ phase: 'checking-space', ...checkSpace(this.directory, estimate, this.space) });
    report({ phase: 'downloading', received: 0, total: asset.size });
    await this.command('docker', ['pull', '--platform', asset.imagePlatform, asset.image], {
      signal,
      timeout: 30 * 60 * 1000,
    });
    signal?.throwIfAborted();
    report({ phase: 'verifying' });
    const image = this.inspectImage(asset.image);
    if (!matchesImage(asset, image)) throw Error('Managed container identity verification failed.');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const temporary = path.join(target, 'receipt.' + crypto.randomUUID() + '.partial');
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          schemaVersion: 1,
          sha256: asset.sha256,
          declarationHash: declarationHash(asset),
          checkedAt: new Date().toISOString(),
          image: asset.image,
          imageId: asset.imageId,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      signal?.throwIfAborted();
      fs.renameSync(temporary, path.join(target, 'receipt.json'));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    report({ phase: 'ready' });
  }
  async ensure(assets = [], { onProgress = () => {}, signal, recheck = false } = {}) {
    validateRuntimeAssets(assets);
    if (!assets.length) return [];
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, 'prepare.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw Error('Invalid runtime preparation lock.');
      try {
        process.kill(owner.pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') {
          fs.rmSync(lock);
          return this.ensure(assets, { onProgress, signal, recheck });
        }
        throw probe;
      }
      throw Error('Runtime preparation is already in progress.');
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      for (const asset of assets) {
        signal?.throwIfAborted();
        if (!runtimePlatforms(asset).includes(this.platform))
          throw Error('Runtime does not support this platform.');
        const report = state => onProgress({ id: asset.id, label: asset.label, ...state });
        if (asset.type === 'native-executable')
          throw Error(
            'External executable requires installation by its provider, then detection and association of its executable file.',
          );
        const target = this.location(asset);
        if (asset.type === 'docker-image') {
          await this.ensureImage(asset, target, { signal, report, recheck });
          continue;
        }
        if (this.status([asset])[0].ready) {
          if (!recheck) {
            report({ phase: 'ready' });
            continue;
          }
          report({ phase: 'checking' });
          try {
            validateAppTree(path.join(target, rootName(asset)));
            if (!native(asset))
              await this.command(
                '/usr/bin/codesign',
                ['--verify', '--deep', '--strict', path.join(target, rootName(asset))],
                { signal, timeout: 5 * 60 * 1000 },
              );
            await this.probe(asset, target, { signal });
            report({ phase: 'ready' });
            continue;
          } catch (error) {
            signal?.throwIfAborted();
            // Preserve the files but do not report failed native integrity as ready.
            fs.writeFileSync(path.join(target, '.needs-repair'), String(error.message), {
              mode: 0o600,
            });
          }
        }
        const cache = path.join(this.directory, 'cache');
        fs.mkdirSync(cache, { recursive: true });
        const archive = path.join(
          cache,
          asset.sha256 + (asset.type !== 'macos-app-dmg' ? '.zip' : '.dmg'),
        );
        report({ phase: 'verifying' });
        if (
          fs.existsSync(archive) &&
          (fs.statSync(archive).size !== asset.size || (await fileHash(archive)) !== asset.sha256)
        )
          fs.rmSync(archive);
        const cacheReused = fs.existsSync(archive);
        const installedBytes = asset.installedSize || Math.min(32 * 1024 ** 3, asset.size * 8);
        const remainingBytes = Math.max(0, asset.size - resumableRuntimeBytes(asset, archive));
        const estimate = footprint(cacheReused ? 0 : remainingBytes, installedBytes, {
          cacheReused,
          estimated: asset.installedSize == null,
        });
        const space = checkSpace(this.directory, estimate, this.space);
        report({ phase: 'checking-space', ...space });
        signal?.throwIfAborted();
        if (!cacheReused) {
          report({ phase: 'downloading', received: 0, total: asset.size });
          await this.fetchArchive(asset, archive, { signal, onProgress: report });
        }
        report({ phase: 'verifying', cacheReused });
        // Always verify even cached input before mounting or executing anything.
        if (fs.statSync(archive).size !== asset.size || (await fileHash(archive)) !== asset.sha256)
          throw Error('Runtime archive verification failed.');
        signal?.throwIfAborted();
        const parent = path.dirname(target);
        fs.mkdirSync(parent, { recursive: true });
        const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
        const mount = fs.realpathSync(fs.mkdtempSync(path.join(parent, '.source-')));
        const backup = target + '.previous-' + crypto.randomUUID();
        let mountAttempted = false;
        try {
          if (asset.type === 'macos-app-dmg') {
            report({ phase: 'mounting' });
            mountAttempted = true;
            await this.command(
              '/usr/bin/hdiutil',
              ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive],
              { signal, timeout: 5 * 60 * 1000 },
            );
          } else {
            const inspection = inspectRuntimeZip(
              archive,
              Math.max(installedBytes * 1.1, installedBytes + 64 * 1024 ** 2),
            );
            checkSpace(this.directory, footprint(0, inspection.installedBytes), this.space);
            report({ phase: 'extracting' });
            await this.command('/usr/bin/ditto', ['-x', '-k', archive, mount], {
              signal,
              timeout: 5 * 60 * 1000,
            });
          }
          const expected = path.join(mount, asset.archiveApp || rootName(asset));
          const source = fs.realpathSync(expected);
          if (source !== expected || !fs.statSync(source).isDirectory())
            throw Error('Unexpected runtime app bundle.');
          // ditto preserves links encountered inside a directory. The source
          // argument itself was resolved above, so validate copied links locally
          // before signature checks or execution; walking compressed DMGs twice
          // otherwise causes repeated random decompression of large runtimes.
          checkSpace(
            this.directory,
            footprint(0, asset.type === 'macos-app-dmg' ? installedBytes : 0),
            this.space,
          );
          signal?.throwIfAborted();
          if (asset.type === 'macos-app-dmg') {
            report({ phase: 'copying' });
            await this.command('/usr/bin/ditto', [source, path.join(staging, rootName(asset))], {
              signal,
              timeout: 5 * 60 * 1000,
            });
          } else fs.renameSync(source, path.join(staging, rootName(asset)));
          report({ phase: 'checking' });
          const tree = native(asset) ? treeIdentity(path.join(staging, rootName(asset))) : null;
          const copiedBytes = tree
            ? tree.bytes
            : validateAppTree(path.join(staging, rootName(asset)));
          if (copiedBytes > Math.max(installedBytes * 1.1, installedBytes + 64 * 1024 ** 2))
            throw Error('Runtime app exceeds declared installation size.');
          signal?.throwIfAborted();
          if (!native(asset))
            await this.command(
              '/usr/bin/codesign',
              ['--verify', '--deep', '--strict', path.join(staging, rootName(asset))],
              { signal, timeout: 5 * 60 * 1000 },
            );
          await this.probe(asset, staging, { signal });
          if (tree && treeIdentity(path.join(staging, rootName(asset))).hash !== tree.hash)
            throw Error('Native runtime changed during probe.');
          const executable = path.join(staging, rootName(asset), asset.executable);
          const executables = this.executables(asset, staging);
          if (!fs.realpathSync(executable).startsWith(fs.realpathSync(staging) + path.sep))
            throw Error('Runtime executable escaped its app.');
          fs.writeFileSync(
            path.join(staging, 'receipt.json'),
            JSON.stringify({
              schemaVersion: 1,
              ...(tree ? { treeHash: tree.hash } : {}),
              sha256: asset.sha256,
              declarationHash: declarationHash(asset),
              executableSha256: hash(fs.readFileSync(executable)),
              executableHashes: Object.fromEntries(
                Object.entries(executables).map(([variable, file]) => [
                  variable,
                  hash(fs.readFileSync(file)),
                ]),
              ),
              checkedAt: new Date().toISOString(),
              url: asset.url,
            }),
            { flag: 'wx', mode: 0o600 },
          );
          signal?.throwIfAborted();
          report({ phase: 'activating' });
          signal?.throwIfAborted();
          if (fs.existsSync(target)) fs.renameSync(target, backup);
          try {
            fs.renameSync(staging, target);
          } catch (error) {
            if (fs.existsSync(backup)) fs.renameSync(backup, target);
            throw error;
          }
          fs.rmSync(backup, { recursive: true, force: true });
          report({ phase: 'ready' });
        } finally {
          try {
            if (mountAttempted) {
              // Attach can mount successfully and still reject during abort.
              // Always attempt bounded detach of our own mountpoint.
              try {
                await this.command('/usr/bin/hdiutil', ['detach', mount], { timeout: 60000 });
              } catch (error) {
                if (sourceIsMounted(mount))
                  throw Error(`Runtime image could not be detached: ${error.message}`);
              }
            }
          } finally {
            fs.rmSync(staging, { recursive: true, force: true });
            if (!sourceIsMounted(mount)) fs.rmSync(mount, { recursive: true, force: true });
            else
              throw Error(
                'Runtime image is still mounted; its contents were preserved for recovery.',
              );
          }
        }
      }
      return this.status(assets);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
}
module.exports = {
  RuntimeAssetManager,
  validateRuntimeAssets,
  fileHash,
  run,
  treeIdentity,
  probeArgs,
};
