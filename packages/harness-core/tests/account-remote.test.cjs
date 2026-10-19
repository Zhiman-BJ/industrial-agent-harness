const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteGatewayClient } = require('@industrial-agent-harness/domain-runtime');
const { RemoteSettings } = require('../src/remote-settings.cjs');
test('remote read retries invalid_token once with current credentials; mutations never replay', async () => {
  let calls = 0;
  const tokens = [];
  const client = new RemoteGatewayClient({
    url: 'https://remote.example',
    credentialProvider: async options => (options?.rejectedToken ? 'new-token' : 'old-token'),
    // Provider mode requires an explicit stable key for session isolation.
    credentialKey: 'a'.repeat(64),
    fetch: async (_url, options) => {
      tokens.push(options.headers.Authorization);
      calls++;
      return calls === 1
        ? new Response('{}', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
          })
        : new Response('{}');
    },
  });
  await client.info();
  assert.deepEqual(tokens, ['Bearer old-token', 'Bearer new-token']);
  calls = 0;
  tokens.length = 0;
  await assert.rejects(client.createProject('test'), /401/);
  assert.equal(calls, 1);
});
test('403 is not refreshed and account switches invalidate cached remote clients', async t => {
  let subject = 'first',
    tokenCalls = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = {
    identity: 'issuer-client',
    config: { remoteOrigin: 'https://remote.example' },
    view: () => ({ user: { sub: subject } }),
    serviceToken: async () => {
      tokenCalls++;
      return 'token';
    },
  };
  const settings = new RemoteSettings({
    directory,
    environment: {},
    account,
    fetch: async () => new Response('{}', { status: 403 }),
  });
  const client = settings.client(),
    identity = settings.identity();
  await assert.rejects(client.info(), /403/);
  assert.equal(tokenCalls, 1);
  subject = 'second';
  assert.notEqual(settings.identity(), identity);
  await assert.rejects(client.info(), /project account/);
  assert.equal(tokenCalls, 1);
});

test('remote credential provider uses its resource token and rotates the shared login family', async t => {
  const { AuthManager, SessionStore } = require('../../harness-auth/src/index.cjs');
  const { createIssuer } = require('../../harness-auth/tests/issuer.cjs');
  const { fetch, createServer } = require('../../harness-auth/tests/memory-http.cjs');
  const issuer = await createIssuer();
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-resource-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = new AuthManager({
    config: issuer.config,
    store: new SessionStore({ directory: path.join(directory, 'account'), allowPlaintext: true }),
    fetch,
    createServer,
  });
  t.after(() => account.close());
  await account.login({
    openBrowser: async url => {
      await fetch(await issuer.authorize(url));
    },
  });
  const model = await account.serviceToken('model', issuer.config.modelBaseUrl);
  const headers = [];
  const settings = new RemoteSettings({
    directory,
    environment: {},
    account,
    fetch: async (_url, options) => {
      headers.push(options.headers.Authorization);
      return headers.length === 1
        ? new Response('{}', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
          })
        : new Response('{}');
    },
  });
  const client = settings.client();
  await client.info();
  assert.equal(headers.length, 2);
  assert.notEqual(headers[0], headers[1]);
  for (const header of headers) {
    const payload = JSON.parse(Buffer.from(header.slice(7).split('.')[1], 'base64url'));
    assert.equal(payload.aud, 'industrial-mcp-remote');
    assert.equal(payload.sub, account.view().user.sub);
  }
  assert.equal(await account.serviceToken('model', issuer.config.modelBaseUrl), model);
  assert.equal(issuer.calls.refresh, 3);
  await account.logout();
  await assert.rejects(client.info(), /project account/);
  assert.equal(headers.length, 2);
});

test('token acquisition rejects account switches and logout before sending a request', async t => {
  for (const next of ['second', null]) {
    let subject = 'first';
    let sends = 0;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-token-race-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const account = {
      config: { remoteOrigin: 'https://remote.example' },
      view: () => ({ user: subject ? { sub: subject } : null }),
      serviceToken: async () => {
        subject = next;
        return 'foreign-token';
      },
    };
    const client = new RemoteSettings({
      directory,
      account,
      environment: {},
      fetch: async () => {
        sends++;
        return Response.json({});
      },
    }).client();
    await assert.rejects(client.info(), /project account/);
    assert.equal(sends, 0);
  }
});

test('account switch during invalid_token refresh prevents the retry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-retry-race-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let subject = 'first',
    sends = 0;
  const account = {
    config: { remoteOrigin: 'https://remote.example' },
    view: () => ({ user: { sub: subject } }),
    serviceToken: async (_service, _target, options) => {
      if (options?.rejectedToken) subject = 'second';
      return subject + '-token';
    },
  };
  const client = new RemoteSettings({
    directory,
    account,
    environment: {},
    fetch: async (_url, options) => {
      sends++;
      assert.equal(options.headers.Authorization, 'Bearer first-token');
      return new Response('{}', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      });
    },
  }).client();
  await assert.rejects(client.info(), /project account/);
  assert.equal(sends, 1);
});

test('two AuthManagers sharing a CLI session cannot send the new account token via an old client', async t => {
  const { AuthManager, SessionStore } = require('../../harness-auth/src/index.cjs');
  const { createIssuer } = require('../../harness-auth/tests/issuer.cjs');
  const { fetch, createServer } = require('../../harness-auth/tests/memory-http.cjs');
  const issuer = await createIssuer();
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-shared-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  let subject = 'user-123';
  const transport = async (input, init) => {
    const response = await fetch(input, init);
    const route = new URL(input).pathname;
    if (route === '/userinfo') return Response.json({ sub: subject });
    if (
      route === '/token' &&
      new URLSearchParams(init.body).get('grant_type') === 'authorization_code'
    ) {
      const result = await response.json();
      result.id_token = await issuer.sign(
        { nonce: claims(result.id_token).nonce },
        'harness-native',
        'JWT',
        { subject },
      );
      return Response.json(result);
    }
    return response;
  };
  const manager = () =>
    new AuthManager({
      config: issuer.config,
      createServer,
      fetch: transport,
      store: new SessionStore({ directory: path.join(directory, 'shared'), allowPlaintext: true }),
    });
  const first = manager(),
    second = manager();
  t.after(() => {
    first.close();
    second.close();
  });
  const login = account =>
    account.login({
      openBrowser: async url => {
        await fetch(await issuer.authorize(url));
      },
    });
  await login(first);
  let sends = 0;
  const client = new RemoteSettings({
    directory,
    environment: {},
    account: first,
    fetch: async () => {
      sends++;
      return Response.json({});
    },
  }).client();
  subject = 'second-account';
  await login(second);
  issuer.behavior.transformServiceResponse = async result => {
    result.access_token = await issuer.sign(
      { client_id: 'harness-native' },
      'industrial-mcp-remote',
      'at+jwt',
      { subject },
    );
  };
  assert.equal(first.view().user.sub, 'user-123');
  assert.equal(first.store.read().user.sub, subject);
  await assert.rejects(client.createProject('chip'), /project account/);
  assert.equal(first.view().user.sub, subject);
  assert.equal(sends, 0);
  await assert.rejects(client.info(), /project account/);
  assert.equal(sends, 0);
});
