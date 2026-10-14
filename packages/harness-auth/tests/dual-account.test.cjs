const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountManager, SessionStore, validateConfig } = require('../src/index.cjs');
const { createIssuer } = require('./issuer.cjs');
const { fetch, createServer } = require('./memory-http.cjs');

async function setup(t, options = {}) {
  const issuer = await createIssuer({
    clients: { 'model-native': 'models', 'remote-native': 'mcp' },
    ...options,
  });
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = {
    ...issuer.config,
    clientId: 'model-native',
    audience: 'models',
    services: {
      model: { clientId: 'model-native', audience: 'models' },
      remote: { clientId: 'remote-native', audience: 'mcp' },
    },
  };
  const make = () =>
    createAccountManager({
      config,
      store: new SessionStore({ directory, allowPlaintext: true }),
      fetch,
      createServer,
    });
  const auth = make();
  t.after(() => auth.close());
  const browser = async url => {
    await fetch(await issuer.authorize(url));
  };
  const expire = service =>
    auth.accounts.get(service).store.transaction(tx => tx.write({ ...tx.read(), expiresAt: 0 }));
  return { auth, issuer, make, browser, expire };
}

test('one account logs into both resources, refreshes independently, restores and revokes both', async t => {
  const { auth, issuer, make, browser, expire } = await setup(t);
  assert.equal((await auth.login({ openBrowser: browser })).status, 'signed_in');
  const { decodeJwt } = await import('jose');
  const model = await auth.serviceToken('model', issuer.config.modelBaseUrl);
  const remote = await auth.serviceToken('remote', issuer.origin);
  assert.equal(decodeJwt(model).aud, 'models');
  assert.equal(decodeJwt(remote).aud, 'mcp');
  assert.equal(decodeJwt(model).sub, decodeJwt(remote).sub);
  assert.ok(!JSON.stringify(auth.view()).includes(model));
  const second = make();
  t.after(() => second.close());
  assert.equal((await second.restore()).status, 'signed_in');
  await expire('remote');
  await Promise.all(
    [auth, second].flatMap(account =>
      Array.from({ length: 4 }, () => account.serviceToken('remote', issuer.origin)),
    ),
  );
  assert.deepEqual(issuer.calls.refreshClients, ['remote-native']);
  await expire('model');
  await auth.serviceToken('model', issuer.config.modelBaseUrl);
  assert.deepEqual(issuer.calls.refreshClients, ['remote-native', 'model-native']);
  assert.equal((await auth.logout()).revoked, true);
  assert.deepEqual(issuer.calls.revokedClients.sort(), ['model-native', 'remote-native']);
  assert.equal((await second.restore()).status, 'signed_out');
  await assert.rejects(second.serviceToken('remote', issuer.origin), /Sign in again/);
});

test('different users across resource authorizations revoke both and expose no account', async t => {
  const { auth, issuer, browser } = await setup(t, { subjects: { 'remote-native': 'other-user' } });
  await assert.rejects(auth.login({ openBrowser: browser }), /verified/);
  assert.equal(auth.view().user, null);
  assert.deepEqual(issuer.calls.revokedClients.sort(), ['model-native', 'remote-native']);
  for (const account of auth.accounts.values()) assert.equal(account.store.read(), null);
});

test('cancelling the second authorization revokes the first and cannot leave half a login', async t => {
  const { auth, issuer, browser } = await setup(t);
  await assert.rejects(
    auth.login({
      openBrowser: async url => {
        if (new URL(url).searchParams.get('client_id') === 'remote-native') auth.cancel();
        else await browser(url);
      },
    }),
    /cancelled/,
  );
  assert.equal(auth.view().user, null);
  assert.deepEqual(issuer.calls.revokedClients, ['model-native']);
});

test('unified logout waits for an in-flight refresh, revokes its replacement and blocks token delivery', async t => {
  const { auth, issuer, browser, expire } = await setup(t);
  await auth.login({ openBrowser: browser });
  await expire('remote');
  let started, release;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  issuer.behavior.beforeRefreshResponse = () => {
    started();
    return new Promise(resolve => {
      release = resolve;
    });
  };
  const refreshing = assert.rejects(auth.serviceToken('remote', issuer.origin), /cancelled/);
  await waiting;
  const logout = auth.logout();
  release();
  await refreshing;
  assert.equal((await logout).revoked, true);
  for (const account of auth.accounts.values()) assert.equal(account.store.read(), null);
  assert.deepEqual(issuer.calls.revokedClients.sort(), ['model-native', 'remote-native']);
});

test('revocation failure in either resource does not prevent local clearing or the other revocation', async t => {
  const { auth, issuer, browser } = await setup(t);
  await auth.login({ openBrowser: browser });
  issuer.behavior.revokeFailure = 'model-native';
  assert.equal((await auth.logout()).revoked, false);
  for (const account of auth.accounts.values()) assert.equal(account.store.read(), null);
  assert.equal(issuer.calls.revokedClients.length, 2);
});

test('existing production registration selects the two registered applications without a UI setting', () => {
  const config = validateConfig({ clientId: 'harness-desktop-1', audience: 'harness-desktop' });
  assert.equal(config.services.model.clientId, 'harness-desktop-1');
  assert.deepEqual(config.services.remote, {
    clientId: 'industrial-agent-harness',
    audience: 'industrial-mcp-remote',
  });
});

test('logout during second code exchange waits for revocation and reports a failed rollback', async t => {
  const { auth, issuer, browser } = await setup(t);
  let exit;
  const login = assert.rejects(
    auth.login({
      openBrowser: async url => {
        if (new URL(url).searchParams.get('client_id') !== 'remote-native') return browser(url);
        issuer.behavior.tokenDelay = 80;
        issuer.behavior.revokeFailure = 'model-native';
        const callback = await issuer.authorize(url);
        const attempt = fetch(callback).catch(() => {});
        // Wait until the authorization code is being redeemed.
        while (issuer.calls.token < 2) await new Promise(resolve => setTimeout(resolve, 5));
        exit = auth.logout();
        await attempt;
      },
    }),
    /cancelled/,
  );
  await login;
  assert.equal((await exit).revoked, false);
  assert.deepEqual(issuer.calls.revokedClients.sort(), ['model-native', 'remote-native']);
  for (const account of auth.accounts.values()) assert.equal(account.store.read(), null);
});

test('corrupt second grant cannot leave the unified account signed in', async t => {
  const { auth, browser } = await setup(t);
  await auth.login({ openBrowser: browser });
  fs.writeFileSync(auth.accounts.get('remote').store.file, '{broken', { mode: 0o600 });
  await assert.rejects(auth.restore());
  assert.equal(auth.view().status, 'reauth_required');
  assert.equal(auth.view().user, null);
  assert.equal((await auth.logout()).revoked, false);
  assert.equal(auth.view().status, 'signed_out');
});
