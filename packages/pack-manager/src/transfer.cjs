// Bound connection and idle time independently of total transfer time. A large
// native toolchain can take minutes while still making steady progress.
class TransferProgress {
  constructor(total, now = () => performance.now()) {
    this.total = total;
    this.now = now;
    this.startedAt = now();
  }
  update(received) {
    const elapsed = (this.now() - this.startedAt) / 1000;
    const bytesPerSecond = elapsed > 0 && received > 0 ? received / elapsed : undefined;
    return {
      phase: 'downloading',
      received,
      total: this.total,
      ...(bytesPerSecond ? { bytesPerSecond } : {}),
      ...(bytesPerSecond && this.total != null
        ? { etaSeconds: Math.max(0, (this.total - received) / bytesPerSecond) }
        : {}),
    };
  }
}

// Parse a `Bearer realm="…",service="…"` challenge; null when absent or
// malformed. Values are always attacker-influenced: never executed, only
// used as an https URL and query parameter below.
function parseBearerChallenge(value) {
  if (typeof value !== 'string' || !/^Bearer\s+/i.test(value)) return null;
  const fields = {};
  for (const token of value.replace(/^Bearer\s+/i, '').split(',')) {
    const match = /^\s*([a-z]+)\s*=\s*"([^"]*)"\s*$/.exec(token);
    if (match) fields[match[1].toLowerCase()] = match[2];
  }
  if (!fields.realm || !/^https:\/\//.test(fields.realm)) return null;
  return { realm: fields.realm, service: fields.service || '' };
}

// Registry API URLs carry the repository in the path: /v2/<name>/blobs|manifests/…
function registryScope(target) {
  const match = /^\/v2\/(.+)\/(?:blobs|manifests|tags)\//.exec(target.pathname);
  return match ? `repository:${match[1]}:pull` : null;
}

class Transfer {
  constructor({ signal, stallMs = 60000, timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
    this.controller = new AbortController();
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    this.stallMs = stallMs;
    this.total = setTimeout(
      () => this.controller.abort(Error('Download timed out. Please retry.')),
      timeoutMs,
    );
    this.total.unref?.();
    this.touch();
  }
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(
      () => this.controller.abort(Error('Download stalled. Please retry.')),
      this.stallMs,
    );
    this.idle.unref?.();
  }
  // Public OCI registries (e.g. a Harbor mirror) challenge even anonymous
  // reads with a Bearer token. Resolve that challenge without credentials;
  // anything that does not issue an anonymous token stays an HTTP failure.
  async anonymousRegistryToken(challenge, target) {
    const scope = registryScope(target);
    const url = new URL(challenge.realm);
    url.searchParams.set('service', challenge.service);
    if (scope) url.searchParams.set('scope', scope);
    const response = await fetch(url, { signal: this.signal });
    this.touch();
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Download failed: registry token service HTTP ${response.status}`);
    }
    const payload = await response.json();
    const token = payload?.token || payload?.access_token;
    if (typeof token !== 'string' || !token)
      throw Error('Download failed: registry token service returned no token.');
    return token;
  }
  async response(url, headers = {}) {
    let authorization;
    let authOrigin;
    for (let hops = 0; hops <= 12; hops++) {
      this.signal.throwIfAborted();
      const target = new URL(url);
      if (target.protocol !== 'https:') throw Error('Downloads require HTTPS.');
      // A redirect must not forward the registry token to another origin.
      if (authorization && authOrigin && target.origin !== authOrigin) {
        authorization = undefined;
        authOrigin = undefined;
      }
      const response = await fetch(url, {
        redirect: 'manual',
        signal: this.signal,
        headers: { ...headers, ...(authorization ? { authorization } : {}) },
      });
      this.touch();
      if (response.status === 401 && !authorization) {
        const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
        await response.body?.cancel();
        if (challenge && registryScope(target)) {
          const token = await this.anonymousRegistryToken(challenge, target);
          authorization = `Bearer ${token}`;
          authOrigin = target.origin;
          continue;
        }
        throw Error('Download failed: HTTP 401');
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw Error(`Download failed: HTTP ${response.status}`);
        }
        Object.defineProperty(response, 'transferUrl', { value: target.href });
        return response;
      }
      await response.body?.cancel();
      if (!response.headers.get('location')) throw Error('Download has too many redirects.');
      url = new URL(response.headers.get('location'), url).toString();
    }
    throw Error('Download has too many redirects.');
  }
  async run(action) {
    try {
      return await action(this);
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      throw error;
    } finally {
      clearTimeout(this.idle);
      clearTimeout(this.total);
    }
  }
}
module.exports = { Transfer, TransferProgress, parseBearerChallenge, registryScope };
