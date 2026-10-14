const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function writePrivateJson(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = exclusive ? file : file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (!exclusive) fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const parent = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
  } finally {
    if (!exclusive) fs.rmSync(temporary, { force: true });
  }
}
const uuid = value => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw Error('Invalid remote identity.');
  return value;
};
function serviceUrl(value) {
  const url = new URL(value);
  if (
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error(
      'Remote service requires a clean HTTPS origin (loopback HTTP is allowed for development).',
    );
  return url.origin;
}

// Data-only protocol client. No server-supplied path, executable or image is run locally.
class RemoteClient {
  constructor({ url, credential, credentialProvider, journalDirectory, fetch = global.fetch }) {
    this.url = serviceUrl(url);
    if (!credentialProvider && (!credential || /[\r\n]/.test(credential)))
      throw Error('Remote credentials are not configured.');
    this.credential = credential;
    this.credentialProvider = credentialProvider;
    this.journalDirectory = journalDirectory;
    this.fetch = fetch;
  }
  route(project, suffix) {
    return `/v1/projects/${uuid(project)}${suffix ? '/' + suffix : ''}`;
  }
  async request(route, { method = 'GET', body, binary = false } = {}) {
    const credential = this.credentialProvider ? await this.credentialProvider() : this.credential;
    if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential))
      throw Error('Remote credentials are not configured.');
    const send = token =>
      this.fetch(this.url + route, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body
            ? {
                'Content-Type': Buffer.isBuffer(body)
                  ? 'application/octet-stream'
                  : 'application/json',
              }
            : {}),
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
    let response = await send(credential);
    // Only an explicit invalid_token challenge on a read is safe to retry.
    // Mutations retain their journal/request identity and are never replayed here.
    if (
      method === 'GET' &&
      this.credentialProvider &&
      response.status === 401 &&
      /Bearer\s+.*error="invalid_token"/i.test(response.headers.get('www-authenticate') || '')
    ) {
      await response.body?.cancel();
      response = await send(await this.credentialProvider({ rejectedToken: credential }));
    }
    if (!response.ok) {
      // Never forward arbitrary server diagnostics (which may contain credentials) into the renderer/model.
      const detail = await response.json().catch(() => ({}));
      const knownCodes = new Set([
        'INVALID_INPUT',
        'NOT_FOUND',
        'FORBIDDEN',
        'UNAUTHORIZED',
        'SCOPE_DENIED',
        'BUSY',
        'INPUT_CHANGED',
        'APPROVAL_REQUIRED',
        'APPROVAL_EXPIRED',
        'QUEUE_FULL',
        'QUOTA_EXCEEDED',
        'DOMAIN_UNAVAILABLE',
        'OUTCOME_UNKNOWN',
        'IDEMPOTENCY_CONFLICT',
        'SANDBOX_STOP_UNCONFIRMED',
      ]);
      const code = knownCodes.has(detail.code) ? detail.code : 'REMOTE_ERROR';
      throw Object.assign(Error(`Remote request failed (${response.status}, ${code}).`), {
        code,
        status: response.status,
      });
    }
    if (binary) {
      if (Number(response.headers.get('content-length')) > 64 * 1048576)
        throw Error('Remote artifact exceeds 64 MiB.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 64 * 1048576) throw Error('Remote artifact exceeds 64 MiB.');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    const value = await response.text();
    if (Buffer.byteLength(value) > 8 * 1048576) throw Error('Remote response exceeds 8 MiB.');
    return JSON.parse(value);
  }
  info() {
    return this.request('/v1/service-info');
  }
  createProject(domain) {
    return this.request('/v1/projects', { method: 'POST', body: { domain } });
  }
  state(project) {
    return this.request(this.route(project, 'state'));
  }
  capabilities(project) {
    return this.request(this.route(project, 'capabilities'));
  }
  checkpoints(project) {
    return this.request(this.route(project, 'checkpoints'));
  }
  environment(project) {
    return this.request(this.route(project, 'environment'));
  }
  release(project) {
    return this.request(this.route(project, 'environment'), { method: 'DELETE' });
  }
  job(project, id) {
    return this.request(this.route(project, 'jobs/' + uuid(id)));
  }
  byRequest(project, id) {
    return this.request(this.route(project, 'jobs/by-request/' + uuid(id)));
  }
  cancel(project, id) {
    return this.request(this.route(project, 'jobs/' + uuid(id) + '/cancel'), {
      method: 'POST',
      body: {},
    });
  }
  async sync(project, snapshot, baseSnapshotId) {
    const upload = await this.request(this.route(project, 'snapshot-uploads'), {
      method: 'POST',
      body: { manifest: snapshot.manifest, baseSnapshotId },
    });
    uuid(upload.uploadId);
    for (const file of upload.missing) {
      const bytes = snapshot.blobs.get(file.sha256);
      if (!bytes || hash(bytes) !== file.sha256)
        throw Error('Remote upload requested an unselected file.');
      await this.request(
        this.route(project, `snapshot-uploads/${upload.uploadId}/blobs/${file.sha256}`),
        { method: 'PUT', body: bytes },
      );
    }
    return this.request(this.route(project, `snapshot-uploads/${upload.uploadId}/commit`), {
      method: 'POST',
      body: {},
    });
  }
  async submit(project, intent) {
    if (!this.journalDirectory) throw Error('Remote submission journal is required.');
    fs.mkdirSync(this.journalDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(this.journalDirectory, uuid(intent.requestId) + '.json');
    // Persist identity BEFORE either mutating operation. Recovery queries by request; it never replays a POST.
    let grant;
    try {
      writePrivateJson(file, { serviceUrl: this.url, projectId: project, intent }, true);
      grant = await this.request(this.route(project, 'invocation-grants'), {
        method: 'POST',
        body: intent,
      });
      uuid(grant.invocationGrantId);
    } catch (error) {
      error.knownNotSubmitted = true;
      throw error;
    }
    return this.request(this.route(project, 'jobs'), {
      method: 'POST',
      body: { schemaVersion: '0.1', ...intent, invocationGrantId: grant.invocationGrantId },
    });
  }
  async artifact(project, id) {
    const ref = await this.request(this.route(project, 'artifacts/' + uuid(id)));
    const content = await this.request(this.route(project, 'artifacts/' + uuid(id) + '/content'), {
      binary: true,
    });
    if (content.length !== ref.sizeBytes || hash(content) !== ref.sha256)
      throw Error('Remote artifact digest differs from its identity.');
    return { ref, content };
  }
}
module.exports = { RemoteClient, serviceUrl, hash, uuid, writePrivateJson };
