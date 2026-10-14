const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAccount, createCliAccount } = require('../src/account.cjs');
const { PassThrough } = require('node:stream');
const { AuthManager, SessionStore } = require('@industrial-agent-harness/harness-auth');
const { createIssuer } = require('@industrial-agent-harness/harness-auth/tests/issuer.cjs');
const {
  fetch,
  createServer,
} = require('@industrial-agent-harness/harness-auth/tests/memory-http.cjs');
test('account CLI prints safe status and file persistence requires opt-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = {
    INDUSTRIAL_HARNESS_CONFIG_DIR: directory,
    INDUSTRIAL_AUTH_CLIENT_ID: 'harness-cli',
  };
  let output = '';
  await runAccount(
    ['status'],
    {
      write: value => {
        output += value;
      },
    },
    environment,
  );
  assert.equal(JSON.parse(output).persistent, false);
  assert.equal(JSON.parse(output).status, 'signed_out');
  const memory = createCliAccount(environment);
  assert.equal(memory.store.persistent(), false);
  memory.close();
  const file = createCliAccount(environment, true);
  assert.equal(file.store.persistent(), true);
  file.close();
  assert.ok(!/accessToken|refreshToken/.test(output));
});
test('CLI logout clears a corrupt opted-in session and reports failed server revocation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-account-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storeDirectory = path.join(directory, 'account', 'cli');
  fs.mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(storeDirectory, 'session.json');
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  let output = '';
  await runAccount(
    ['logout', '--allow-file-store'],
    {
      write: value => {
        output += value;
      },
    },
    {
      INDUSTRIAL_HARNESS_CONFIG_DIR: directory,
      INDUSTRIAL_AUTH_CLIENT_ID: 'harness-cli',
    },
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.parse(output).status, 'signed_out');
  assert.equal(JSON.parse(output).revoked, false);
});

for (const mode of ['no-browser', 'ssh'])
  test(`CLI ${mode} completes signed OIDC login from stdin without leaking codes or tokens`, async t => {
    const issuer = await createIssuer();
    t.after(issuer.close);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-manual-login-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new SessionStore({ directory, allowPlaintext: true });
    const auth = new AuthManager({
      config: issuer.config,
      store,
      fetch,
      loginTimeoutMs: 3000,
      createServer: () => {
        throw Error('Headless login must not open a listener');
      },
    });
    const input = new PassThrough();
    t.after(() => input.destroy());
    const events = [];
    let code;
    const authorized = new Promise((resolve, reject) => {
      auth.once('manual-authorization', async url => {
        try {
          const callback = new URL(await issuer.authorize(url));
          code = callback.searchParams.get('code') + '#' + callback.searchParams.get('state');
          input.write(code + '\n');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await Promise.all([
      runAccount(
        ['login', '--allow-file-store', ...(mode === 'no-browser' ? ['--no-browser'] : [])],
        { write: line => events.push(JSON.parse(line)) },
        mode === 'ssh' ? { SSH_CONNECTION: 'test' } : {},
        {
          auth,
          input,
          openBrowser: () => {
            throw Error('Must not launch browser');
          },
        },
      ),
      authorized,
    ]);
    assert.equal(events.at(-1).status, 'signed_in');
    assert.equal(events.filter(event => event.type === 'account_authorization').length, 1);
    assert.equal(events[0].callback, 'paste-code');
    const text = JSON.stringify(events);
    assert.ok(!text.includes(code));
    assert.ok(!text.includes(store.read().refreshToken));
    assert.ok(!text.includes(store.read().accessToken));
    assert.equal(input.listenerCount('data'), 0);
  });

test('CLI manual login cancels cleanly when stdin closes', async t => {
  const issuer = await createIssuer();
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-login-eof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = new AuthManager({
    config: issuer.config,
    store: new SessionStore({ directory }),
    fetch,
    createServer,
  });
  const input = new PassThrough();
  auth.once('manual-authorization', () => queueMicrotask(() => input.end()));
  await assert.rejects(
    runAccount(['login', '--no-browser'], { write: () => {} }, {}, { auth, input }),
    /cancelled/,
  );
  assert.equal(auth.view().user, null);
});

test('CLI completes both grants through one stdin reader and emits one account', async t => {
  const { createAccountManager } = require('@industrial-agent-harness/harness-auth');
  const issuer = await createIssuer({ clients: { first: 'models', second: 'mcp' } });
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dual-login-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = createAccountManager({
    config: {
      ...issuer.config,
      clientId: 'first',
      audience: 'models',
      services: {
        model: { clientId: 'first', audience: 'models' },
        remote: { clientId: 'second', audience: 'mcp' },
      },
    },
    store: new SessionStore({ directory }),
    fetch,
    createServer,
  });
  const input = new PassThrough();
  t.after(() => input.destroy());
  const events = [];
  const authorize = [];
  auth.on('manual-authorization', url => {
    authorize.push(
      issuer.authorize(url).then(callback => {
        const parsed = new URL(callback);
        input.write(
          parsed.searchParams.get('code') + '#' + parsed.searchParams.get('state') + '\n',
        );
      }),
    );
  });
  await runAccount(
    ['login', '--no-browser'],
    { write: line => events.push(JSON.parse(line)) },
    {},
    { auth, input },
  );
  await Promise.all(authorize);
  assert.equal(events.filter(event => event.type === 'account').length, 1);
  assert.equal(events.at(-1).status, 'signed_in');
  assert.equal(issuer.calls.token, 2);
  assert.equal(input.listenerCount('data'), 0);
  for (const account of auth.accounts.values()) {
    const session = account.store.read();
    assert.ok(!JSON.stringify(events).includes(session.refreshToken));
  }
  await auth.logout();
  assert.deepEqual(issuer.calls.revokedClients.sort(), ['first', 'second']);
});
