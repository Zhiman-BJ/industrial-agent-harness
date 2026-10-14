const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteClient } = require('@industrial-agent-harness/domain-runtime');
const { RemoteSettings } = require('../src/remote-settings.cjs');
test('remote read retries invalid_token once with current credentials; mutations never replay', async () => {
  let calls = 0;
  const tokens = [];
  const client = new RemoteClient({
    url: 'https://remote.example',
    credentialProvider: async options => (options?.rejectedToken ? 'new-token' : 'old-token'),
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
