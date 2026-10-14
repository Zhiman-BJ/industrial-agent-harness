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
