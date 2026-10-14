const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthManager, SessionStore, validateConfig } = require('../src/index.cjs');
const { createModelProxy } = require('../src/model-proxy.cjs');
const { createIssuer } = require('./issuer.cjs');
const { createServer, fetch } = require('./memory-http.cjs');

async function setup(t, options = {}) {
  const issuer = await createIssuer();
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = Date.now();
  const store = new SessionStore({ directory, allowPlaintext: true });
  const auth = new AuthManager({
    config: issuer.config,
    store,
    fetch,
    createServer,
    now: () => clock,
    ...options,
  });
  t.after(() => auth.close());
  const login = () =>
    auth.login({
      openBrowser: async url => {
        const callback = await issuer.authorize(url);
        assert.equal((await fetch(callback)).status, 200);
      },
    });
  return {
    issuer,
    auth,
    store,
    directory,
    login,
    expire: () => {
      clock += 850000;
    },
  };
}
test('real discovery → PKCE loopback → signed ID token → userinfo → rotated refresh → revocation', async t => {
  const { issuer, auth, store, login, expire } = await setup(t);
  const view = await login();
  assert.equal(view.user.sub, 'user-123');
  assert.equal(view.user.name, '138****1234');
  assert.equal(view.status, 'signed_in');
  const before = store.read();
  assert.ok(before.refreshToken);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(view).includes(before.accessToken));
  expire();
  await Promise.all(Array.from({ length: 12 }, () => auth.accessToken()));
  assert.equal(issuer.calls.refresh, 1);
  assert.notEqual(store.read().refreshToken, before.refreshToken);
  assert.equal((await auth.logout()).revoked, true);
  assert.equal(issuer.calls.revoke, 1);
  assert.equal(store.read(), null);
});
test('independent clients serialize refresh and re-read rotated credentials', async t => {
  const { issuer, auth, store, login, expire } = await setup(t);
  await login();
  expire();
  const second = new AuthManager({
    config: issuer.config,
    store: new SessionStore({ directory: store.directory, allowPlaintext: true }),
    fetch,
    createServer,
    now: auth.now,
  });
  t.after(() => second.close());
  const tokens = await Promise.all([auth.accessToken(), second.accessToken()]);
  assert.equal(tokens[0], tokens[1]);
  assert.equal(issuer.calls.refresh, 1);
});
test('logout during refresh revokes the replacement and rejects queued token requests', async t => {
  const { issuer, auth, store, login, expire } = await setup(t);
  await login();
  const previous = store.read().refreshToken;
  expire();
  let release, started;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  issuer.behavior.beforeRefreshResponse = () => {
    started();
    return new Promise(resolve => {
      release = resolve;
    });
  };
  const refresh = assert.rejects(auth.accessToken(), /cancelled/);
  await waiting;
  const queued = assert.rejects(auth.accessToken(), /cancelled/);
  const logout = auth.logout();
  release();
  await Promise.all([refresh, queued]);
  assert.equal((await logout).revoked, true);
  assert.equal(issuer.calls.refresh, 1);
  assert.equal(issuer.calls.revokedTokens.length, 1);
  assert.notEqual(issuer.calls.revokedTokens[0], previous);
  assert.equal(store.read(), null);
  assert.equal(auth.view().status, 'signed_out');
});
test('wrong state does not consume callback; valid state succeeds only once', async t => {
  const { issuer, auth } = await setup(t);
  await auth.login({
    openBrowser: async url => {
      const callback = new URL(await issuer.authorize(url));
      const wrong = new URL(callback);
      wrong.searchParams.set('state', '中'.repeat(callback.searchParams.get('state').length));
      assert.equal((await fetch(wrong)).status, 400);
      assert.equal(issuer.calls.token, 0);
      assert.equal((await fetch(callback)).status, 200);
    },
  });
  assert.equal(issuer.calls.token, 1);
});
for (const field of ['badNonce', 'badAudience', 'badSignature'])
  test(`rejects signed ID token with ${field}`, async t => {
    const { issuer, auth, store } = await setup(t);
    issuer.behavior[field] = true;
    await assert.rejects(
      auth.login({
        openBrowser: async url => {
          await fetch(await issuer.authorize(url));
        },
      }),
      /verified/,
    );
    assert.equal(store.read(), null);
    assert.equal(auth.view().user, null);
  });
test('invalid_grant and ambiguous refresh require sign-in; no token replay', async t => {
  const { issuer, auth, store, login, expire } = await setup(t);
  await login();
  expire();
  issuer.behavior.lostRefresh = true;
  await assert.rejects(auth.accessToken(), /could not be confirmed/);
  await assert.rejects(auth.accessToken(), /Sign in again/);
  assert.equal(issuer.calls.refresh, 1);
  assert.equal(store.read(), null);
});
test('crash marker prevents replay of a refresh token', async t => {
  const { issuer, auth, store, login } = await setup(t);
  await login();
  await store.transaction(tx => tx.write({ ...tx.read(), refreshPending: true }));
  await assert.rejects(auth.accessToken(), /Sign in again/);
  assert.equal(issuer.calls.refresh, 0);
});
test('revoked refresh token clears credentials and requires a new login', async t => {
  const { issuer, auth, store, login, expire } = await setup(t);
  await login();
  expire();
  issuer.behavior.invalidGrant = true;
  await assert.rejects(auth.accessToken(), /Sign in again/);
  assert.equal(store.read(), null);
  assert.equal(auth.view().status, 'reauth_required');
});
test('access token for a different application is not forwarded', async t => {
  const { issuer, auth, login } = await setup(t);
  await login();
  auth.config.audience = 'different-application';
  await assert.rejects(auth.serviceToken('model', issuer.config.modelBaseUrl), /verified/);
  assert.equal(issuer.calls.model, 0);
});
test('cancel and timeout close the listener and do not retain credentials', async t => {
  const { issuer, auth, store } = await setup(t, { loginTimeoutMs: 40 });
  let callback;
  await assert.rejects(
    auth.login({
      openBrowser: async url => {
        callback = await issuer.authorize(url);
      },
    }),
    /timed out/,
  );
  await assert.rejects(fetch(callback));
  assert.equal(store.read(), null);
  const pending = auth.login({ openBrowser: async () => auth.cancel() });
  await assert.rejects(pending, /cancelled/);
});
test('late callback exchange cannot restore credentials after cancellation', async t => {
  const { issuer, auth, store } = await setup(t);
  issuer.behavior.tokenDelay = 150;
  let callbackDone;
  const login = auth.login({
    openBrowser: async url => {
      callbackDone = fetch(await issuer.authorize(url)).catch(() => {});
      setTimeout(() => auth.cancel(), 30);
    },
  });
  await assert.rejects(login, /cancelled/);
  await callbackDone;
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(store.read(), null);
  assert.equal(auth.view().user, null);
});
test('loopback model proxy forwards streams with current service token and denies other origins/routes', async t => {
  const { issuer, auth, login, expire } = await setup(t);
  await login();
  const proxy = await createModelProxy({ auth, fetch, createServer });
  t.after(proxy.close);
  const request = (suffix, headers = {}) =>
    fetch(proxy.endpoint + suffix, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + proxy.apiKey, ...headers },
      body: '{}',
    });
  assert.equal(
    (await request('/chat/completions', { origin: 'https://attacker.test' })).status,
    401,
  );
  assert.equal((await request('/other')).status, 404);
  expire();
  const response = await request('/chat/completions');
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(issuer.calls.refresh, 1);
  assert.ok(issuer.calls.headers[0].startsWith('Bearer ey'));
  assert.ok(!issuer.calls.headers[0].includes(proxy.apiKey));
  await auth.logout();
  assert.equal((await request('/chat/completions')).status, 401);
});
test('unsafe issuer and target substitution are rejected', async t => {
  assert.throws(() => validateConfig({ issuer: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateConfig({ issuer: 'https://user:pass@example.com' }), /HTTPS/);
  const { auth } = await setup(t);
  await assert.rejects(auth.serviceToken('remote', 'https://attacker.test'), /not bound/);
});
