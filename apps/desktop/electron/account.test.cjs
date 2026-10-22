const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DesktopAccount, registerAccountHandlers } = require('./account.cjs');
const { DEFAULT_ACCOUNT_CONFIG } = require('./account-defaults.cjs');
const { readConfig, validateConfig } = require('@industrial-agent-harness/harness-auth');
test('account IPC denies guest frames and never exposes a token method', async () => {
  const handlers = new Map(),
    mainFrame = {},
    webContents = { mainFrame };
  const view = { status: 'signed_out', user: null };
  registerAccountHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getWindow: () => ({ webContents }),
    account: { view: () => view },
  });
  assert.throws(
    () => handlers.get('account:get')({ sender: {}, senderFrame: {} }),
    /main application/,
  );
  assert.throws(
    () => handlers.get('account:get')({ sender: webContents, senderFrame: {} }),
    /main application/,
  );
  assert.deepEqual(
    handlers.get('account:get')({ sender: webContents, senderFrame: mainFrame }),
    view,
  );
  assert.ok([...handlers.keys()].every(name => !/token|credential/.test(name)));
  assert.equal(handlers.has('account:configure'), false);
  for (const name of ['account:open-manual', 'account:submit-code'])
    assert.throws(
      () => handlers.get(name)({ sender: webContents, senderFrame: {} }, 'code#state'),
      /main application/,
    );
});

test('desktop main-window IPC completes manual login with encrypted storage and safe views', async t => {
  const { createIssuer } = require('@industrial-agent-harness/harness-auth/tests/issuer.cjs');
  const {
    fetch,
    createServer,
  } = require('@industrial-agent-harness/harness-auth/tests/memory-http.cjs');
  const issuer = await createIssuer();
  t.after(issuer.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-manual-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(issuer.config));
  const opened = [],
    views = [];
  const account = new DesktopAccount({
    directory,
    environment: {},
    shell: {
      openExternal: async url => {
        opened.push(url);
      },
    },
    onChange: view => views.push(view),
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'test',
      encryptString: value => Buffer.from(value).map(byte => byte ^ 0xa5),
      decryptString: value =>
        Buffer.from(value)
          .map(byte => byte ^ 0xa5)
          .toString(),
    },
  });
  t.after(() => account.close());
  account.auth.fetch = fetch;
  account.auth.createServer = createServer;
  const handlers = new Map(),
    mainFrame = {},
    webContents = { mainFrame };
  registerAccountHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getWindow: () => ({ webContents }),
    account,
  });
  const call = (name, value) =>
    handlers.get('account:' + name)({ sender: webContents, senderFrame: mainFrame }, value);
  const ready = require('node:events').once(account.auth, 'manual-authorization');
  const login = call('login');
  await ready;
  await call('open-manual');
  const callback = new URL(await issuer.authorize(opened.at(-1)));
  assert.equal(callback.pathname, '/oauth/code');
  await assert.rejects(call('submit-code', 'invalid'), /complete code#state/);
  const code = callback.searchParams.get('code') + '#' + callback.searchParams.get('state');
  const view = await call('submit-code', code);
  await login;
  assert.equal(view.status, 'signed_in');
  assert.equal(view.persistent, true);
  await call('use-model', true);
  const model = account.store.read().services[issuer.config.modelBaseUrl].accessToken;
  const remote = await account.auth.serviceToken('remote', issuer.config.remoteOrigin);
  assert.equal(issuer.calls.authorizations.length, 1);
  assert.equal(JSON.parse(Buffer.from(model.split('.')[1], 'base64url')).aud, 'obol-api');
  assert.equal(
    JSON.parse(Buffer.from(remote.split('.')[1], 'base64url')).aud,
    'industrial-mcp-remote',
  );
  assert.equal(call('get').config.remoteAudience, undefined);
  assert.ok(views.every(v => !('services' in v)));
  const saved = account.store.read();
  for (const secret of [code, saved.accessToken, saved.refreshToken, model, remote]) {
    assert.ok(!JSON.stringify(views).includes(secret));
    assert.ok(!fs.readFileSync(account.store.file).includes(Buffer.from(secret)));
  }
  assert.equal((await call('logout')).revoked, true);
  assert.deepEqual(issuer.calls.revokedTokens, [saved.refreshToken]);
  assert.equal(call('get').user, null);
  assert.equal(account.store.read(), null);
});
test('corrupt account storage cannot prevent local application startup', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let decryptCalls = 0;
  const account = new DesktopAccount({
    directory,
    environment: {},
    shell: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'test',
      decryptString: () => {
        decryptCalls += 1;
        throw Error('keychain locked');
      },
    },
  });
  t.after(() => account.close());
  fs.mkdirSync(path.join(directory, 'desktop'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'desktop/session.enc'), 'invalid', { mode: 0o600 });
  const view = await account.restore();
  assert.equal(decryptCalls, 1);
  assert.equal(view.persistent, true);
  assert.equal(view.user, null);
  assert.match(view.error, /unlock/);
});
test('signed-out platform model selection can explicitly return to a personal API key', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-account-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'desktop-preferences.json'),
    JSON.stringify({ usePlatformModel: true }),
  );
  const account = new DesktopAccount({
    directory,
    environment: {},
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  });
  t.after(() => account.close());
  assert.equal(account.view().usePlatformModel, true);
  assert.equal(account.view().user, null);
  const view = await account.useModel(false);
  assert.equal(view.usePlatformModel, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, 'desktop-preferences.json'))).usePlatformModel,
    false,
  );
});

function fixture(t, saved, environment = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-account-defaults-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (saved !== undefined)
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(saved));
  const account = new DesktopAccount({
    directory,
    environment,
    shell: { openExternal: () => assert.fail('Startup must not open the browser') },
    safeStorage: { isEncryptionAvailable: () => false },
  });
  t.after(() => account.close());
  return { account, directory };
}

test('fresh desktop can sign in with the verified registration without editing configuration', async t => {
  const { account, directory } = fixture(t);
  const view = await account.restore();
  assert.equal(view.status, 'signed_out');
  assert.equal(view.error, null);
  assert.equal(view.usePlatformModel, false);
  assert.equal(view.config.clientId, 'harness-desktop-1');
  assert.equal(view.config.audience, 'harness-desktop');
  assert.equal(view.config.modelBaseUrl, 'https://api.zhiman.cn/v1');
  assert.equal(view.config.remoteOrigin, '');
  assert.equal(fs.existsSync(path.join(directory, 'config.json')), false);
  assert.equal(account.auth.protocolPromise, undefined);
  assert.equal(readConfig(directory, {}).clientId, '', 'Shared/CLI callers remain explicit');
});

test('an old empty default-issuer form receives the desktop registration', t => {
  const { account } = fixture(t, {
    issuer: DEFAULT_ACCOUNT_CONFIG.issuer,
    clientId: '',
    audience: '',
    remoteOrigin: '',
    modelBaseUrl: '',
  });
  assert.equal(account.view().status, 'signed_out');
  assert.equal(account.view().config.clientId, DEFAULT_ACCOUNT_CONFIG.clientId);
  assert.equal(account.view().config.modelBaseUrl, '', 'An explicit service opt-out is retained');
});

test('existing complete identity keeps its exact binding and empty services', t => {
  const saved = { ...DEFAULT_ACCOUNT_CONFIG, modelBaseUrl: '', remoteAudience: 'custom-remote' };
  const { account } = fixture(t, saved);
  assert.deepEqual(account.auth.config, saved);
});

test('custom issuers and same-issuer custom clients never inherit production identity or services', t => {
  for (const saved of [
    { issuer: 'https://accounts.example.test' },
    {
      issuer: DEFAULT_ACCOUNT_CONFIG.issuer,
      clientId: 'enterprise-native',
      audience: 'enterprise',
    },
  ]) {
    const { account } = fixture(t, saved);
    assert.deepEqual(account.auth.config, validateConfig(saved));
  }
});

test('operator environment overrides saved values without mixing custom and production identities', t => {
  const { account } = fixture(t, DEFAULT_ACCOUNT_CONFIG, {
    INDUSTRIAL_AUTH_ISSUER: 'https://accounts.example.test',
    INDUSTRIAL_AUTH_CLIENT_ID: 'enterprise-native',
    INDUSTRIAL_AUTH_AUDIENCE: 'enterprise',
    INDUSTRIAL_AUTH_MODEL_BASE_URL: 'https://models.example.test/v1',
    INDUSTRIAL_AUTH_REMOTE_ORIGIN: 'https://remote.example.test',
    INDUSTRIAL_AUTH_REMOTE_AUDIENCE: 'enterprise-remote',
  });
  assert.deepEqual(account.auth.config, {
    issuer: 'https://accounts.example.test',
    clientId: 'enterprise-native',
    audience: 'enterprise',
    modelBaseUrl: 'https://models.example.test/v1',
    remoteOrigin: 'https://remote.example.test',
    remoteAudience: 'enterprise-remote',
  });
});

test('operator service endpoints can accompany the bundled desktop registration', t => {
  const { account } = fixture(t, undefined, {
    INDUSTRIAL_AUTH_REMOTE_ORIGIN: 'https://remote.example.test',
    INDUSTRIAL_AUTH_MODEL_BASE_URL: '',
  });
  assert.equal(account.view().config.clientId, DEFAULT_ACCOUNT_CONFIG.clientId);
  assert.equal(account.view().config.remoteOrigin, 'https://remote.example.test');
  assert.equal(account.view().config.modelBaseUrl, '');
});

test('invalid operator configuration fails closed without reverting to the production account', t => {
  const { account } = fixture(t, undefined, { INDUSTRIAL_AUTH_ISSUER: 'http://example.test' });
  assert.equal(account.view().status, 'not_configured');
  assert.equal(account.view().config.clientId, '');
  assert.match(account.view().error, /configuration/);
});

test('an explicit empty operator client ID keeps platform sign-in disabled', t => {
  const { account } = fixture(t, undefined, { INDUSTRIAL_AUTH_CLIENT_ID: '' });
  assert.equal(account.view().status, 'not_configured');
  assert.equal(account.view().config.clientId, '');
});
