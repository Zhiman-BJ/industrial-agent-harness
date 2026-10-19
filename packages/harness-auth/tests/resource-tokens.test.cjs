const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { AuthManager, SessionStore } = require('../src/index.cjs');
const { createModelProxy } = require('../src/model-proxy.cjs');
const { createIssuer } = require('./issuer.cjs');
const { createServer, fetch } = require('./memory-http.cjs');
const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

async function setup(t) {
  const issuer = await createIssuer();
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-resources-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const manager = (config = issuer.config) => {
    const auth = new AuthManager({
      config,
      store: new SessionStore({ directory, allowPlaintext: true }),
      fetch,
      createServer,
    });
    t.after(() => auth.close());
    return auth;
  };
  const auth = manager();
  const login = () =>
    auth.login({
      openBrowser: async url => {
        await fetch(await issuer.authorize(url));
      },
    });
  const token = (service, options, instance = auth) =>
    instance.serviceToken(
      service,
      service === 'model' ? issuer.config.modelBaseUrl : issuer.config.remoteOrigin,
      options,
    );
  const proxy = async () => {
    const p = await createModelProxy({ auth, fetch, createServer });
    t.after(p.close);
    return async (route = 'chat/completions') =>
      fetch(p.endpoint + '/' + route, {
        method: route === 'models' ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + p.apiKey },
        ...(route === 'models' ? {} : { body: '{"model":"test","stream":true}' }),
      });
  };
  return { issuer, auth, manager, login, token, proxy };
}

test('one login lazily obtains two audience-bound tokens and one refresh family', async t => {
  const { issuer, auth, login, token } = await setup(t);
  await login();
  const original = auth.store.read();
  assert.equal(issuer.calls.token, 1);
  assert.ok(issuer.calls.authorizations.every(a => !a.resource));
  const model = await token('model');
  const afterModel = auth.store.read();
  const remote = await token('remote');
  const afterRemote = auth.store.read();
  assert.equal(claims(model).aud, 'obol-api');
  assert.equal(claims(remote).aud, 'industrial-mcp-remote');
  assert.deepEqual(issuer.calls.resources, [
    issuer.config.modelBaseUrl,
    issuer.config.remoteOrigin,
  ]);
  assert.deepEqual(issuer.calls.refreshInputs, [original.refreshToken, afterModel.refreshToken]);
  assert.notEqual(afterRemote.refreshToken, afterModel.refreshToken);
  assert.equal(await token('model'), model);
  assert.equal(await token('remote'), remote);
  assert.equal(await auth.accessToken(), original.accessToken);
  assert.equal(issuer.calls.refresh, 2);
  assert.ok(!JSON.stringify(auth.view()).includes(model));
  assert.equal((await auth.logout()).revoked, true);
  assert.deepEqual(issuer.calls.revokedTokens, [afterRemote.refreshToken]);
  assert.equal(auth.store.read(), null);
  await assert.rejects(token('model'), { code: 'login_required' });
  await assert.rejects(token('remote'), { code: 'login_required' });
});

test('concurrent resources and independent managers serialize one rotating family', async t => {
  const { issuer, auth, manager, login, token } = await setup(t);
  await login();
  const second = manager();
  await second.restore();
  const requests = Array.from({ length: 12 }, (_, i) =>
    token(i % 2 ? 'model' : 'remote', {}, i % 3 ? auth : second),
  );
  const results = await Promise.all(requests);
  assert.equal(new Set(results).size, 2);
  assert.equal(issuer.calls.refresh, 2);
  assert.equal(new Set(issuer.calls.refreshInputs).size, 2);
  const oldModel = await token('model');
  const renewed = await Promise.all([
    token('model', { rejectedToken: oldModel }),
    token('model', { rejectedToken: oldModel }, second),
  ]);
  assert.equal(renewed[0], renewed[1]);
  assert.notEqual(renewed[0], oldModel);
  assert.equal(issuer.calls.refresh, 3);
});

test('login-token refresh and service expiry preserve other service caches', async t => {
  const { issuer, auth, login, token } = await setup(t);
  await login();
  const model = await token('model');
  const remote = await token('remote');
  await auth.accessToken({ rejectedToken: auth.store.read().accessToken });
  assert.equal(await token('model'), model);
  assert.equal(await token('remote'), remote);
  await auth.store.transaction(tx => {
    const s = tx.read();
    s.services[issuer.config.modelBaseUrl].expiresAt = Date.now();
    tx.write(s);
  });
  assert.notEqual(await token('model'), model);
  assert.equal(await token('remote'), remote);
  assert.equal(issuer.calls.refresh, 4);
});

test('legacy session gains resource caches without a second sign-in', async t => {
  const { issuer, auth, manager, login, token } = await setup(t);
  await login();
  await auth.store.transaction(tx => {
    const s = tx.read();
    delete s.services;
    const legacyConfig = { ...auth.config };
    delete legacyConfig.remoteAudience;
    s.binding = crypto.createHash('sha256').update(JSON.stringify(legacyConfig)).digest('hex');
    tx.write(s);
  });
  const next = manager();
  assert.equal((await next.restore()).status, 'signed_in');
  assert.equal(claims(await token('model', {}, next)).aud, 'obol-api');
  assert.equal(issuer.calls.authorizations.length, 1);
});

test('service denial preserves login, other cache and unconsumed refresh token', async t => {
  const { issuer, auth, login, token } = await setup(t);
  await login();
  const model = await token('model');
  const remote = await token('remote');
  const before = auth.store.read().refreshToken;
  issuer.behavior.deniedResources.add(issuer.config.remoteOrigin);
  await assert.rejects(token('remote', { rejectedToken: remote }), { code: 'service_denied' });
  assert.equal(auth.view().status, 'signed_in');
  assert.equal(auth.store.read().refreshToken, before);
  assert.equal(auth.store.read().refreshPending, false);
  assert.equal(auth.store.read().services[issuer.config.remoteOrigin], undefined);
  assert.equal(await token('model'), model);
  await assert.rejects(token('remote'), { code: 'service_denied' });
  issuer.behavior.deniedResources.clear();
  assert.notEqual(await token('remote'), remote);
});

test('invalid grant or ambiguous rotation clears every cached resource without replay', async t => {
  for (const failure of ['invalidGrant', 'lostRefresh']) {
    await t.test(failure, async t => {
      const { issuer, auth, login, token } = await setup(t);
      await login();
      const model = await token('model');
      await token('remote');
      issuer.behavior[failure] = true;
      await assert.rejects(token('model', { rejectedToken: model }));
      const refreshes = issuer.calls.refresh;
      assert.equal(auth.store.read(), null);
      assert.equal(auth.view().status, 'reauth_required');
      await assert.rejects(token('remote'), { code: 'login_required' });
      assert.equal(issuer.calls.refresh, refreshes);
    });
  }
});

for (const denied of [false, true])
  test(`logout during ${denied ? 'denied' : 'successful'} resource refresh waits and clears caches`, async t => {
    const { issuer, auth, login, token } = await setup(t);
    await login();
    const model = await token('model');
    const before = auth.store.read().refreshToken;
    const entered = deferred(),
      release = deferred();
    issuer.behavior[denied ? 'beforeDeniedResponse' : 'beforeRefreshResponse'] = () => {
      entered.resolve();
      return release.promise;
    };
    if (denied) issuer.behavior.deniedResources.add(issuer.config.modelBaseUrl);
    const request = assert.rejects(token('model', { rejectedToken: model }), { code: 'cancelled' });
    await entered.promise;
    const queued = assert.rejects(token('remote'), { code: 'cancelled' });
    let complete = false;
    const logout = auth.logout().then(result => {
      complete = true;
      return result;
    });
    await new Promise(r => setImmediate(r));
    assert.equal(complete, false);
    release.resolve();
    await Promise.all([request, queued]);
    assert.equal((await logout).revoked, true);
    assert.equal(auth.store.read(), null);
    assert.equal(auth.view().status, 'signed_out');
    assert.equal(issuer.calls.revokedTokens.length, 1);
    assert.equal(issuer.calls.revokedTokens[0] === before, denied);
  });

test('logout waits for late code exchange and reports revocation failure', async t => {
  const { issuer, auth } = await setup(t);
  issuer.behavior.tokenDelay = 60;
  issuer.behavior.revokeFailure = true;
  const ready = once(auth, 'manual-authorization');
  const login = assert.rejects(auth.login({ manualOnly: true }), { code: 'cancelled' });
  const callback = new URL(await issuer.authorize((await ready)[0]));
  const submit = assert.rejects(
    auth.submitCode(callback.searchParams.get('code') + '#' + callback.searchParams.get('state')),
    { code: 'cancelled' },
  );
  const result = await auth.logout();
  await Promise.all([login, submit]);
  assert.equal(result.revoked, false);
  assert.equal(issuer.calls.revoke, 1);
  assert.equal(auth.store.read(), null);
});

for (const invalid of ['audience', 'multiple audiences', 'subject', 'client', 'type', 'expired'])
  test(`rejects service token with wrong ${invalid} before caching or forwarding`, async t => {
    const { issuer, auth, login, token } = await setup(t);
    await login();
    issuer.behavior.transformServiceResponse = async result => {
      result.access_token = await issuer.sign(
        { client_id: invalid === 'client' ? 'other-client' : 'harness-native' },
        invalid === 'audience'
          ? 'harness'
          : invalid === 'multiple audiences'
            ? ['obol-api', 'industrial-mcp-remote']
            : 'obol-api',
        invalid === 'type' ? 'JWT' : 'at+jwt',
        {
          subject: invalid === 'subject' ? 'other-user' : 'user-123',
          expiry: invalid === 'expired' ? '1 minute ago' : '15m',
        },
      );
    };
    await assert.rejects(token('model'), { code: 'protocol_error' });
    assert.equal(auth.store.read(), null);
    assert.equal(issuer.calls.model, 0);
    assert.equal(issuer.calls.revoke, 1);
  });

test('changing remote audience cannot reuse a previously cached token', async t => {
  const { issuer, manager, login, token } = await setup(t);
  await login();
  await token('remote');
  const other = manager({ ...issuer.config, remoteAudience: 'other-remote' });
  await other.restore();
  await assert.rejects(token('remote', {}, other), { code: 'protocol_error' });
  assert.equal(issuer.calls.refresh, 2);
});

for (const route of ['chat/completions', 'messages', 'models'])
  test(`model proxy retries ${route} once on explicit invalid_token`, async t => {
    const { issuer, login, proxy } = await setup(t);
    await login();
    const request = await proxy();
    issuer.behavior.modelResponses.push({
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    });
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /DONE/);
    assert.equal(issuer.calls.refresh, 2);
    assert.notEqual(issuer.calls.headers[0], issuer.calls.headers[1]);
    assert.equal(issuer.calls.bodies[0], issuer.calls.bodies[1]);
    issuer.behavior.modelResponses.push(
      ...Array.from({ length: 2 }, () => ({
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      })),
    );
    const failed = await request(route);
    assert.equal(failed.status, 401);
    assert.equal(issuer.calls.model, 4);
    assert.ok(!(await failed.text()).includes('private upstream'));
  });

for (const status of [401, 402, 403, 429, 500])
  test(`model proxy sanitizes ${status} and does not refresh or replay`, async t => {
    const { issuer, login, proxy } = await setup(t);
    await login();
    const request = await proxy();
    issuer.behavior.modelResponses.push({ status, headers: { 'retry-after': '12' } });
    const response = await request();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '12');
    const body = await response.text();
    assert.ok(!body.includes('private upstream'));
    if (status === 402) assert.match(body, /balance/);
    if (status === 403) assert.match(body, /cannot use/);
    if (status === 429) assert.match(body, /limit/);
    assert.equal(issuer.calls.model, 1);
    assert.equal(issuer.calls.refresh, 1);
  });

test('model proxy refuses a denied service without signing out or calling inference', async t => {
  const { issuer, auth, login, proxy } = await setup(t);
  issuer.behavior.deniedResources.add(issuer.config.modelBaseUrl);
  await login();
  const request = await proxy();
  const response = await request();
  assert.equal(response.status, 403);
  assert.match(await response.text(), /cannot use/);
  assert.equal(auth.view().status, 'signed_in');
  assert.equal(issuer.calls.model, 0);
});

test('model proxy never replays an ambiguous disconnected generation', async t => {
  const { issuer, login, proxy } = await setup(t);
  await login();
  const request = await proxy();
  issuer.behavior.modelResponses.push({ disconnect: true });
  assert.equal((await request()).status, 503);
  assert.equal(issuer.calls.model, 1);
  assert.equal(issuer.calls.refresh, 1);
});

test('native registration with matching service audience uses and refreshes its login token without resource exchange', async t => {
  const { issuer, manager } = await setup(t);
  const auth = manager({ ...issuer.config, remoteAudience: issuer.config.audience });
  await auth.login({
    openBrowser: async url => {
      await fetch(await issuer.authorize(url));
    },
  });
  const first = await auth.serviceToken('remote', issuer.config.remoteOrigin);
  assert.equal(claims(first).aud, issuer.config.audience);
  assert.equal(issuer.calls.refresh, 0);
  const second = await auth.serviceToken('remote', issuer.config.remoteOrigin, {
    rejectedToken: first,
  });
  assert.notEqual(second, first);
  assert.equal(issuer.calls.refresh, 1);
  assert.deepEqual(issuer.calls.resources, [null]);
  await assert.rejects(auth.serviceToken('remote', 'https://unbound.example'), /not bound/);
});
