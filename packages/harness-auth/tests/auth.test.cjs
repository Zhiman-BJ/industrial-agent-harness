const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthManager, SessionStore, validateConfig } = require('../src/index.cjs');
const { createModelProxy } = require('../src/model-proxy.cjs');
const { createIssuer } = require('./issuer.cjs');
const { createServer, fetch } = require('./memory-http.cjs');
const { once } = require('node:events');

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
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
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
const audienceOf = token =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).aud;

test('one sign-in gets a token per service by resource and keeps the rotated refresh token', async t => {
  const { issuer, auth, store, login } = await setup(t);
  await login();
  const own = store.read();
  const model = await auth.serviceToken('model', issuer.config.modelBaseUrl);
  assert.equal(audienceOf(model), 'obol-api');
  assert.deepEqual(issuer.calls.resources, [issuer.config.modelBaseUrl]);
  const after = store.read();
  assert.notEqual(after.refreshToken, own.refreshToken);
  assert.equal(after.accessToken, own.accessToken, "the client's own token is kept");
  // Cached until it nears expiry; the remote service gets a token of its own.
  assert.equal(await auth.serviceToken('model', issuer.config.modelBaseUrl), model);
  const remote = await auth.serviceToken('remote', issuer.config.remoteOrigin);
  assert.equal(audienceOf(remote), 'remote-service');
  assert.equal(issuer.calls.refresh, 2);
  assert.equal(await auth.accessToken(), own.accessToken);
});
test('service tokens refresh near expiry and when the service rejects them', async t => {
  const { issuer, auth, login, expire } = await setup(t);
  await login();
  await auth.serviceToken('model', issuer.config.modelBaseUrl);
  await auth.serviceToken('model', issuer.config.modelBaseUrl);
  assert.equal(issuer.calls.refresh, 1);
  expire();
  const second = await auth.serviceToken('model', issuer.config.modelBaseUrl);
  assert.equal(issuer.calls.refresh, 2);
  await auth.serviceToken('model', issuer.config.modelBaseUrl, { rejectedToken: second });
  assert.equal(issuer.calls.refresh, 3);
});
test('a service the user may not use is refused without signing out', async t => {
  const { issuer, auth, store, login } = await setup(t);
  await login();
  issuer.behavior.deniedResources.add(issuer.config.remoteOrigin);
  const before = store.read();
  await assert.rejects(auth.serviceToken('remote', issuer.config.remoteOrigin), error => {
    assert.equal(error.code, 'service_denied');
    return true;
  });
  assert.equal(auth.view().status, 'signed_in');
  assert.equal(store.read().refreshToken, before.refreshToken);
  assert.equal(store.read().refreshPending, false);
  assert.equal(
    audienceOf(await auth.serviceToken('model', issuer.config.modelBaseUrl)),
    'obol-api',
  );
});
test('access token for a different application is not forwarded', async t => {
  const { issuer, auth, login } = await setup(t);
  await login();
  issuer.behavior.resourceAudience[issuer.config.modelBaseUrl] = 'harness';
  await assert.rejects(auth.serviceToken('model', issuer.config.modelBaseUrl), /verified/);
  assert.equal(issuer.calls.model, 0);
});
test('an unconfigured install signs in to the Zhiman platform and uses its model API', () => {
  assert.deepEqual(validateConfig({}), {
    issuer: 'https://auth.zhiman.cn',
    clientId: 'harness-desktop-1',
    audience: 'harness-desktop',
    remoteOrigin: '',
    remoteAudience: '',
    modelBaseUrl: 'https://api.zhiman.cn/v1',
  });
  // Another platform keeps the registered client, but never borrows Zhiman's model API.
  const local = validateConfig({ issuer: 'http://127.0.0.1:8080' });
  assert.equal(local.clientId, 'harness-desktop-1');
  assert.equal(local.modelBaseUrl, '');
  assert.equal(
    validateConfig({ issuer: 'http://127.0.0.1:8080', modelBaseUrl: 'http://127.0.0.1:8080/v1' })
      .modelBaseUrl,
    'http://127.0.0.1:8080/v1',
  );
});
test('a remote service needs its application audience configured', () => {
  assert.throws(
    () => validateConfig({ clientId: 'harness-native', remoteOrigin: 'https://remote.example' }),
    /audience/,
  );
  assert.equal(
    validateConfig({ clientId: 'harness-native', modelBaseUrl: 'https://api.example/v1' })
      .modelBaseUrl,
    'https://api.example/v1',
  );
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
  assert.equal(audienceOf(issuer.calls.headers[0].slice(7)), 'obol-api');
  assert.ok(!issuer.calls.headers[0].includes(proxy.apiKey));
  // A token the model API rejects is refreshed and the request retried once.
  issuer.behavior.modelRejections = 1;
  const refreshes = issuer.calls.refresh;
  assert.match(await (await request('/chat/completions')).text(), /\[DONE\]/);
  assert.equal(issuer.calls.refresh, refreshes + 1);
  issuer.behavior.modelRejections = 2;
  assert.equal((await request('/chat/completions')).status, 401);
  await auth.logout();
  assert.equal((await request('/chat/completions')).status, 401);
});
test('model proxy explains a model API the account may not use', async t => {
  const { issuer, auth, login } = await setup(t);
  await login();
  const proxy = await createModelProxy({ auth, fetch, createServer });
  t.after(proxy.close);
  issuer.behavior.deniedResources.add(issuer.config.modelBaseUrl);
  const response = await fetch(proxy.endpoint + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + proxy.apiKey },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /cannot use/);
  assert.equal(auth.view().status, 'signed_in');
});
test('unsafe issuer and target substitution are rejected', async t => {
  assert.throws(() => validateConfig({ issuer: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateConfig({ issuer: 'https://user:pass@example.com' }), /HTTPS/);
  const { auth } = await setup(t);
  await assert.rejects(auth.serviceToken('remote', 'https://attacker.test'), /not bound/);
});

async function pastedCode(issuer, url) {
  const callback = new URL(await issuer.authorize(url));
  assert.equal(callback.pathname, '/oauth/code');
  return callback.searchParams.get('code') + '#' + callback.searchParams.get('state');
}
test('manual sign-in uses issuer code redirect, PKCE and nonce without a listener', async t => {
  const { issuer, auth, store } = await setup(t, {
    createServer: () => {
      throw Error('Manual login must not listen.');
    },
  });
  const ready = once(auth, 'manual-authorization');
  const login = auth.login({ manualOnly: true });
  const [url] = await ready;
  assert.equal(auth.view().login.loopbackAvailable, false);
  await auth.submitCode(await pastedCode(issuer, url));
  assert.equal((await login).user.sub, 'user-123');
  assert.equal(issuer.calls.token, 1);
  assert.ok(store.read().refreshToken);
  assert.equal(auth.view().login, null);
});
test('malformed and mismatched paste states do not consume a pending login', async t => {
  const { issuer, auth } = await setup(t);
  await assert.rejects(auth.submitCode('code#state'), /Start sign-in/);
  const ready = once(auth, 'manual-authorization');
  const login = auth.login({ manualOnly: true });
  const [url] = await ready;
  const code = await pastedCode(issuer, url);
  for (const invalid of [null, {}, 'code', 'code#wrong', code + '#extra', 'x'.repeat(8193)])
    await assert.rejects(auth.submitCode(invalid), /complete code#state/);
  assert.equal(issuer.calls.token, 0);
  await auth.submitCode('  ' + code + '\n');
  await login;
  await assert.rejects(auth.submitCode(code), /Start sign-in/);
});
test('a pasted code from a cancelled attempt cannot sign into the next attempt', async t => {
  const { issuer, auth } = await setup(t);
  const firstReady = once(auth, 'manual-authorization');
  const first = assert.rejects(auth.login({ manualOnly: true }), /cancelled/);
  const oldCode = await pastedCode(issuer, (await firstReady)[0]);
  auth.cancel();
  await first;
  const nextReady = once(auth, 'manual-authorization');
  const next = auth.login({ manualOnly: true });
  const code = await pastedCode(issuer, (await nextReady)[0]);
  await assert.rejects(auth.submitCode(oldCode), /complete code#state/);
  await auth.submitCode(code);
  await next;
  assert.equal(issuer.calls.token, 1);
});
test('unavailable loopback falls back to code paste', async t => {
  const { issuer, auth } = await setup(t, {
    createServer: () => {
      const server = new (require('node:events').EventEmitter)();
      server.listen = () =>
        queueMicrotask(() =>
          server.emit('error', Object.assign(Error('Denied'), { code: 'EPERM' })),
        );
      server.close = () => {};
      return server;
    },
  });
  const ready = once(auth, 'manual-authorization');
  const login = auth.login();
  const [url] = await ready;
  assert.equal(auth.view().login.loopbackAvailable, false);
  await auth.submitCode(await pastedCode(issuer, url));
  assert.equal((await login).status, 'signed_in');
});
test('failed browser launch still permits manual sign-in', async t => {
  const { issuer, auth } = await setup(t);
  const ready = once(auth, 'manual-authorization');
  const failed = new Promise(resolve =>
    auth.on('change', view => {
      if (view.login?.browserFailed) resolve();
    }),
  );
  const login = auth.login({
    openBrowser: () => {
      throw Error('Cannot launch browser');
    },
  });
  const [url] = await ready;
  await failed;
  let opened;
  await auth.openManualLogin(async value => {
    opened = value;
  });
  assert.equal(opened, url);
  await auth.submitCode(await pastedCode(issuer, url));
  await login;
});
test('hung browser launch does not block timeout', async t => {
  const { auth, store } = await setup(t, { loginTimeoutMs: 40 });
  await assert.rejects(auth.login({ openBrowser: () => new Promise(() => {}) }), /timed out/);
  assert.equal(store.read(), null);
  assert.equal(auth.view().login, null);
});
test('loopback and pasted code racing exchange only one authorization code', async t => {
  const { issuer, auth } = await setup(t);
  issuer.behavior.tokenDelay = 80;
  const automaticReady = once(auth, 'authorization');
  const manualReady = once(auth, 'manual-authorization');
  const login = auth.login();
  const automatic = await issuer.authorize((await automaticReady)[0]);
  const code = await pastedCode(issuer, (await manualReady)[0]);
  const manual = auth.submitCode(code);
  assert.equal((await fetch(automatic)).status, 409);
  await Promise.all([manual, login]);
  assert.equal(issuer.calls.token, 1);
});
test('logout during pasted code exchange revokes the late session', async t => {
  const { issuer, auth, store } = await setup(t);
  issuer.behavior.tokenDelay = 80;
  const ready = once(auth, 'manual-authorization');
  const login = assert.rejects(auth.login({ manualOnly: true }), /cancelled/);
  const code = await pastedCode(issuer, (await ready)[0]);
  const submit = assert.rejects(auth.submitCode(code), /cancelled/);
  await auth.logout();
  await Promise.all([login, submit]);
  assert.equal(store.read(), null);
  assert.equal(auth.view().user, null);
  assert.equal(issuer.calls.revoke, 1);
});
