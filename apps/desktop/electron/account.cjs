const path = require('node:path');
const fs = require('node:fs');
const {
  AuthManager,
  SessionStore,
  readConfig,
  validateConfig,
  writePrivate,
} = require('@industrial-agent-harness/harness-auth');
const { createModelProxy } = require('@industrial-agent-harness/harness-auth/src/model-proxy.cjs');

class DesktopAccount {
  constructor({
    directory,
    safeStorage,
    shell,
    environment = process.env,
    onChange = () => {},
    assertIdle = () => {},
    fetch = global.fetch,
  }) {
    this.fetch = fetch;
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.shell = shell;
    this.environment = environment;
    this.onChange = onChange;
    this.assertIdle = assertIdle;
    this.store = new SessionStore({
      directory: path.join(directory, 'desktop'),
      encryption: {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: text => safeStorage.encryptString(text),
        decrypt: bytes => safeStorage.decryptString(bytes),
      },
    });
    // The platform account is the model source until the user picks their own key.
    try {
      this.modelEnabled =
        JSON.parse(fs.readFileSync(path.join(directory, 'desktop-preferences.json'), 'utf8'))
          .usePlatformModel === true;
    } catch (error) {
      this.modelEnabled = error.code === 'ENOENT';
    }
    try {
      this.bind(readConfig(directory, environment));
    } catch {
      this.bind(validateConfig({}));
      this.auth.error = 'Cannot read platform account configuration.';
    }
  }
  bind(config) {
    this.auth = new AuthManager({ config, store: this.store });
    this.auth.on('change', () => {
      if (!this.auth.view().user) {
        this.proxy?.close();
        this.proxy = null;
      }
      this.onChange(this.view());
    });
  }
  view() {
    return {
      ...this.auth.view(),
      config: this.auth.config,
      usePlatformModel: Boolean(this.modelEnabled),
    };
  }
  async restore() {
    try {
      await this.auth.restore();
      if (this.modelEnabled && this.auth.view().user)
        this.proxy = await createModelProxy({ auth: this.auth });
      this.onChange(this.view());
    } catch {
      this.auth.changed('reauth_required', 'Cannot unlock saved account credentials.');
    }
    return this.view();
  }
  async configure(value) {
    this.assertIdle();
    if (this.auth.view().user || this.auth.pending || this.auth.starting)
      throw Error('Sign out before changing the account platform.');
    const config = validateConfig(value);
    // Environment overrides are controlled by the operator, never silently ignored.
    for (const [key, name] of Object.entries({
      issuer: 'ISSUER',
      clientId: 'CLIENT_ID',
      audience: 'AUDIENCE',
      remoteOrigin: 'REMOTE_ORIGIN',
      remoteAudience: 'REMOTE_AUDIENCE',
      modelBaseUrl: 'MODEL_BASE_URL',
    }))
      if (
        this.environment['INDUSTRIAL_AUTH_' + name] !== undefined &&
        config[key] !== this.auth.config[key]
      )
        throw Error('This account setting is managed by the application operator.');
    writePrivate(path.join(this.directory, 'config.json'), JSON.stringify(config, null, 2));
    // The model source stays as chosen; the next sign-in opens the proxy to the new platform.
    this.proxy?.close();
    this.proxy = null;
    this.auth.close();
    this.bind(config);
    this.onChange(this.view());
    return this.view();
  }
  async login() {
    this.assertIdle();
    if (this.auth.view().user) return this.view();
    await this.auth.login({ openBrowser: url => this.shell.openExternal(url) });
    if (this.modelEnabled) this.proxy = await createModelProxy({ auth: this.auth });
    this.onChange(this.view());
    return this.view();
  }
  async logout() {
    // Existing remote jobs are server-owned. Logging out never cancels a job.
    this.proxy?.close();
    this.proxy = null;
    const result = await this.auth.logout();
    return { ...this.view(), revoked: result.revoked };
  }
  async useModel(enabled) {
    this.assertIdle();
    if (typeof enabled !== 'boolean') throw Error('Invalid model authentication mode.');
    let nextProxy = null;
    // Signed out, the choice is only saved; signing in opens the proxy.
    if (enabled && this.auth.view().user) {
      await this.auth.serviceToken('model', this.auth.config.modelBaseUrl);
      nextProxy = await createModelProxy({ auth: this.auth });
    }
    try {
      writePrivate(
        path.join(this.directory, 'desktop-preferences.json'),
        JSON.stringify({ usePlatformModel: enabled }),
      );
    } catch (error) {
      nextProxy?.close();
      throw error;
    }
    this.proxy?.close();
    this.proxy = nextProxy;
    this.modelEnabled = enabled;
    this.onChange(this.view());
    return this.view();
  }
  // The models the platform offers this user, with their context windows, so the
  // model settings can offer a choice instead of a free-text name.
  async models() {
    if (!this.auth.view().user) throw Error('Sign in to the platform account first.');
    const base = this.auth.config.modelBaseUrl;
    const token = await this.auth.serviceToken('model', base);
    const response = await this.fetch(base + '/models', {
      redirect: 'error',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw Error('Platform model list unavailable.');
    const body = await response.json();
    return (Array.isArray(body?.data) ? body.data : [])
      .filter(model => typeof model?.id === 'string' && model.id.length <= 128)
      .map(model => ({
        id: model.id,
        contextWindow: Number(model.capabilities?.context_window) || null,
      }));
  }
  close() {
    this.proxy?.close();
    this.auth.close();
  }
}

function registerAccountHandlers({ ipcMain, getWindow, account }) {
  const handlers = {
    get: () => account.view(),
    configure: value => account.configure(value),
    login: () => account.login(),
    'open-manual': async () => {
      await account.auth.openManualLogin(url => account.shell.openExternal(url));
      return account.view();
    },
    'submit-code': async value => {
      await account.auth.submitCode(value);
      return account.view();
    },
    cancel: () => {
      account.auth.cancel();
      return account.view();
    },
    logout: () => account.logout(),
    'use-model': enabled => account.useModel(enabled),
    models: () => account.models(),
  };
  for (const [name, action] of Object.entries(handlers))
    ipcMain.handle('account:' + name, (event, request) => {
      const window = getWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw Error('Account operations require the main application window.');
      return action(request);
    });
}
module.exports = { DesktopAccount, registerAccountHandlers };
