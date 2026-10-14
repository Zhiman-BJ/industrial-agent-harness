const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DesktopAccount, registerAccountHandlers } = require('./account.cjs');
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
  await account.configure(issuer.config);
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
  const saved = account.store.read();
  for (const secret of [code, saved.accessToken, saved.refreshToken]) {
    assert.ok(!JSON.stringify(views).includes(secret));
    assert.ok(!fs.readFileSync(account.store.file).includes(Buffer.from(secret)));
  }
  await call('logout');
  assert.equal(call('get').user, null);
  assert.equal(account.store.read(), null);
});
test('corrupt account storage cannot prevent local application startup', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = new DesktopAccount({
    directory,
    environment: {},
    shell: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw Error('keychain locked');
      },
    },
  });
  t.after(() => account.close());
  fs.mkdirSync(path.join(directory, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'desktop/session.enc'), 'invalid', { mode: 0o600 });
  const view = await account.restore();
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
