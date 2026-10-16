const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultResourceDirectory } = require('./resource-settings.cjs');
const {
  RemoteGatewayClient,
  RemoteGatewaySessions,
  REMOTE_PROTOCOL_VERSION,
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

function validateServiceInfo(info) {
  if (
    info.remoteProtocolVersion !== REMOTE_PROTOCOL_VERSION ||
    info.canonicalSchemaVersion !== '1' ||
    typeof info.serverId !== 'string' ||
    !info.serverId ||
    !Array.isArray(info.domains) ||
    info.domains.some(id => typeof id !== 'string') ||
    info.sessionModel !== 'application-session'
  )
    throw Error('This service does not support the remote execution protocol 1.1.');
  return info;
}

function serviceConnection(info) {
  const profiles = Array.isArray(info.domainCapabilities) ? info.domainCapabilities : [];
  return {
    status: 'connected',
    domains: info.domains,
    protocol: info.remoteProtocolVersion,
    capabilities: info.capabilities || {},
    profiles,
    executableDomains:
      info.capabilities?.protectedExecution === true
        ? profiles.filter(p => p.qualification === 'qualified').map(p => p.domain)
        : [],
  };
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
    this.sessions = new RemoteGatewaySessions({
      directory: path.join(directory, 'remote-sessions'),
    });
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        ![1, 2].includes(value?.schemaVersion) ||
        !value.projects ||
        Array.isArray(value.projects)
      )
        throw Error('Invalid remote settings.');
      return { ...value, schemaVersion: 2 };
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 2, projects: {} };
      throw error;
    }
  }
  write(value) {
    writePrivateJson(this.file, { ...value, schemaVersion: 2 });
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
  identityFor(config) {
    const account = this.accountFor(config);
    return hash(
      JSON.stringify({
        ...config,
        // Rotating the credential value invalidates existing bindings and
        // sessions; only its hash is ever compared or persisted.
        credential: hash(this.environment[config.credentialEnv] || ''),
        ...(account
          ? { account: account.identity, subject: account.view().user?.sub || null }
          : {}),
      }),
    );
  }
  identity() {
    return this.identityFor(this.configuration());
  }
  accountFor(config = this.configuration()) {
    return this.account?.config.remoteOrigin === config.url ? this.account : null;
  }
  accountCredentialKey(config = this.configuration()) {
    const account = this.accountFor(config);
    if (!account) return undefined;
    // A stable, digest-only stand-in for the rotating service token.
    return hash(account.identity + ':' + (account.view().user?.sub || ''));
  }
  client(binding = {}) {
    const config = this.configuration();
    if (!config.url) throw Error('Remote execution is not configured.');
    const account = this.accountFor(config);
    const subject = account?.view().user?.sub;
    return new RemoteGatewayClient({
      url: config.url,
      credential: this.environment[config.credentialEnv],
      credentialProvider: account
        ? async options => {
            if (!subject || account.view().user?.sub !== subject)
              throw Error('Sign in to the project account again.');
            return account.serviceToken('remote', config.url, options);
          }
        : undefined,
      credentialKey: account ? this.accountCredentialKey(config) : undefined,
      serverId: config.serverId || undefined,
      fetch: this.fetch,
      ...binding,
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
    const client = this.client();
    try {
      const info = validateServiceInfo(await client.info());
      if (config.serverId && config.serverId !== info.serverId)
        throw Error('Remote service identity changed. Rebind the service explicitly.');
      const saved = this.read();
      saved.service = {
        ...saved.service,
        serviceUrl: config.url,
        credentialEnv: config.credentialEnv,
        serverId: info.serverId,
      };
      this.write(saved);
      this.connection = serviceConnection(info);
    } catch (error) {
      this.connection = {
        status:
          error.status === 401 || error.status === 403 ? 'credentials_missing' : 'unavailable',
        domains: [],
        reason: String(error.message).slice(0, 500),
      };
    } finally {
      await client.close();
    }
    this.connectionIdentity = this.identity();
    return this.view();
  }
  project(directory, domain) {
    const value = this.read().projects[keyFor(directory, domain)] || { location: 'local' };
    if (!['local', 'remote'].includes(value.location)) throw Error('Invalid execution location.');
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
  async bind(directory, domain) {
    if ((await this.check()).status !== 'connected' || !this.view().domains.includes(domain))
      throw Error('Remote service is unavailable for this domain.');
    let binding = this.project(directory, domain);
    if (binding.remoteProjectId) {
      if (
        binding.protocol !== REMOTE_PROTOCOL_VERSION ||
        binding.serviceIdentity !== this.identity()
      )
        throw Error(
          'The saved project belongs to another protocol, service or credential. Create an explicit new remote binding.',
        );
      return binding;
    }
    const client = this.client();
    try {
      const project = await client.createProject({ domain });
      uuid(project.id);
      if (project.domain !== domain || !/^[a-f0-9]{64}$/.test(project.canonicalProjectId))
        throw Error('Invalid remote project identity.');
      binding = this.update(directory, domain, {
        protocol: REMOTE_PROTOCOL_VERSION,
        remoteProjectId: project.id,
        canonicalProjectId: project.canonicalProjectId,
        serviceIdentity: this.identity(),
      });
      return binding;
    } finally {
      await client.close();
    }
  }
  rebindIntent(directory, domain) {
    const previous = this.project(directory, domain);
    if (!previous.remoteProjectId) throw Error('There is no remote project binding to replace.');
    return {
      type: 'rebind_review',
      destination: this.configuration().url,
      domain,
      previousProjectId: previous.remoteProjectId,
      previousProtocol: previous.protocol || 'legacy',
      createsNewProject: true,
      requiresExplicitUpload: true,
      historicalFacts: 'retained_without_migration',
    };
  }
  assertRebindIdle(directory, domain, previous) {
    const active = new Set([
      'submitting',
      'unknown',
      'queued',
      'provisioning',
      'running',
      'collecting',
    ]);
    const root = path.join(this.directory, 'remote-invocations');
    const files = fs.existsSync(root)
      ? fs.readdirSync(root).map(file => path.join(root, file))
      : [];
    const legacy = path.join(this.directory, 'remote-jobs', keyFor(directory, domain) + '.json');
    if (fs.existsSync(legacy)) files.push(legacy);
    for (const file of files) {
      const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        pending.remoteProjectId === previous.remoteProjectId &&
        (!pending.serviceIdentity ||
          !previous.serviceIdentity ||
          pending.serviceIdentity === previous.serviceIdentity) &&
        active.has(pending.status)
      )
        throw Error(
          'An old remote invocation remains active or unknown. Resolve it before creating a new project binding.',
        );
    }
  }
  assertServiceIdle() {
    const projects = Object.values(this.read().projects);
    const active = new Set([
      'submitting',
      'unknown',
      'queued',
      'provisioning',
      'running',
      'collecting',
    ]);
    for (const name of ['remote-invocations', 'remote-jobs']) {
      const root = path.join(this.directory, name);
      if (!fs.existsSync(root)) continue;
      for (const file of fs.readdirSync(root)) {
        const pending = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        if (
          active.has(pending.status) &&
          projects.some(
            project =>
              project.remoteProjectId === pending.remoteProjectId &&
              (!pending.serviceIdentity ||
                !project.serviceIdentity ||
                pending.serviceIdentity === project.serviceIdentity),
          )
        )
          throw Error(
            'Another remote project has an active or unknown invocation. Resolve it before changing the service identity.',
          );
      }
    }
  }
  async rebind(directory, domain) {
    this.rebindIntent(directory, domain);
    const key = keyFor(directory, domain);
    if (this.locks.has(key)) throw Error('Remote project settings are busy.');
    const previous = this.project(directory, domain),
      identity = this.identity(),
      config = this.configuration();
    this.assertRebindIdle(directory, domain, previous);
    this.locks.add(key);
    let client;
    try {
      client = this.client();
      // Rebinding is the explicit authorization to accept the configured service's
      // new server identity. Generic connection checks keep rejecting a changed pin.
      const info = validateServiceInfo(await client.info());
      if (!info.domains.includes(domain))
        throw Error('Remote service is unavailable for this domain.');
      const serviceIdentity = this.identityFor({
        url: config.url,
        credentialEnv: config.credentialEnv,
        serverId: info.serverId,
      });
      if (serviceIdentity !== identity) this.assertServiceIdle();
      const project = await client.createProject({ domain });
      uuid(project.id);
      if (project.domain !== domain || !/^[a-f0-9]{64}$/.test(project.canonicalProjectId))
        throw Error('Invalid remote project identity.');
      if (this.identity() !== identity)
        throw Error('Remote configuration changed during rebinding.');
      const saved = this.read();
      if (JSON.stringify(saved.projects[key]) !== JSON.stringify(previous))
        throw Error('Remote project binding changed during rebinding.');
      this.assertRebindIdle(directory, domain, previous);
      if (serviceIdentity !== identity) this.assertServiceIdle();
      const { bindingHistory = [], ...historical } = previous;
      const retiredAt = new Date().toISOString();
      const service = {
        ...saved.service,
        serviceUrl: config.url,
        credentialEnv: config.credentialEnv,
        serverId: info.serverId,
      };
      const binding = {
        location: 'remote',
        protocol: REMOTE_PROTOCOL_VERSION,
        remoteProjectId: project.id,
        canonicalProjectId: project.canonicalProjectId,
        serviceIdentity,
        bindingHistory: [
          ...bindingHistory,
          { binding: historical, service: saved.service || {}, retiredAt },
        ],
      };
      saved.projects[key] = binding;
      saved.service = service;
      // One private atomic write commits both identities, only after validation
      // and project creation succeed. No old canonical store is moved or rewritten.
      this.write(saved);
      this.connection = serviceConnection(info);
      this.connectionIdentity = this.identity();
      for (const [id, review] of this.reviews)
        if (review.directory === fs.realpathSync(directory) && review.domain === domain)
          this.reviews.delete(id);
      return binding;
    } finally {
      try {
        await client?.close();
      } finally {
        this.locks.delete(key);
      }
    }
  }
  sessionBinding(directory, domain, chatId) {
    uuid(chatId);
    const project = this.project(directory, domain),
      config = this.configuration();
    if (
      project.protocol !== REMOTE_PROTOCOL_VERSION ||
      !project.remoteProjectId ||
      project.serviceIdentity !== this.identity()
    )
      throw Error('Bind this project to the current remote service first.');
    return this.sessions.binding({
      url: config.url,
      serverId: config.serverId,
      credential: this.environment[config.credentialEnv],
      credentialKey: this.accountCredentialKey(config),
      remoteProjectId: project.remoteProjectId,
      domain,
      chatId,
    });
  }
  sessionClient(directory, domain, chatId) {
    const binding = this.sessionBinding(directory, domain, chatId);
    return this.client({
      remoteProjectId: binding.remoteProjectId,
      clientSessionId: binding.clientSessionId,
      domain,
    });
  }
  taskFile(directory, domain, chatId) {
    if (!chatId) return null;
    uuid(chatId);
    return path.join(
      this.directory,
      'remote-invocations',
      hash(JSON.stringify([this.identity(), keyFor(directory, domain), chatId])) + '.json',
    );
  }
  task(directory, domain, chatId) {
    const file = this.taskFile(directory, domain, chatId);
    if (!file) return null;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        value.serviceIdentity !== this.identity() ||
        value.remoteProjectId !== this.project(directory, domain).remoteProjectId
      )
        throw Error('Remote invocation binding changed.');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  assertTaskIdle(directory, domain) {
    const root = path.join(this.directory, 'remote-invocations');
    if (!fs.existsSync(root)) return;
    const project = this.project(directory, domain);
    for (const file of fs.readdirSync(root)) {
      const pending = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (
        pending.remoteProjectId === project.remoteProjectId &&
        pending.serviceIdentity === this.identity() &&
        ['submitting', 'running', 'unknown'].includes(pending.status)
      )
        throw Error(
          'A remote invocation remains active or unknown. Resolve its outcome before changing execution settings.',
        );
    }
  }
  async refreshTask(directory, domain, chatId) {
    const pending = this.task(directory, domain, chatId);
    if (!pending) return null;
    if (!['submitting', 'running', 'unknown'].includes(pending.status)) return pending;
    const client = this.sessionClient(directory, domain, chatId);
    try {
      const received = await client.invocation(pending.invocationId);
      const invocation =
        received && typeof received === 'object' && !Array.isArray(received) ? received : {};
      const completed =
        invocation.status === 'completed' &&
        invocation.outcome === 'completed' &&
        invocation.result &&
        typeof invocation.result === 'object' &&
        !Array.isArray(invocation.result);
      const notSubmitted =
        invocation.status === 'failed' &&
        invocation.outcome === 'not_submitted' &&
        (invocation.result === undefined || invocation.result === null);
      const active =
        ['running', 'unknown'].includes(invocation.status) && invocation.outcome === 'unknown';
      if (invocation.id !== pending.invocationId || (!completed && !notSubmitted && !active)) {
        writePrivateJson(this.taskFile(directory, domain, chatId), {
          ...pending,
          status: 'unknown',
          outcome: 'unknown',
        });
        throw Error(
          'Remote invocation returned incomplete or inconsistent status. Its outcome remains unknown.',
        );
      }
      const next = {
        ...pending,
        status: invocation.status,
        outcome: invocation.outcome,
        needsImport: Boolean(invocation.result),
      };
      writePrivateJson(this.taskFile(directory, domain, chatId), next);
      return next;
    } catch (error) {
      // A missing invocation after a lost response is not proof that it never ran.
      if (error.status === 404) {
        const unknown = { ...pending, status: 'unknown', outcome: 'unknown' };
        writePrivateJson(this.taskFile(directory, domain, chatId), unknown);
        return unknown;
      }
      throw error;
    } finally {
      await client.close();
    }
  }
  async session(directory, domain, chatId) {
    const client = this.sessionClient(directory, domain, chatId);
    try {
      const session = await client.currentSession();
      const binding = this.sessionBinding(directory, domain, chatId);
      this.sessions.update(binding, { applicationSessionId: session.id, status: session.status });
      return session;
    } catch (error) {
      if (error.code === 'SESSION_NOT_FOUND') return null;
      throw error;
    } finally {
      await client.close();
    }
  }
  async terminateSession(directory, domain, chatId, applicationSessionId) {
    const client = this.sessionClient(directory, domain, chatId);
    try {
      const current = await client.currentSession();
      if (current.id !== applicationSessionId)
        throw Error('Remote session changed. Refresh before ending it.');
      return await client.terminateSession(applicationSessionId);
    } finally {
      await client.close();
    }
  }
  async artifacts(directory, domain) {
    const binding = this.project(directory, domain);
    if (binding.protocol !== REMOTE_PROTOCOL_VERSION || binding.serviceIdentity !== this.identity())
      throw Error('Remote project binding changed.');
    const client = this.client({ remoteProjectId: binding.remoteProjectId, domain });
    try {
      const response = await client.artifacts();
      return Array.isArray(response) ? response : response.artifacts;
    } finally {
      await client.close();
    }
  }
  async download(directory, domain, artifactId, relativePath) {
    const binding = this.project(directory, domain);
    if (binding.serviceIdentity !== this.identity()) throw Error('Remote project binding changed.');
    const client = this.client({ remoteProjectId: binding.remoteProjectId, domain });
    try {
      return await client.downloadArtifact(artifactId, { directory, relativePath });
    } finally {
      await client.close();
    }
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
    if (!this.view().capabilities?.snapshots) throw Error('Remote file upload is unavailable.');
    const snapshot = selectedSnapshot(directory, files),
      id = crypto.randomUUID();
    this.reviews.set(id, {
      directory: fs.realpathSync(directory),
      domain,
      files,
      digest: snapshot.digest,
      identity: this.identity(),
      expires: Date.now() + 300000,
    });
    for (const [key, value] of this.reviews)
      if (value.expires < Date.now()) this.reviews.delete(key);
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
      throw Error('File upload review expired. Review the selection again.');
    if (this.locks.has(key)) throw Error('Remote project settings are busy.');
    this.assertTaskIdle(directory, domain);
    this.locks.add(key);
    try {
      const snapshot = selectedSnapshot(directory, review.files);
      if (snapshot.digest !== review.digest)
        throw Error('Selected files changed. Review them again before uploading.');
      const binding = await this.bind(directory, domain);
      const client = this.client({ remoteProjectId: binding.remoteProjectId, domain });
      try {
        const uploaded = await client.sync(snapshot, binding.snapshotId || null);
        uuid(uploaded.id);
        return this.update(directory, domain, {
          location: 'remote',
          files: review.files,
          manifestDigest: snapshot.digest,
          snapshotId: uploaded.id,
          syncedAt: new Date().toISOString(),
        });
      } finally {
        await client.close();
      }
    } finally {
      this.locks.delete(key);
    }
  }
  async ensureSynced(directory, domain) {
    const binding = this.project(directory, domain);
    if (
      binding.protocol !== REMOTE_PROTOCOL_VERSION ||
      !binding.remoteProjectId ||
      !binding.snapshotId ||
      !binding.files?.length
    )
      throw Error('Choose and upload project files before running remotely.');
    if (binding.serviceIdentity !== this.identity())
      throw Error('Project belongs to another service or credential.');
    if (selectedSnapshot(directory, binding.files).digest !== binding.manifestDigest)
      throw Error(
        'Local inputs changed. Review and upload the changed project files before running remotely.',
      );
    return binding;
  }
}
module.exports = { RemoteSettings, selectedSnapshot, excluded };
