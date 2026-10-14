const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { validateConfig, trustedUrl } = require('./config.cjs');
const { SessionStore } = require('./store.cjs');

const messages = {
  cancelled: 'Sign-in cancelled.',
  timeout: 'Sign-in timed out. Try again.',
  access_denied: 'This account cannot access the application. Contact your administrator.',
  login_required: 'Your session has expired. Sign in again.',
  protocol_error: 'Platform sign-in could not be verified. Check the account configuration.',
  unavailable: 'The account service is unavailable. Try again.',
  refresh_uncertain: 'Session renewal could not be confirmed. Sign in again.',
  invalid_code: 'Paste the complete code#state from the account center.',
  no_pending_login: 'Start sign-in before submitting an authorization code.',
  login_consumed: 'Sign-in is already being completed.',
};
function authError(code) {
  return Object.assign(Error(messages[code] || messages.protocol_error), { code });
}
function safeError(error) {
  if (Object.hasOwn(messages, error?.code)) return error;
  if (error?.error === 'access_denied') return authError('access_denied');
  if (error?.error === 'invalid_grant') return authError('login_required');
  return authError('protocol_error');
}
function sameState(actual, expected) {
  return (
    typeof actual === 'string' &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

class AuthManager extends EventEmitter {
  constructor({
    config,
    store,
    fetch = global.fetch,
    createServer = http.createServer,
    loginTimeoutMs = 300000,
    now = Date.now,
  }) {
    super();
    this.config = validateConfig(config);
    this.store = store;
    this.fetch = fetch;
    this.createServer = createServer;
    this.now = now;
    this.loginTimeoutMs = loginTimeoutMs;
    const binding = { ...this.config };
    delete binding.services;
    this.identity = crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    this.epoch = 0;
    this.state = 'signed_out';
    this.user = null;
    this.exchanges = new Set();
    this.revocationFailed = false;
  }
  view() {
    return {
      status: this.config.clientId ? this.state : 'not_configured',
      user: this.user,
      issuer: this.config.issuer,
      persistent: this.store.persistent(),
      error: this.error || null,
      login:
        this.state === 'signing_in' && this.pending
          ? {
              loopbackAvailable: this.pending.loopbackAvailable,
              browserFailed: Boolean(this.pending.browserFailed),
              manualUrl: this.pending.manualUrl,
            }
          : null,
    };
  }
  changed(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('change', this.view());
  }
  async protocol() {
    if (!this.config.clientId) throw Error('Configure a registered native client ID first.');
    if (!this.protocolPromise)
      this.protocolPromise = (async () => {
        const oidc = await import('openid-client');
        const issuer = new URL(this.config.issuer);
        const boundedFetch = (input, init) => {
          // Discovery must not silently downgrade TLS or send credentials through a redirect.
          trustedUrl(String(input));
          const target = new URL(input);
          if (target.protocol !== 'https:' && target.origin !== issuer.origin)
            throw authError('protocol_error');
          return this.fetch(input, { ...init, redirect: 'error' });
        };
        const config = await oidc.discovery(
          issuer,
          this.config.clientId,
          { token_endpoint_auth_method: 'none' },
          oidc.None(),
          {
            timeout: 15,
            [oidc.customFetch]: boundedFetch,
            execute: [
              oidc.enableNonRepudiationChecks,
              ...(issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : []),
            ],
          },
        );
        const metadata = config.serverMetadata();
        for (const key of [
          'authorization_endpoint',
          'token_endpoint',
          'jwks_uri',
          'revocation_endpoint',
        ]) {
          if (!metadata[key]) throw authError('protocol_error');
          trustedUrl(metadata[key]);
        }
        if (!metadata.code_challenge_methods_supported?.includes('S256'))
          throw authError('protocol_error');
        return { oidc, config };
      })().catch(error => {
        this.protocolPromise = null;
        throw safeError(error);
      });
    return this.protocolPromise;
  }
  async restore() {
    return this.store.transaction(async tx => {
      const session = tx.read();
      if (session?.binding === this.identity && !session.refreshPending) {
        this.user = session.user;
        this.changed('signed_in');
      } else {
        this.user = null;
        this.changed(session?.refreshPending ? 'reauth_required' : 'signed_out');
      }
      return this.view();
    });
  }
  async login({ openBrowser, manualOnly = false } = {}) {
    if (this.pending || this.starting) throw Error('Sign-in is already in progress.');
    const epoch = ++this.epoch;
    this.starting = true;
    this.changed('signing_in');
    let server,
      timer,
      succeeded = false;
    try {
      const { oidc, config } = await this.protocol();
      if (epoch !== this.epoch) throw authError('cancelled');
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      let complete,
        fail,
        consumed = false;
      const result = new Promise((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      // Attach immediately so cancellation during browser launch is always handled.
      result.catch(() => {});
      const manualRedirect = this.config.issuer + '/oauth/code';
      const exchange = async url => {
        if (epoch !== this.epoch) throw authError('cancelled');
        if (consumed) throw authError('login_consumed');
        consumed = true;
        let tokens;
        try {
          tokens = await oidc.authorizationCodeGrant(config, url, {
            pkceCodeVerifier: verifier,
            expectedState: state,
            expectedNonce: nonce,
            idTokenExpected: true,
          });
          const claims = tokens.claims();
          if (!claims?.sub || !tokens.refresh_token) throw authError('protocol_error');
          let user = {
            sub: claims.sub,
            name: typeof claims.name === 'string' ? claims.name.slice(0, 160) : claims.sub,
          };
          if (config.serverMetadata().userinfo_endpoint) {
            const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
            user = {
              sub: claims.sub,
              name: typeof info.name === 'string' ? info.name.slice(0, 160) : user.name,
            };
          }
          await this.store.transaction(async tx => {
            if (epoch !== this.epoch) throw authError('cancelled');
            tx.write(this.session(tokens, user));
          });
          if (epoch !== this.epoch) throw authError('cancelled');
          this.user = user;
          this.changed('signed_in');
          return this.view();
        } catch (error) {
          if (tokens?.refresh_token) {
            await this.store
              .transaction(tx => {
                if (tx.read()?.refreshToken === tokens.refresh_token) tx.clear();
              })
              .catch(() => {});
            await oidc
              .tokenRevocation(config, tokens.refresh_token, {
                token_type_hint: 'refresh_token',
              })
              .catch(() => {
                this.revocationFailed = true;
              });
          }
          throw safeError(error);
        }
      };
      const accept = url => {
        const pending = exchange(url);
        this.exchanges.add(pending);
        pending.then(
          () => this.exchanges.delete(pending),
          () => this.exchanges.delete(pending),
        );
        return pending;
      };
      let redirect;
      const callback = async (request, response) => {
        const reply = (status, text) => {
          response.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(text);
        };
        if (
          request.method !== 'GET' ||
          request.url.length > 8192 ||
          request.headers.host !== new URL(redirect).host
        )
          return reply(400, 'Invalid callback.');
        let url;
        try {
          url = new URL(request.url, redirect);
        } catch {
          return reply(400, 'Invalid callback.');
        }
        if (url.origin !== new URL(redirect).origin || url.pathname !== '/callback')
          return reply(404, 'Not found.');
        if (
          url.searchParams.getAll('state').length !== 1 ||
          !sameState(url.searchParams.get('state'), state)
        )
          return reply(400, 'Invalid sign-in state.');
        if (consumed) return reply(409, 'Callback already received.');
        try {
          await accept(url);
          reply(200, 'Signed in. You can close this tab and return to Industrial Harness.');
          complete(this.view());
        } catch (error) {
          reply(400, 'Sign-in failed. Return to Industrial Harness.');
          fail(safeError(error));
        }
      };
      if (!manualOnly) {
        try {
          server = this.createServer(callback);
          server.requestTimeout = 15000;
          server.headersTimeout = 10000;
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          redirect = `http://127.0.0.1:${server.address().port}/callback`;
        } catch {
          server?.close();
          server = null;
        }
      }
      const authorizationUrl = target =>
        oidc.buildAuthorizationUrl(config, {
          redirect_uri: target,
          response_type: 'code',
          scope: 'openid profile offline_access',
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).href;
      const manualUrl = authorizationUrl(manualRedirect);
      const url = redirect ? authorizationUrl(redirect) : manualUrl;
      this.pending = {
        cancel: () => fail(authError('cancelled')),
        manualUrl,
        loopbackAvailable: Boolean(redirect),
        submit: async value => {
          if (typeof value !== 'string' || value.length > 8192) throw authError('invalid_code');
          const parts = value.trim().split('#');
          if (parts.length !== 2 || !parts[0] || /\s/.test(parts[0]) || !sameState(parts[1], state))
            throw authError('invalid_code');
          const callbackUrl = new URL(manualRedirect);
          callbackUrl.searchParams.set('code', parts[0]);
          callbackUrl.searchParams.set('state', parts[1]);
          if (consumed) throw authError('login_consumed');
          try {
            const view = await accept(callbackUrl);
            complete(view);
            return view;
          } catch (error) {
            fail(safeError(error));
            throw safeError(error);
          }
        },
      };
      timer = setTimeout(() => fail(authError('timeout')), this.loginTimeoutMs);
      if (epoch !== this.epoch) throw authError('cancelled');
      this.changed('signing_in');
      this.emit('authorization', url);
      this.emit('manual-authorization', manualUrl);
      // Browser launch can fail or hang. Neither blocks paste, timeout or cancellation.
      if (epoch === this.epoch && openBrowser)
        Promise.resolve()
          .then(() => openBrowser(url))
          .catch(() => {
            if (epoch === this.epoch && this.state === 'signing_in' && this.pending) {
              this.pending.browserFailed = true;
              this.changed('signing_in');
            }
          });
      const view = await result;
      succeeded = true;
      return view;
    } catch (error) {
      const safe = safeError(error);
      if (epoch === this.epoch) {
        ++this.epoch;
        this.changed(this.user ? 'signed_in' : 'signed_out', safe.message);
      }
      throw safe;
    } finally {
      clearTimeout(timer);
      server?.close();
      // On success allow the browser's response to finish flushing. Cancellation
      // and timeout must close active connections as well as the listener.
      if (!succeeded) server?.closeAllConnections();
      this.pending = null;
      this.starting = false;
    }
  }
  async submitCode(value) {
    if (!this.pending || this.state !== 'signing_in') throw authError('no_pending_login');
    return this.pending.submit(value);
  }
  async openManualLogin(openBrowser) {
    if (!this.pending || this.state !== 'signing_in') throw authError('no_pending_login');
    try {
      await openBrowser(this.pending.manualUrl);
    } catch {
      throw authError('unavailable');
    }
    return this.view();
  }
  session(tokens, user, previous) {
    const expires = Number(tokens.expires_in);
    if (
      !tokens.access_token ||
      !Number.isFinite(expires) ||
      expires <= 0 ||
      tokens.token_type?.toLowerCase() !== 'bearer'
    )
      throw authError('protocol_error');
    return {
      binding: this.identity,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previous?.refreshToken,
      expiresAt: this.now() + expires * 1000,
      user,
      refreshPending: false,
    };
  }
  cancel() {
    ++this.epoch;
    this.pending?.cancel();
    this.changed(this.user ? 'signed_in' : 'signed_out');
  }
  async accessToken({ rejectedToken } = {}) {
    const epoch = this.epoch;
    return this.store.transaction(async tx => {
      if (epoch !== this.epoch) throw authError('cancelled');
      const session = tx.read();
      if (
        !session ||
        session.binding !== this.identity ||
        !session.refreshToken ||
        session.refreshPending
      ) {
        this.user = null;
        this.changed('reauth_required');
        throw authError('login_required');
      }
      if (
        session.expiresAt > this.now() + 60000 &&
        (!rejectedToken || rejectedToken !== session.accessToken)
      ) {
        this.user = session.user;
        return session.accessToken;
      }
      const { oidc, config } = await this.protocol();
      // Persist intent before a rotating refresh. A crash/ambiguous response must
      // never replay a potentially consumed refresh token and revoke its family.
      tx.write({ ...session, refreshPending: true });
      this.changed('refreshing');
      try {
        const tokens = await oidc.refreshTokenGrant(config, session.refreshToken);
        if (
          !tokens.refresh_token ||
          (tokens.claims()?.sub && tokens.claims().sub !== session.user.sub)
        )
          throw authError('protocol_error');
        const next = this.session(tokens, session.user, session);
        tx.write(next);
        // Logout waits for this lock: retain the replacement so it can revoke
        // the current refresh token, without letting the cancelled request use it.
        if (epoch !== this.epoch) throw authError('cancelled');
        this.user = next.user;
        this.changed('signed_in');
        return next.accessToken;
      } catch (error) {
        if (error?.code === 'cancelled') throw error;
        tx.clear();
        this.user = null;
        const safe =
          error?.error === 'invalid_grant'
            ? authError('login_required')
            : authError('refresh_uncertain');
        this.changed('reauth_required', safe.message);
        throw safe;
      }
    });
  }
  async serviceToken(service, target, options) {
    const epoch = this.epoch;
    const expected =
      service === 'remote'
        ? this.config.remoteOrigin
        : service === 'model'
          ? this.config.modelBaseUrl
          : '';
    if (!expected || trustedUrl(target) !== expected || !this.config.audience)
      throw Error('This service is not bound to the platform account.');
    const token = await this.accessToken(options);
    const { config, oidc } = await this.protocol();
    const jose = await import('jose');
    this.jwks ||= jose.createRemoteJWKSet(new URL(config.serverMetadata().jwks_uri), {
      [jose.customFetch]: config[oidc.customFetch],
      timeoutDuration: 15000,
    });
    try {
      const { payload } = await jose.jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        typ: 'at+jwt',
        algorithms: ['RS256'],
        clockTolerance: 30,
      });
      if (epoch !== this.epoch || payload.sub !== this.user?.sub) throw authError('protocol_error');
    } catch {
      throw authError('protocol_error');
    }
    return token;
  }
  async logout() {
    this.cancel();
    await Promise.allSettled([...this.exchanges]);
    let revoked = !this.revocationFailed;
    await this.store.transaction(async tx => {
      try {
        const session = tx.read();
        if (session?.binding === this.identity && session.refreshToken) {
          const { oidc, config } = await this.protocol();
          await oidc.tokenRevocation(config, session.refreshToken, {
            token_type_hint: 'refresh_token',
          });
        }
      } catch {
        revoked = false;
        this.revocationFailed = true;
      } finally {
        tx.clear();
        this.user = null;
        this.changed('signed_out');
      }
    });
    return { ...this.view(), revoked };
  }
  close() {
    this.cancel();
    this.removeAllListeners();
  }
}
module.exports = {
  AuthManager,
  SessionStore,
  authError,
  ...require('./config.cjs'),
  ...require('./store.cjs'),
  createAccountManager: options => {
    const config = validateConfig(options.config);
    return config.services
      ? new (require('./account-manager.cjs').AccountManager)({ ...options, config })
      : new AuthManager({ ...options, config });
  },
};
