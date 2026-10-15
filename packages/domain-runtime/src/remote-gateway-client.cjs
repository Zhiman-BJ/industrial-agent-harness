const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { serviceUrl, hash } = require('./remote-client.cjs');
const { boundedIdentity, gatewayIdentity } = require('./remote-gateway-sessions.cjs');

const queues = new Map();
const MAX_JSON = 8 * 1048576;
const MAX_ARTIFACT = 64 * 1048576;
const safeCode = value =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : 'REMOTE_ERROR';

class RemoteGatewayError extends Error {
  constructor({ layer = 'transport', code, status, outcome, retryable = false, retryAfterMs = 0 }) {
    code = safeCode(code);
    super(`Remote gateway request failed (${layer}, ${code}${status ? ', ' + status : ''}).`);
    this.name = 'RemoteGatewayError';
    this.layer = layer;
    this.code = code;
    if (status) this.status = status;
    this.outcome = outcome === 'not_submitted' ? outcome : 'unknown';
    this.notSubmitted = this.outcome === 'not_submitted';
    this.retryable = retryable === true;
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  }
}

function errorEnvelope(value) {
  if (!value || typeof value !== 'object') return {};
  return value.error && typeof value.error === 'object' ? { ...value, ...value.error } : value;
}

function gatewayError(value, layer, status, retryAfter) {
  const detail = errorEnvelope(value);
  let retryAfterMs = Number(detail.retryAfterSeconds) * 1000;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    retryAfterMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Math.max(0, Date.parse(retryAfter) - Date.now());
  }
  return new RemoteGatewayError({ ...detail, layer, status, retryAfterMs });
}

function normalizeError(error) {
  if (error instanceof RemoteGatewayError) return error;
  if (typeof error?.code === 'number') return gatewayError(error.data || {}, 'jsonrpc', undefined);
  return new RemoteGatewayError({
    code: error?.name === 'AbortError' ? 'REQUEST_ABORTED' : 'TRANSPORT_ERROR',
  });
}

function parseToolPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    if (Buffer.byteLength(JSON.stringify(result.structuredContent)) > MAX_JSON)
      throw new RemoteGatewayError({ layer: 'protocol', code: 'INVALID_TOOL_RESULT' });
    return result.structuredContent;
  }
  const text = (result.content || [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
  if (!text || Buffer.byteLength(text) > MAX_JSON)
    throw new RemoteGatewayError({ layer: 'protocol', code: 'INVALID_TOOL_RESULT' });
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteGatewayError({ layer: 'protocol', code: 'INVALID_TOOL_RESULT' });
  }
}

async function readBoundedResponse(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new RemoteGatewayError({ layer: 'protocol', code: 'RESPONSE_TOO_LARGE' });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > maximum)
      throw new RemoteGatewayError({ layer: 'protocol', code: 'RESPONSE_TOO_LARGE' });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function relativeFile(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..')
  )
    throw Error('Unsafe remote file path.');
  return value;
}

function verifyBytes(bytes, expected = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_ARTIFACT) throw Error('Remote artifact exceeds 64 MiB.');
  if (
    expected.sizeBytes !== undefined &&
    (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes !== bytes.length)
  )
    throw Error('Remote file size differs from its approved metadata.');
  if (
    expected.sha256 !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expected.sha256) || hash(bytes) !== expected.sha256)
  )
    throw Error('Remote file digest differs from its approved metadata.');
  return bytes;
}

// Destination paths are chosen by the user/host, never copied from a server pathname.
// Existing files are never replaced; callers must explicitly choose another name.
function safeDownload(projectDir, relativePath, content, expected = {}) {
  relativeFile(relativePath);
  const bytes = verifyBytes(content, expected);
  const root = fs.realpathSync(projectDir);
  let parent = root;
  const parts = relativePath.split('/');
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      fs.mkdirSync(parent, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(parent) !== parent)
      throw Error('Download destination contains a symlink or invalid directory.');
  }
  const file = path.join(parent, parts.at(-1));
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  return file;
}

class RemoteGatewayClient {
  constructor({
    url,
    credential,
    credentialProvider,
    credentialKey,
    remoteProjectId,
    clientSessionId,
    domain,
    serverId,
    fetch = global.fetch,
    requestTimeoutMs = 120000,
  }) {
    this.url = serviceUrl(url);
    this.serviceIdentity = gatewayIdentity({ url: this.url, credential, credentialKey, serverId });
    this.credential = credential;
    this.credentialProvider = credentialProvider;
    this.fetch = fetch;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 600000
    )
      throw Error('Invalid remote request timeout.');
    this.requestTimeoutMs = requestTimeoutMs;
    this.binding = Object.freeze({
      ...(remoteProjectId
        ? { remoteProjectId: boundedIdentity(remoteProjectId, 'project identity') }
        : {}),
      ...(clientSessionId
        ? { clientSessionId: boundedIdentity(clientSessionId, 'client session identity') }
        : {}),
      ...(domain ? { domain: boundedIdentity(domain, 'domain') } : {}),
    });
    this.options = {
      url: this.url,
      credential,
      credentialProvider,
      credentialKey,
      serverId,
      fetch,
      requestTimeoutMs,
    };
  }
  withBinding(binding) {
    return new RemoteGatewayClient({ ...this.options, ...binding });
  }
  // The token is resolved per request so an account-bound provider can rotate
  // credentials; the token never lands in journals, manifests or bindings.
  async token(options) {
    const token = this.credentialProvider
      ? await this.credentialProvider(options)
      : this.credential;
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token))
      throw Error('Remote credentials are not configured.');
    return token;
  }
  async headers(options) {
    return {
      Authorization: 'Bearer ' + (await this.token(options)),
      ...this.bindingHeaders(),
    };
  }
  bindingHeaders() {
    return {
      ...(this.binding.remoteProjectId
        ? { 'X-Remote-Project-Id': this.binding.remoteProjectId }
        : {}),
      ...(this.binding.clientSessionId
        ? { 'X-Client-Session-Id': this.binding.clientSessionId }
        : {}),
    };
  }
  requireBinding() {
    if (!this.binding.remoteProjectId || !this.binding.clientSessionId || !this.binding.domain)
      throw Error('Remote project, chat and domain binding is required.');
  }
  projectRoute(suffix = '') {
    if (!this.binding.remoteProjectId) throw Error('Remote project binding is required.');
    return (
      '/v1/projects/' +
      encodeURIComponent(this.binding.remoteProjectId) +
      (suffix ? '/' + suffix : '')
    );
  }
  async send(url, init) {
    try {
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      return await this.fetch(url, {
        ...init,
        redirect: 'error',
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch (error) {
      throw normalizeError(error);
    }
  }
  async checkedFetch(url, init, { rejectedToken } = {}) {
    let response = await this.send(url, init);
    // Only an explicit invalid_token challenge on a read is safe to retry once
    // with a fresh credential. Mutations are never replayed here.
    if (
      rejectedToken &&
      response.status === 401 &&
      /Bearer\s+.*error="invalid_token"/i.test(response.headers.get('www-authenticate') || '')
    ) {
      await response.body?.cancel();
      response = await this.send(url, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: 'Bearer ' + (await this.token({ rejectedToken })),
        },
      });
    }
    if (!response.ok) {
      let detail = {};
      let bytes;
      try {
        bytes = await readBoundedResponse(response, MAX_JSON);
      } catch (error) {
        if (error instanceof RemoteGatewayError)
          throw new RemoteGatewayError({
            layer: 'http',
            code: error.code,
            status: response.status,
          });
        throw normalizeError(error);
      }
      try {
        detail = JSON.parse(bytes.toString('utf8'));
      } catch {
        /* Arbitrary diagnostics stay private. */
      }
      throw gatewayError(detail, 'http', response.status, response.headers.get('retry-after'));
    }
    // Bound JSON before the SDK's response.json() can buffer an untrusted body.
    if (
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ===
      'application/json'
    ) {
      const bytes = await readBoundedResponse(response, MAX_JSON);
      return new Response(bytes.length ? bytes : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  }
  async request(route, { method = 'GET', body, binary = false, signal } = {}) {
    if (!route.startsWith('/v1/') || route.includes('://') || route.includes('#'))
      throw Error('Invalid remote request route.');
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const token = await this.token();
    const response = await this.checkedFetch(
      this.url + route,
      {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...this.bindingHeaders(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
      // Reads with an account-bound provider may retry once on invalid_token.
      { rejectedToken: method === 'GET' && this.credentialProvider ? token : null },
    );
    const maximum = binary ? MAX_ARTIFACT : MAX_JSON;
    const bytes = await readBoundedResponse(response, maximum);
    if (binary) return bytes;
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RemoteGatewayError({ layer: 'protocol', code: 'INVALID_JSON' });
    }
  }
  info(options) {
    return this.request('/v1/service-info', options);
  }
  createProject(body, options = {}) {
    if (typeof body === 'string') body = { domain: body };
    return this.request('/v1/projects', { ...options, method: 'POST', body });
  }
  state(options) {
    return this.request(this.projectRoute('state'), options);
  }
  capabilities(options) {
    return this.request(this.projectRoute('capabilities'), options);
  }
  snapshots(options) {
    return this.request(this.projectRoute('snapshots'), options);
  }
  snapshot(id, options) {
    return this.request(
      this.projectRoute(
        'snapshots/' + encodeURIComponent(boundedIdentity(id, 'snapshot identity')),
      ),
      options,
    );
  }
  async sync(snapshot, baseSnapshotId = null, options = {}) {
    const manifest = snapshot?.manifest;
    if (
      manifest?.schemaVersion !== '0.1' ||
      !Array.isArray(manifest.files) ||
      !manifest.files.length ||
      manifest.files.length > 256 ||
      !(snapshot.blobs instanceof Map)
    )
      throw Error('Invalid bounded snapshot upload.');
    const seen = new Set();
    let total = 0;
    const files = manifest.files.map(file => {
      relativeFile(file.path);
      if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 || ''))
        throw Error('Invalid snapshot file identity.');
      seen.add(file.path);
      const bytes = verifyBytes(snapshot.blobs.get(file.sha256) || Buffer.alloc(0), file);
      total += bytes.length;
      if (total > 8 * 1048576) throw Error('Selected files exceed 8 MiB.');
      return { path: file.path, contentBase64: bytes.toString('base64') };
    });
    if (baseSnapshotId !== null) boundedIdentity(baseSnapshotId, 'base snapshot identity');
    return this.request(this.projectRoute('snapshots'), {
      ...options,
      method: 'POST',
      body: { manifest, files, baseSnapshotId },
    });
  }
  snapshotFile(id, relativePath, options = {}) {
    relativeFile(relativePath);
    return this.request(
      this.projectRoute(
        'snapshots/' +
          encodeURIComponent(boundedIdentity(id, 'snapshot identity')) +
          '/files?path=' +
          encodeURIComponent(relativePath),
      ),
      { ...options, binary: true },
    );
  }
  grant(intent, options = {}) {
    this.requireBinding();
    return this.request(this.projectRoute('grants'), { ...options, method: 'POST', body: intent });
  }
  invocation(id, options) {
    return this.request(
      this.projectRoute(
        'invocations/' + encodeURIComponent(boundedIdentity(id, 'invocation identity')),
      ),
      options,
    );
  }
  artifacts(options) {
    return this.request(this.projectRoute('artifacts'), options);
  }
  async artifact(id, ref, options = {}) {
    boundedIdentity(id, 'artifact identity');
    if (!ref) {
      const response = await this.artifacts(options);
      ref = (Array.isArray(response) ? response : response.artifacts || []).find(
        item => item.id === id,
      );
    }
    if (
      !ref ||
      ref.id !== id ||
      !/^[a-f0-9]{64}$/.test(ref.sha256 || '') ||
      !Number.isSafeInteger(ref.sizeBytes)
    )
      throw Error('Remote artifact metadata is unavailable.');
    const content = await this.request(
      this.projectRoute('artifacts/' + encodeURIComponent(id) + '/content'),
      { ...options, binary: true },
    );
    return { ref, content: verifyBytes(content, ref) };
  }
  async downloadArtifact(id, { directory, relativePath, ref, signal } = {}) {
    if (!directory || !relativePath) throw Error('Choose a local download directory and path.');
    const artifact = await this.artifact(id, ref, { signal });
    const file = safeDownload(directory, relativePath, artifact.content, artifact.ref);
    return { ...artifact.ref, path: file };
  }
  currentSession(options) {
    this.requireBinding();
    return this.request('/v1/sessions/current/' + encodeURIComponent(this.binding.domain), options);
  }
  terminateSession(id, options = {}) {
    this.requireBinding();
    return this.request(
      '/v1/sessions/' +
        encodeURIComponent(boundedIdentity(id, 'application session identity')) +
        '/terminate',
      { ...options, method: 'POST', body: {} },
    );
  }
  async connect() {
    this.requireBinding();
    if (this.closed) throw Error('Remote gateway transport is closed.');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: 'industrial-harness-gateway', version: '1.1.0' });
      const transport = new StreamableHTTPClientTransport(
        new URL(this.url + '/v1/mcp/' + encodeURIComponent(this.binding.domain)),
        {
          // Resolved per connect so a rotated account token is picked up on
          // reconnect without persisting it anywhere.
          requestInit: { headers: await this.headers(), redirect: 'error' },
          fetch: (url, init) => this.checkedFetch(url, init),
          reconnectionOptions: { maxRetries: 0 },
        },
      );
      client.onerror = () => {};
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      try {
        await client.connect(transport, { timeout: this.requestTimeoutMs });
        if (this.closed) {
          await client.close();
          throw Error('Remote gateway transport is closed.');
        }
        this.client = client;
        return client;
      } catch (error) {
        await client.close().catch(() => {});
        throw normalizeError(error);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }
  serialize(operation, signal) {
    this.requireBinding();
    const key = JSON.stringify([this.serviceIdentity, this.binding]);
    const previous = queues.get(key) || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => {
        if (signal?.aborted)
          throw new RemoteGatewayError({ code: 'REQUEST_ABORTED', outcome: 'not_submitted' });
        return operation();
      });
    queues.set(key, pending);
    void pending
      .finally(() => {
        if (queues.get(key) === pending) queues.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  rawMcpCall(name, args, { signal, retries = 1 } = {}) {
    if (!Number.isInteger(retries) || retries < 0 || retries > 3)
      throw Error('Remote retry limit must be between zero and three.');
    return this.serialize(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const client = await this.connect();
          const result = await client.callTool({ name, arguments: args }, undefined, {
            signal,
            timeout: this.requestTimeoutMs,
            maxTotalTimeout: this.requestTimeoutMs,
          });
          const payload = parseToolPayload(result);
          if (result.isError === true) throw gatewayError(payload, 'tool');
          return { result, payload };
        } catch (error) {
          const failure = normalizeError(error);
          if (
            !failure.notSubmitted ||
            !failure.retryable ||
            attempt >= retries ||
            failure.retryAfterMs > 30000 ||
            signal?.aborted
          )
            throw failure;
          try {
            await delay(Math.max(25, failure.retryAfterMs), undefined, { signal });
          } catch (error) {
            throw normalizeError(error);
          }
        }
      }
    }, signal);
  }
  async listTools(args = {}, options) {
    return (await this.rawMcpCall('domain_tool_list', args, options)).payload;
  }
  async describeTool(toolId, options) {
    return (await this.rawMcpCall('domain_tool_describe', { toolId }, options)).payload;
  }
  async callTool(toolId, args = {}, { invocation, ...options } = {}) {
    return (
      await this.rawMcpCall(
        'domain_tool_call',
        { toolId, arguments: args, ...(invocation ? { invocation } : {}) },
        options,
      )
    ).payload;
  }
  async close() {
    this.closed = true;
    if (this.connecting) await this.connecting.catch(() => {});
    await this.client?.close();
    this.client = null;
  }
}

module.exports = {
  RemoteGatewayClient,
  RemoteGatewayError,
  parseToolPayload,
  safeDownload,
  verifyBytes,
};
