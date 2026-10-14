const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultResourceDirectory } = require('./resource-settings.cjs');
const {
  RemoteClient,
  serviceUrl,
  hash,
  uuid,
  writePrivateJson,
} = require('@industrial-agent-harness/domain-runtime');
const defaults = require('./remote-defaults.json');
const keyFor = (directory, domain) => hash(`${fs.realpathSync(directory)}\0${domain}`);
const excluded = relative =>
  relative
    .split('/')
    .some(
      part =>
        /^(\.git|\.ssh|\.aws|\.industrial.*|node_modules|\.venv|\.harness|\.env.*|\.npmrc|\.netrc|\.pypirc|auth\.json)$/i.test(
          part,
        ) ||
        /(^credentials?([.-]|$)|^secrets?([.-]|$)|^id_(rsa|ed25519)$|\.(pem|key|p12|pfx|keystore)$)/i.test(
          part,
        ),
    );

function selectedSnapshot(directory, selected) {
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 256 ||
    new Set(selected).size !== selected.length
  )
    throw Error('Choose between 1 and 256 distinct files to sync.');
  const root = fs.realpathSync(directory),
    blobs = new Map();
  let total = 0;
  const files = [...selected].sort().map(relative => {
    if (
      typeof relative !== 'string' ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      relative.startsWith('/') ||
      /^[A-Za-z]:/.test(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..') ||
      excluded(relative)
    )
      throw Error('Credentials, runtime files and unsafe paths cannot be synced.');
    let cursor = root;
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Symlink inputs cannot be synced.');
    }
    const fd = fs.openSync(cursor, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1048576)
        throw Error('Select bounded ordinary files.');
      total += before.size;
      if (total > 8 * 1048576) throw Error('Selected files exceed 8 MiB.');
      const content = fs.readFileSync(fd),
        after = fs.fstatSync(fd);
      if (
        content.length !== before.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.mtimeMs !== after.mtimeMs ||
        content.includes(Buffer.from('PRIVATE KEY-----')) ||
        /["'](?:api[_-]?key|credential|access_token|refresh_token|password|secret_key)["']\s*:\s*["'][^"']+["']/i.test(
          content.toString('utf8'),
        )
      )
        throw Error(
          'A selected file changed or contains a private key. Review the selection again.',
        );
      const sha256 = hash(content);
      blobs.set(sha256, content);
      return { path: relative, sha256, sizeBytes: content.length };
    } finally {
      fs.closeSync(fd);
    }
  });
  const manifest = { schemaVersion: '0.1', files };
  return { manifest, blobs, digest: hash(JSON.stringify(manifest)), totalBytes: total };
}

class RemoteSettings {
  constructor({
    directory = defaultResourceDirectory(),
    environment = process.env,
    fetch,
    account,
  } = {}) {
    this.directory = directory;
    this.environment = environment;
    this.fetch = fetch;
    this.account = account;
    this.file = path.join(directory, 'remote-settings.json');
    this.reviews = new Map();
    this.locks = new Set();
    this.connection = { status: 'unchecked', domains: [] };
  }
  read() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, projects: {} };
      throw Error('Cannot read remote settings.');
    }
    if (
      value?.schemaVersion !== 1 ||
      !value.projects ||
      typeof value.projects !== 'object' ||
      Array.isArray(value.projects)
    )
      throw Error('Invalid remote settings.');
    return value;
  }
  write(value) {
    writePrivateJson(this.file, value);
  }
  configuration() {
    const saved = this.read().service || {};
    const url =
      this.environment.INDUSTRIAL_REMOTE_SERVICE_URL ||
      this.account?.config.remoteOrigin ||
      saved.serviceUrl ||
      defaults.serviceUrl;
    const credentialEnv =
      this.environment.INDUSTRIAL_REMOTE_CREDENTIAL_ENV ||
      saved.credentialEnv ||
      defaults.credentialEnv;
    if (credentialEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv))
      throw Error('Invalid remote credential reference.');
    return { url: url ? serviceUrl(url) : null, credentialEnv, serverId: saved.serverId || null };
  }
  identity() {
    const config = this.configuration();
    const account = this.accountFor(config);
    return hash(
      JSON.stringify({
        ...config,
        ...(account
          ? { account: account.identity, subject: account.view().user?.sub || null }
          : {}),
      }),
    );
  }
  accountFor(config = this.configuration()) {
    return this.account?.config.remoteOrigin === config.url ? this.account : null;
  }
  client() {
    const config = this.configuration();
    if (!config.url) throw Error('Zhiman Remote is not configured.');
    const account = this.accountFor(config);
    const subject = account?.view().user?.sub;
    return new RemoteClient({
      url: config.url,
      credential: this.environment[config.credentialEnv],
      credentialProvider: account
        ? async options => {
            if (!subject || account.view().user?.sub !== subject)
              throw Error('Sign in to the project account again.');
            return account.serviceToken('remote', config.url, options);
          }
        : undefined,
      journalDirectory: path.join(this.directory, 'remote-requests'),
      fetch: this.fetch,
    });
  }
  view() {
    const config = this.configuration();
    if (!config.url) return { status: 'not_configured', domains: [] };
    if (
      this.accountFor(config)
        ? !this.account.view().user
        : !config.credentialEnv || !this.environment[config.credentialEnv]
    )
      return { status: 'credentials_missing', domains: [] };
    return this.connectionIdentity === this.identity()
      ? this.connection
      : { status: 'unchecked', domains: [] };
  }
  async check() {
    if (['not_configured', 'credentials_missing'].includes(this.view().status)) return this.view();
    const config = this.configuration();
    try {
      const info = await this.client().info();
      if (
        info.contractVersion !== '0.2' ||
        info.canonicalSchemaVersion !== '1' ||
        typeof info.serverId !== 'string' ||
        !Array.isArray(info.domains) ||
        info.domains.some(id => typeof id !== 'string')
      )
        throw Error('Incompatible remote service.');
      if (config.serverId && config.serverId !== info.serverId)
        throw Error('Remote service identity changed.');
      const saved = this.read();
      saved.service = {
        ...saved.service,
        serviceUrl: config.url,
        credentialEnv: config.credentialEnv,
        serverId: info.serverId,
      };
      this.write(saved);
      this.connection = { status: info.ready ? 'connected' : 'unavailable', domains: info.domains };
    } catch (error) {
      this.connection = {
        status:
          error.status === 401 || error.status === 403 ? 'credentials_missing' : 'unavailable',
        domains: [],
      };
    }
    this.connectionIdentity = this.identity();
    return this.view();
  }
  project(directory, domain) {
    const value = this.read().projects[keyFor(directory, domain)] || { location: 'local' };
    if (!['local', 'remote'].includes(value.location))
      throw Error('Invalid project execution location.');
    return value;
  }
  update(directory, domain, changes) {
    const saved = this.read(),
      key = keyFor(directory, domain);
    saved.projects[key] = { ...this.project(directory, domain), ...changes };
    this.write(saved);
    return saved.projects[key];
  }
  setLocation(directory, domain, location) {
    if (!['local', 'remote'].includes(location)) throw Error('Invalid execution location.');
    if (this.locks.has(keyFor(directory, domain))) throw Error('Remote project settings are busy.');
    this.assertTaskIdle(directory, domain);
    return this.update(directory, domain, { location });
  }
  taskFile(directory, domain) {
    return path.join(this.directory, 'remote-jobs', keyFor(directory, domain) + '.json');
  }
  task(directory, domain) {
    try {
      const value = JSON.parse(fs.readFileSync(this.taskFile(directory, domain), 'utf8'));
      if (
        value.serviceIdentity !== this.identity() ||
        value.remoteProjectId !== this.project(directory, domain).remoteProjectId
      )
        throw Error('Saved task belongs to another remote service or project.');
      return {
        requestId: value.requestId,
        jobId: value.jobId,
        status: value.status,
        queuePosition: value.queuePosition,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  assertTaskIdle(directory, domain) {
    if (
      ['submitting', 'unknown', 'queued', 'provisioning', 'running', 'collecting'].includes(
        this.task(directory, domain)?.status,
      )
    )
      throw Error(
        'A remote task is still pending. Check its status before changing execution settings.',
      );
  }
  async refreshTask(directory, domain) {
    const task = this.task(directory, domain);
    if (
      !task ||
      !['submitting', 'unknown', 'queued', 'provisioning', 'running', 'collecting'].includes(
        task.status,
      )
    )
      return task;
    const binding = this.project(directory, domain),
      client = this.client();
    const job = task.jobId
      ? await client.job(binding.remoteProjectId, task.jobId)
      : await client.byRequest(binding.remoteProjectId, task.requestId);
    if (job.requestId !== task.requestId || (task.jobId && job.jobId !== task.jobId))
      throw Error('Saved remote job identity changed.');
    if (!['queued', 'provisioning', 'running', 'collecting'].includes(job.status)) {
      const file = this.taskFile(directory, domain),
        latest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (latest.requestId !== task.requestId) throw Error('Remote task selection changed.');
      writePrivateJson(file, {
        ...latest,
        jobId: job.jobId,
        status: job.status,
        queuePosition: null,
        needsImport: Boolean(job.result),
      });
    }
    // Terminal execution status is not acceptance. Runtime verifies evidence on resume.
    return {
      requestId: task.requestId,
      jobId: job.jobId,
      status: job.status,
      queuePosition: job.queuePosition,
    };
  }
  async cancelTask(directory, domain, expected) {
    const observed = this.task(directory, domain);
    if (
      expected &&
      (expected.requestId !== observed?.requestId || expected.jobId !== observed?.jobId)
    )
      throw Error('Remote task selection changed. Refresh before cancelling.');
    const task = await this.refreshTask(directory, domain);
    if (task?.requestId !== observed?.requestId)
      throw Error('Remote task selection changed. Refresh before cancelling.');
    if (task?.jobId && ['queued', 'provisioning', 'running', 'collecting'].includes(task.status))
      await this.client().cancel(this.project(directory, domain).remoteProjectId, task.jobId);
    return this.refreshTask(directory, domain);
  }
  snapshot(directory, files) {
    return selectedSnapshot(directory, files);
  }
  candidates(directory) {
    const root = fs.realpathSync(directory),
      result = [];
    let visits = 0;
    const walk = (relative, depth) => {
      if (depth > 12) return;
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        if (++visits > 4096) throw Error('Project is too large for the trial file picker.');
        const file = relative ? relative + '/' + entry.name : entry.name;
        if (excluded(file) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (entry.isFile() && fs.statSync(path.join(root, file)).size <= 8 * 1048576)
          result.push(file);
      }
    };
    walk('', 0);
    return result.sort();
  }
  async review(directory, domain, files) {
    if ((await this.check()).status !== 'connected' || !this.view().domains.includes(domain))
      throw Error('Remote service is unavailable for this domain.');
    const snapshot = selectedSnapshot(directory, files);
    const id = crypto.randomUUID();
    this.reviews.set(id, {
      directory: fs.realpathSync(directory),
      domain,
      files,
      digest: snapshot.digest,
      identity: this.identity(),
      expires: Date.now() + 300000,
    });
    for (const [key, review] of this.reviews)
      if (review.expires < Date.now()) this.reviews.delete(key);
    return {
      id,
      destination: this.configuration().url,
      files: snapshot.manifest.files.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
      totalBytes: snapshot.totalBytes,
    };
  }
  async sync(directory, domain, reviewId) {
    const key = keyFor(directory, domain),
      review = this.reviews.get(reviewId);
    this.reviews.delete(reviewId);
    if (
      !review ||
      review.directory !== fs.realpathSync(directory) ||
      review.domain !== domain ||
      review.expires < Date.now() ||
      review.identity !== this.identity()
    )
      throw Error('File sync review expired. Review the selection again.');
    if (this.locks.has(key)) throw Error('Remote project settings are busy.');
    this.assertTaskIdle(directory, domain);
    this.locks.add(key);
    try {
      const snapshot = selectedSnapshot(directory, review.files);
      if (snapshot.digest !== review.digest)
        throw Error('Selected files changed. Review them again before uploading.');
      let binding = this.project(directory, domain);
      const client = this.client();
      if (!binding.remoteProjectId) {
        const project = await client.createProject(domain);
        uuid(project.id);
        if (project.domain !== domain || !/^[a-f0-9]{64}$/.test(project.canonicalProjectId))
          throw Error('Invalid remote project.');
        binding = this.update(directory, domain, {
          remoteProjectId: project.id,
          canonicalProjectId: project.canonicalProjectId,
          serviceIdentity: this.identity(),
        });
      }
      if (binding.serviceIdentity !== this.identity())
        throw Error('Project belongs to another service.');
      const result = await client.sync(
        binding.remoteProjectId,
        snapshot,
        binding.snapshotId || null,
      );
      return this.update(directory, domain, {
        location: 'remote',
        files: review.files,
        manifestDigest: snapshot.digest,
        snapshotId: result.snapshot.id,
        syncedAt: new Date().toISOString(),
      });
    } finally {
      this.locks.delete(key);
    }
  }
  async ensureSynced(directory, domain) {
    let binding = this.project(directory, domain);
    if (!binding.remoteProjectId || !binding.files?.length || !binding.snapshotId)
      throw Error(
        'Choose and confirm files in Project execution settings before running remotely.',
      );
    if (binding.serviceIdentity !== this.identity())
      throw Error('Project belongs to another service.');
    const snapshot = selectedSnapshot(directory, binding.files);
    if (snapshot.digest !== binding.manifestDigest) {
      // Only the exact, previously approved path set may sync automatically. New paths need a new review.
      const result = await this.client().sync(
        binding.remoteProjectId,
        snapshot,
        binding.snapshotId,
      );
      binding = this.update(directory, domain, {
        manifestDigest: snapshot.digest,
        snapshotId: result.snapshot.id,
        syncedAt: new Date().toISOString(),
      });
    }
    return binding;
  }
}
module.exports = { RemoteSettings, selectedSnapshot, excluded };
