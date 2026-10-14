const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const { AuthManager, SessionStore, authError } = require('./index.cjs');

// One product account, two independent resource grants. Neither view() nor
// adapter IPC exposes resource sessions or credentials.
class AccountManager extends EventEmitter {
  constructor({ config, store, ...options }) {
    super();
    this.config = config;
    this.store = store;
    this.identity = crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
    this.epoch = 0;
    this.accounts = new Map();
    for (const service of ['model', 'remote']) {
      const sessionStore =
        service === 'model'
          ? store
          : new SessionStore({
              directory: path.join(store.directory, service),
              encryption: store.encryption,
              allowPlaintext: store.allowPlaintext,
            });
      const auth = new AuthManager({
        ...options,
        config: { ...config, ...config.services[service] },
        store: sessionStore,
      });
      auth.on('change', () => this.emit('change', this.view()));
      for (const event of ['authorization', 'manual-authorization'])
        auth.on(event, url => this.emit(event, url));
      this.accounts.set(service, auth);
    }
  }
  get pending() {
    return this.active?.pending;
  }
  get starting() {
    return Boolean(this.loginPromise || this.active?.starting);
  }
  view() {
    const views = [...this.accounts.values()].map(auth => auth.view());
    const subject = views[0].user?.sub;
    const complete =
      !this.restoreFailed &&
      subject &&
      views.every(
        view => view.user?.sub === subject && ['signed_in', 'refreshing'].includes(view.status),
      );
    return {
      status: this.loginPromise
        ? 'signing_in'
        : this.loggingOut
          ? 'signed_out'
          : complete
            ? views.some(view => view.status === 'refreshing')
              ? 'refreshing'
              : 'signed_in'
            : this.restoreFailed ||
                views.some(view => view.user || view.status === 'reauth_required')
              ? 'reauth_required'
              : 'signed_out',
      user: !this.loggingOut && complete ? views[0].user : null,
      issuer: this.config.issuer,
      persistent: views.every(view => view.persistent),
      error: this.error || views.find(view => view.error)?.error || null,
      login: this.active?.view().login || null,
    };
  }
  changed(state, error) {
    this.restoreFailed = state === 'reauth_required';
    this.error = error;
    this.emit('change', this.view());
  }
  async restore() {
    const results = await Promise.allSettled(
      [...this.accounts.values()].map(auth => auth.restore()),
    );
    const failure = results.find(result => result.status === 'rejected');
    this.restoreFailed = Boolean(failure);
    if (failure) {
      this.emit('change', this.view());
      throw failure.reason;
    }
    this.emit('change', this.view());
    return this.view();
  }
  login(options = {}) {
    if (this.starting || this.loggingOut)
      return Promise.reject(Error('Sign-in is already in progress.'));
    const epoch = ++this.epoch;
    this.error = null;
    this.restoreFailed = false;
    // Defer the first event until loginPromise is assigned, preserving a single
    // signing_in state across both browser/CLI callback paths.
    this.loginPromise = Promise.resolve().then(async () => {
      try {
        let subject;
        for (const auth of this.accounts.values()) {
          if (epoch !== this.epoch) throw authError('cancelled');
          this.active = auth;
          await auth.restore();
          if (epoch !== this.epoch) throw authError('cancelled');
          if (!auth.view().user) await auth.login(options);
          else await auth.accessToken();
          if (epoch !== this.epoch) throw authError('cancelled');
          const next = auth.view().user?.sub;
          if (!next || (subject && subject !== next)) throw authError('protocol_error');
          subject = next;
        }
      } catch (error) {
        await this.revokeAll();
        this.error = error.message;
        throw error;
      } finally {
        this.active = null;
        this.loginPromise = null;
        this.emit('change', this.view());
      }
      return this.view();
    });
    this.emit('change', this.view());
    return this.loginPromise;
  }
  submitCode(value) {
    if (!this.active) throw authError('no_pending_login');
    return this.active.submitCode(value);
  }
  openManualLogin(openBrowser) {
    if (!this.active) throw authError('no_pending_login');
    return this.active.openManualLogin(openBrowser);
  }
  cancel() {
    ++this.epoch;
    for (const auth of this.accounts.values()) auth.cancel();
    this.emit('change', this.view());
  }
  async serviceToken(service, target, options) {
    const epoch = this.epoch;
    if (this.starting || this.loggingOut) throw authError('login_required');
    const auth = this.accounts.get(service);
    if (!auth) throw Error('Unknown platform service.');
    await this.restore();
    const subject = this.view().user?.sub;
    if (!subject || epoch !== this.epoch) throw authError('login_required');
    const token = await auth.serviceToken(service, target, options);
    if (epoch !== this.epoch || this.view().user?.sub !== subject) throw authError('cancelled');
    return token;
  }
  async revokeAll() {
    const results = await Promise.allSettled(
      [...this.accounts.values()].map(auth => auth.logout()),
    );
    return results.every(result => result.status === 'fulfilled' && result.value.revoked);
  }
  async logout() {
    if (this.logoutPromise) return this.logoutPromise;
    this.loggingOut = true;
    this.cancel();
    const login = this.loginPromise;
    this.logoutPromise = (async () => {
      // A pending code exchange cleans up its late token before login settles.
      await login?.catch(() => {});
      const revoked = await this.revokeAll();
      this.loggingOut = false;
      this.restoreFailed = false;
      this.error = null;
      this.emit('change', this.view());
      return { ...this.view(), revoked };
    })();
    try {
      return await this.logoutPromise;
    } finally {
      this.logoutPromise = null;
    }
  }
  close() {
    this.cancel();
    for (const auth of this.accounts.values()) auth.close();
    this.removeAllListeners();
  }
}
module.exports = { AccountManager };
