const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./runtime-assets.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = value => hash(JSON.stringify(value));
const id = /^[a-z][a-z0-9._-]{0,127}$/;
const failure = (status, code, message) => ({ status, reasons: [{ code, message }] });

function validateExecutionProfiles(profiles = [], assets = []) {
  if (!Array.isArray(profiles)) throw Error('Invalid execution profiles.');
  const seen = new Set();
  for (const profile of profiles) {
    if (
      !id.test(profile?.id || '') ||
      seen.has(profile.id) ||
      typeof profile.label !== 'string' ||
      !profile.label ||
      !['native', 'container', 'remote'].includes(profile.kind) ||
      typeof profile.qualified !== 'boolean' ||
      !Array.isArray(profile.platforms) ||
      profile.platforms.some(p => !/^(darwin|linux|win32)-(arm64|x64)$/.test(p)) ||
      !Array.isArray(profile.toolIds) ||
      profile.toolIds.some(t => !id.test(t)) ||
      new Set(profile.toolIds).size !== profile.toolIds.length ||
      !Array.isArray(profile.assetIds) ||
      new Set(profile.assetIds).size !== profile.assetIds.length ||
      profile.assetIds.some(a => !assets.some(asset => asset.id === a)) ||
      (profile.kind === 'native' &&
        profile.assetIds.some(a => assets.find(asset => asset.id === a).type === 'docker-image')) ||
      (profile.kind === 'container' &&
        profile.assetIds.some(a => assets.find(asset => asset.id === a).type !== 'docker-image'))
    )
      throw Error('Invalid execution profile.');
    seen.add(profile.id);
  }
  return profiles;
}

class RuntimeEnvironmentManager {
  constructor({
    manager,
    platform = `${process.platform}-${process.arch}`,
    command = run,
    versionProbe,
    probeFactory,
    connectionStore,
    environment = process.env,
  } = {}) {
    if (!manager) throw Error('A PackManager is required.');
    this.manager = manager;
    this.platform = platform;
    this.environment = environment;
    this.connectionStore = connectionStore;
    this.command = command;
    this.versionProbe =
      versionProbe ||
      manager.versionProbe ||
      ((asset, executable, options) => this.command(executable, asset.versionArgs, options));
    this.directory = path.join(manager.directory, 'environments');
    this.file = path.join(this.directory, 'state.json');
    this.pending = new Set();
    this.probeFactory =
      probeFactory ||
      (config => {
        const factory = require('@zhiman-bj/industrial-domain-packs').createVersionProbe;
        if (typeof factory !== 'function')
          throw Error('The installed Pack owner does not support the platform probe.');
        return factory(config);
      });
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        value.schemaVersion !== 1 ||
        !value.domains ||
        typeof value.domains !== 'object' ||
        Array.isArray(value.domains) ||
        !value.bindings ||
        typeof value.bindings !== 'object' ||
        Array.isArray(value.bindings)
      )
        throw Error('Invalid runtime environment state.');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, domains: {}, bindings: {} };
      throw error;
    }
  }
  write(change, domain, { preparing = false } = {}) {
    return this.manager.withLock(() => {
      this.manager.assertIdle(domain, { allowRuntimePreparation: preparing });
      if (!preparing) this.assertNotPreparing(domain);
      const state = this.read();
      change(state);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + crypto.randomUUID();
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(temporary, this.file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    });
  }
  bundle(domain) {
    if (!id.test(domain || '')) throw Error('Invalid Domain.');
    const bundle = this.manager.list().find(item => item.domain === domain);
    if (!bundle) throw Error('Domain Pack is not installed.');
    return bundle;
  }
  profiles(bundle) {
    return validateExecutionProfiles(bundle.executionProfiles || [], bundle.runtimeAssets || []);
  }
  profile(bundle, profileId) {
    const profile = this.profiles(bundle).find(item => item.id === profileId);
    if (!profile) throw Error('Unknown execution profile.');
    return profile;
  }
  key(domain, projectDir) {
    return projectDir ? hash(fs.realpathSync(projectDir) + '\0' + domain) : domain;
  }
  binding(domain, projectDir, state = this.read()) {
    const key = this.key(domain, projectDir);
    return (
      (Object.hasOwn(state.bindings, key) && state.bindings[key]) ||
      (Object.hasOwn(state.bindings, domain) && state.bindings[domain]) ||
      null
    );
  }
  supported(profile) {
    if (!profile.qualified || !profile.platforms.includes(this.platform))
      return failure(
        'unsupported',
        'PROFILE_UNQUALIFIED',
        'This execution profile is not qualified on this platform.',
      );
    if (profile.kind === 'remote' && profile.connection?.kind !== 'runtime-managed')
      return failure(
        'unsupported',
        'REMOTE_SETTINGS_REQUIRED',
        'Configure remote execution using project RemoteSettings.',
      );
    return null;
  }
  connectionKey(domain, profileId) {
    return identity([domain, profileId]);
  }
  hasStoredConnection(domain, profile) {
    try {
      return Boolean(this.connectionStore?.read(this.connectionKey(domain, profile.id)));
    } catch {
      return true;
    }
  }
  connectionEnvironment(domain, profile) {
    if (!profile?.connection) return {};
    const saved = this.connectionStore?.read(this.connectionKey(domain, profile.id)) || {};
    if (
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      Object.values(saved).some(value => typeof value !== 'string')
    )
      throw Error('Invalid secure connection record.');
    return Object.fromEntries(
      (profile.connection?.environment || []).map(field => [
        field.name,
        saved[field.name] ?? this.environment[field.name] ?? '',
      ]),
    );
  }
  connectionView(domain, { profileId } = {}) {
    const bundle = this.bundle(domain),
      profile = this.profiles(bundle).find(item => item.id === profileId);
    if (!profile) throw Error('Unknown execution profile.');
    return {
      profileId,
      canPersist: Boolean(this.connectionStore?.available()),
      ...this.connectionStatus(profile, domain),
    };
  }
  async resetConnection(domain, { profileId } = {}) {
    const profile = this.profile(this.bundle(domain), profileId);
    if (profile.connection?.kind !== 'runtime-managed' || !this.connectionStore?.remove)
      throw Error('Connection reset is unavailable.');
    await this.manager.withLock(() => {
      this.manager.assertIdle(domain);
      this.assertNotPreparing(domain);
      this.connectionStore.remove(this.connectionKey(domain, profileId));
    });
    const binding = this.binding(domain);
    if (!binding || binding.profileId === profileId) this.clear(domain);
    return this.connectionView(domain, { profileId });
  }
  async configureConnection(domain, { profileId, values = {}, replace = false } = {}) {
    const bundle = this.bundle(domain),
      profile = this.profiles(bundle).find(item => item.id === profileId);
    if (!profile || profile.connection?.kind !== 'runtime-managed')
      throw Error('Unsupported connection profile.');
    if (!this.connectionStore?.available())
      throw Error(
        'Secure connection storage is unavailable; configure trusted process environment instead.',
      );
    const fields = profile.connection.environment,
      allowed = new Set(fields.map(field => field.name));
    if (Object.keys(values).some(key => !allowed.has(key)))
      throw Error('Unknown connection setting.');
    let record;
    try {
      record = {
        ...((!replace && this.connectionStore.read(this.connectionKey(domain, profileId))) || {}),
      };
    } catch {
      throw Error('CONNECTION_STORAGE_UNAVAILABLE: Reset or explicitly replace this connection.');
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete record[key];
      else if (typeof value !== 'string') throw Error('Connection settings must be strings.');
      else if (value || fields.find(field => field.name === key).type !== 'secret')
        record[key] = value;
    }
    const proposed = { ...this.environment, ...record };
    if (this.connectionStatus(profile, domain, proposed).status === 'incompatible')
      throw Error('Invalid connection settings.');
    await this.manager.withLock(() => {
      this.manager.assertIdle(domain);
      this.assertNotPreparing(domain);
      this.connectionStore.write(this.connectionKey(domain, profileId), record);
    });
    return this.connectionView(domain, { profileId });
  }
  connectionStatus(profile, domain, proposed) {
    const connection = profile.connection;
    if (
      connection?.kind !== 'runtime-managed' ||
      connection.verification !== 'runtime-handshake' ||
      !Array.isArray(connection.environment) ||
      !connection.environment.length
    )
      return failure(
        'unsupported',
        'CONNECTION_UNSUPPORTED',
        'This connection requires an explicitly supported Runtime handshake.',
      );
    let values;
    try {
      values = proposed || this.connectionEnvironment(domain, profile);
    } catch {
      return {
        ...failure(
          'missing',
          'CONNECTION_STORAGE_UNAVAILABLE',
          'Secure connection settings cannot be read. Reset or replace this connection.',
        ),
        configured: false,
        executable: false,
        connectionFields: connection.environment.map(({ name, type }) => ({
          name,
          type,
          required: true,
          configured: false,
        })),
      };
    }
    const reasons = [],
      connectionFields = [];
    for (const variable of connection.environment) {
      if (
        !/^INDUSTRIAL_HARNESS_[A-Z0-9_]+$/.test(variable.name || '') ||
        !['endpoint', 'secret', 'sha256'].includes(variable.type)
      )
        return failure('unsupported', 'CONNECTION_UNSUPPORTED', 'Invalid connection declaration.');
      const value = values[variable.name];
      let valid = typeof value === 'string' && Boolean(value) && !/[\r\n]/.test(value);
      if (variable.type === 'sha256') valid &&= /^[a-f0-9]{64}$/.test(value);
      if (variable.type === 'endpoint') {
        try {
          const url = new URL(value);
          valid &&=
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            (url.protocol === 'https:' ||
              (url.protocol === 'http:' &&
                ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
        } catch {
          valid = false;
        }
      }
      connectionFields.push({
        ...variable,
        required: true,
        configured: valid,
        ...(variable.type !== 'secret' && valid ? { value } : {}),
      });
      if (!valid)
        reasons.push({
          code: value ? 'CONNECTION_CONFIGURATION_INVALID' : 'CONNECTION_CONFIGURATION_REQUIRED',
          message: `Configure ${variable.name} in trusted host settings.`,
        });
    }
    if (reasons.length)
      return {
        status: reasons.some(reason => reason.code === 'CONNECTION_CONFIGURATION_INVALID')
          ? 'incompatible'
          : 'missing',
        configured: false,
        executable: false,
        reasons,
        connectionFields,
      };
    return {
      status: 'unchecked',
      configured: true,
      executable: true,
      connectionFields,
      connectionIdentity: identity(connectionFields.filter(field => field.type !== 'secret')),
      reasons: [
        {
          code: 'RUNTIME_HANDSHAKE_REQUIRED',
          message:
            'Connection settings are configured. The Runtime must verify both service identities and the project binding before execution.',
        },
      ],
    };
  }
  externalIdentity(asset, appPath) {
    if (!path.isAbsolute(appPath) || fs.lstatSync(appPath).isSymbolicLink())
      throw Error('Choose an ordinary absolute application directory.');
    const root = fs.realpathSync(appPath);
    if (!fs.statSync(root).isDirectory() || root === path.parse(root).root)
      throw Error('Invalid application directory.');
    const executables = {},
      hashes = {};
    for (const [variable, relative] of Object.entries({
      [asset.environment]: asset.executable,
      ...asset.environmentExecutables,
    })) {
      if (
        typeof relative !== 'string' ||
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some(p => p === '..' || !p)
      )
        throw Error('Invalid application executable.');
      const file = fs.realpathSync(path.join(root, relative));
      if (!file.startsWith(root + path.sep)) throw Error('Executable escaped the application.');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('Executable is not an ordinary file.');
      fs.accessSync(file, fs.constants.X_OK);
      executables[variable] = file;
      hashes[variable] = hash(fs.readFileSync(file));
    }
    return { appPath: root, executables, hashes, declaration: identity(asset) };
  }
  platformProbe(bundle) {
    const declaration = bundle.platformProbe;
    if (!declaration) return null;
    if (
      declaration.schemaVersion !== 1 ||
      declaration.platform !== this.platform ||
      typeof declaration.file !== 'string' ||
      declaration.file !== `components/${this.platform}/industrial-environment-probe` ||
      !/^[a-f0-9]{64}$/.test(declaration.sha256 || '') ||
      !Number.isSafeInteger(declaration.sizeBytes) ||
      declaration.sizeBytes < 1 ||
      declaration.sizeBytes > 32 * 1024 * 1024
    )
      throw Error('Invalid platform probe declaration.');
    const root = fs.realpathSync(bundle.location);
    let binary = root;
    for (const segment of declaration.file.split('/')) {
      binary = path.join(binary, segment);
      if (fs.lstatSync(binary).isSymbolicLink())
        throw Error('Platform probe cannot contain symlinks.');
    }
    binary = fs.realpathSync(binary);
    if (!binary.startsWith(root + path.sep))
      throw Error('Platform probe escaped the installed Pack.');
    const stat = fs.statSync(binary);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== declaration.sizeBytes ||
      hash(fs.readFileSync(binary)) !== declaration.sha256
    )
      throw Error('Platform probe identity changed.');
    fs.accessSync(binary, fs.constants.X_OK);
    return { binary, sha256: declaration.sha256, identity: identity(declaration) };
  }
  externalStatus(asset, receipt, probe) {
    try {
      if (receipt?.probeIdentity !== probe?.identity)
        return failure(
          'stale',
          'PROBE_CHANGED',
          'The environment probe changed; check the application again.',
        );
      if (!receipt || receipt.declaration !== identity(asset))
        return failure(
          'stale',
          'DECLARATION_CHANGED',
          'The application declaration changed; check it again.',
        );
      const current = this.externalIdentity(asset, receipt.appPath);
      if (identity(current) !== identity(receipt.identity))
        return failure(
          'stale',
          'APPLICATION_CHANGED',
          'The associated application changed; check it again.',
        );
      return {
        status: 'ready',
        reasons: [],
        executables: current.executables,
        source: 'external',
        appPath: current.appPath,
        checkedAt: receipt.checkedAt,
      };
    } catch (error) {
      return failure('stale', 'APPLICATION_CHANGED', error.message);
    }
  }
  resolve(bundle, { projectDir, selectedOnly = false } = {}) {
    const state = this.read();
    let binding = this.binding(bundle.domain, projectDir, state);
    let probe, probeError;
    try {
      probe = this.platformProbe(bundle);
    } catch (error) {
      probeError = error;
    }
    const profiles = this.profiles(bundle),
      assets = bundle.runtimeAssets || [];
    if (!binding) {
      const compatible = profiles.filter(
        profile =>
          profile.kind === 'remote' &&
          !this.hasStoredConnection(bundle.domain, profile) &&
          !this.supported(profile) &&
          this.connectionStatus(profile, bundle.domain).executable,
      );
      if (compatible.length === 1)
        binding = { profileId: compatible[0].id, assets: {}, source: 'existing-settings' };
    }
    const receipts = Object.hasOwn(state.domains, bundle.domain)
      ? state.domains[bundle.domain]
      : {};
    const selectedAssets = selectedOnly
      ? assets.filter(asset =>
          profiles.find(profile => profile.id === binding?.profileId)?.assetIds.includes(asset.id),
        )
      : assets;
    const managed = this.manager.runtimeAssets.status(selectedAssets);
    const environment = Object.fromEntries(
      assets.flatMap(asset =>
        Object.keys({ [asset.environment]: '', ...asset.environmentExecutables }).map(key => [
          key,
          '',
        ]),
      ),
    );
    const views = profiles.map(profile => {
      const unsupported = this.supported(profile);
      const selected = binding?.profileId === profile.id;
      const checks = assets
        .filter(asset => profile.assetIds.includes(asset.id))
        .map(asset => {
          const external = selected && binding.assets?.[asset.id];
          const prepared = managed.find(item => item.id === asset.id);
          const result = external
            ? this.externalStatus(asset, external, probe)
            : prepared?.ready
              ? {
                  status: 'ready',
                  reasons: [],
                  executables: prepared.executables,
                  source: 'managed',
                }
              : failure(
                  'missing',
                  'DEPENDENCY_MISSING',
                  prepared?.message || 'Runtime dependency needs preparation.',
                );
          return {
            id: asset.id,
            label: asset.label,
            discoveryPaths: asset.discoveryPaths || [],
            installUrl: asset.installUrl,
            candidates:
              receipts[profile.id]?.assets?.find(item => item.id === asset.id)?.candidates || [],
            ...result,
          };
        });
      const failed = checks.find(item => item.status !== 'ready');
      const saved = receipts[profile.id];
      const result =
        unsupported ||
        (profile.kind === 'remote' ? this.connectionStatus(profile, bundle.domain) : null) ||
        (profile.kind === 'native' && probeError
          ? failure('stale', 'PROBE_CHANGED', probeError.message)
          : null) ||
        (failed
          ? failure(failed.status, failed.reasons[0].code, failed.reasons[0].message)
          : { status: 'ready', reasons: [] });
      if (selected && result.executable && profile.connection)
        Object.assign(environment, this.connectionEnvironment(bundle.domain, profile));
      if (selected && result.status === 'ready')
        for (const check of checks) Object.assign(environment, check.executables);
      return {
        ...profile,
        ...result,
        assets: checks,
        selected,
        checkedAt: saved?.checkedAt,
        lastCheck: saved,
        detecting: this.pending.has(bundle.domain + '/' + profile.id),
      };
    });
    const selected = views.find(item => item.selected);
    // Older bundles retain their managed identity but do not invent unqualified profiles.
    const legacy = !Object.hasOwn(bundle, 'executionProfiles');
    if (legacy) Object.assign(environment, this.manager.runtimeAssets.environment(assets));
    const readyToolIds = selected?.status === 'ready' ? selected.toolIds : [];
    const executableToolIds =
      selected?.executable || selected?.status === 'ready' ? selected.toolIds : [];
    const view = {
      domain: bundle.domain,
      profiles: views,
      binding,
      environment,
      readyToolIds,
      executableToolIds,
      executable: Boolean(selected?.executable || selected?.status === 'ready'),
      legacy,
      status: selected?.status || 'unchecked',
      identity: identity({
        binding,
        environment: Object.fromEntries(
          Object.entries(environment).filter(
            ([key]) =>
              !profiles.some(profile =>
                profile.connection?.environment.some(
                  field => field.name === key && field.type === 'secret',
                ),
              ),
          ),
        ),
        selected: selected && {
          id: selected.id,
          status: selected.status,
          connectionIdentity: selected.connectionIdentity,
          assets: selected.assets.map(asset => ({
            id: asset.id,
            status: asset.status,
            executables: asset.executables,
            appPath: asset.appPath,
            source: asset.source,
          })),
        },
        probe: probe?.identity,
        source: bundle.sourceRelease,
        version: bundle.version,
      }),
    };
    const selectedProfile = profiles.find(profile => profile.id === binding?.profileId);
    const privateRevision = (selectedProfile?.connection?.environment || []).map(variable => [
      variable.name,
      selected?.executable
        ? this.connectionEnvironment(bundle.domain, selectedProfile)[variable.name] || ''
        : '',
    ]);
    Object.defineProperty(view, 'environment', { value: environment, enumerable: false });
    Object.defineProperty(view, 'configurationIdentity', {
      value: identity([view.identity, privateRevision]),
      enumerable: false,
    });
    return view;
  }
  async validate(bundle, { projectDir, signal } = {}) {
    const view = this.resolve(bundle, { projectDir, selectedOnly: true });
    if (!view.legacy && !view.executable) throw Error('Runtime environment is not ready.');
    for (const asset of bundle.runtimeAssets || []) {
      const receipt = view.binding?.assets?.[asset.id];
      if (receipt) await this.checkAsset(asset, receipt.appPath, signal, bundle);
    }
    if (this.resolve(bundle, { projectDir, selectedOnly: true }).identity !== view.identity)
      throw Error('Runtime environment changed during validation.');
    return view;
  }
  describe(domain, options = {}) {
    return this.resolve(this.bundle(domain), options);
  }
  async checkAsset(asset, appPath, signal, bundle) {
    signal?.throwIfAborted();
    const probe = bundle && this.platformProbe(bundle);
    const versionProbe = probe ? this.probeFactory(probe) : this.versionProbe;
    const before = this.externalIdentity(asset, appPath);
    if (this.platform.startsWith('darwin-'))
      await this.command('/usr/bin/codesign', ['--verify', '--deep', '--strict', before.appPath], {
        signal,
        timeout: 120000,
      });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-probe-'));
    try {
      for (const name of ['data', 'temp']) fs.mkdirSync(path.join(temporary, name));
      const output = await versionProbe(asset, before.executables[asset.environment], {
        signal,
        timeout: 120000,
        cwd: temporary,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: temporary,
          TMPDIR: path.join(temporary, 'temp') + '/',
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          QT_QPA_PLATFORM: 'offscreen',
          ...Object.fromEntries(
            Object.entries(asset.profileEnvironment || {}).map(([k, v]) => [
              k,
              v === 'home' ? temporary : path.join(temporary, v),
            ]),
          ),
        },
      });
      signal?.throwIfAborted();
      const text = String(output),
        index = text.indexOf(asset.versionText);
      const beforeVersion = index > 0 ? text[index - 1] : '';
      const afterVersion = index >= 0 ? text[index + asset.versionText.length] || '' : '';
      if (
        index < 0 ||
        /[0-9]/.test(beforeVersion) ||
        (/[0-9]$/.test(asset.versionText) && /[0-9]/.test(afterVersion))
      )
        throw Error('Application version does not match the execution profile.');
      if (identity(before) !== identity(this.externalIdentity(asset, appPath)))
        throw Error('Application changed during detection.');
      return {
        status: 'ready',
        reasons: [],
        checkedAt: new Date().toISOString(),
        declaration: identity(asset),
        probeIdentity: probe?.identity,
        appPath: before.appPath,
        identity: before,
      };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  async detect(domain, { profileId, paths = {}, signal, onProgress } = {}) {
    const bundle = this.bundle(domain),
      profile = this.profile(bundle, profileId);
    if (
      !paths ||
      typeof paths !== 'object' ||
      Array.isArray(paths) ||
      Object.keys(paths).some(
        key => !profile.assetIds.includes(key) || typeof paths[key] !== 'string',
      )
    )
      throw Error('Application paths must name assets in this profile.');
    const unsupported = this.supported(profile);
    if (unsupported) return { profileId, ...unsupported, assets: [] };
    if (profile.kind === 'remote') {
      signal?.throwIfAborted();
      const result = {
        profileId,
        ...this.connectionStatus(profile, bundle.domain),
        assets: [],
        checkedAt: new Date().toISOString(),
      };
      this.write(state => {
        if (!Object.hasOwn(state.domains, domain)) state.domains[domain] = {};
        state.domains[domain][profileId] = result;
      }, domain);
      return result;
    }
    const key = domain + '/' + profileId;
    if (this.pending.has(key)) throw Error('Environment detection is already in progress.');
    this.pending.add(key);
    try {
      onProgress?.({ domain, profileId, status: 'detecting' });
      const assets = [];
      for (const asset of (bundle.runtimeAssets || []).filter(item =>
        profile.assetIds.includes(item.id),
      )) {
        signal?.throwIfAborted();
        if (profile.kind === 'container') {
          const status = this.manager.runtimeAssets.status([asset])[0];
          assets.push({
            id: asset.id,
            ...(status.ready
              ? { status: 'ready', reasons: [], source: 'managed' }
              : failure('missing', 'IMAGE_MISSING', status.message)),
          });
          continue;
        }
        const candidates = paths[asset.id]
          ? [paths[asset.id]]
          : (asset.discoveryPaths || []).map(p =>
              p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p,
            );
        let result = failure(
          'missing',
          'APPLICATION_MISSING',
          'No compatible application was found.',
        );
        const checked = [];
        for (const candidate of candidates) {
          if (!fs.existsSync(candidate)) continue;
          try {
            const check = await this.checkAsset(asset, candidate, signal, bundle);
            if (!checked.some(item => item.appPath === check.appPath)) checked.push(check);
          } catch (error) {
            signal?.throwIfAborted();
            checked.push({
              appPath: candidate,
              ...failure('incompatible', 'APPLICATION_INCOMPATIBLE', error.message),
            });
          }
        }
        const compatible = checked.filter(check => check.status === 'ready');
        if (compatible.length === 1) result = compatible[0];
        else if (compatible.length > 1)
          result = failure(
            'unchecked',
            'CHOOSE_APPLICATION',
            'Multiple compatible applications were found. Choose an application.',
          );
        else if (checked.length) result = checked[0];
        assets.push({
          id: asset.id,
          ...result,
          candidates: checked.map(({ appPath, status, reasons }) => ({ appPath, status, reasons })),
        });
      }
      signal?.throwIfAborted();
      const failed = assets.find(item => item.status !== 'ready');
      const result = {
        profileId,
        checkedAt: new Date().toISOString(),
        assets,
        ...(failed
          ? failure(failed.status, failed.reasons[0].code, failed.reasons[0].message)
          : { status: 'ready', reasons: [] }),
      };
      this.write(state => {
        if (!Object.hasOwn(state.domains, domain)) state.domains[domain] = {};
        state.domains[domain][profileId] = result;
      }, domain);
      return result;
    } finally {
      this.pending.delete(key);
    }
  }
  async associate(domain, { profileId, projectDir, paths, signal } = {}) {
    const result = await this.detect(domain, { profileId, paths, signal });
    if (result.status !== 'ready' && !result.executable)
      return {
        ...this.describe(domain, { projectDir }),
        status: result.status,
        reasons: result.reasons,
        lastCheck: result,
      };
    signal?.throwIfAborted();
    this.write(state => {
      state.bindings[this.key(domain, projectDir)] = {
        profileId,
        assets: Object.fromEntries(result.assets.filter(a => a.identity).map(a => [a.id, a])),
        associatedAt: new Date().toISOString(),
      };
    }, domain);
    return this.describe(domain, { projectDir });
  }
  operationFile(domain) {
    return path.join(this.directory, domain + '.preparing.json');
  }
  assertNotPreparing(domain) {
    try {
      const record = JSON.parse(fs.readFileSync(this.operationFile(domain), 'utf8'));
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          fs.rmSync(this.operationFile(domain), { force: true });
          return;
        }
        throw error;
      }
      throw Error('Runtime environment preparation is in progress.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  acquireUse(domain) {
    const release = this.manager.acquireUse(domain);
    try {
      this.assertNotPreparing(domain);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  async prepare(domain, { profileId, projectDir, signal, onProgress } = {}) {
    const bundle = this.bundle(domain),
      profile = this.profile(bundle, profileId);
    const unsupported =
      this.supported(profile) ||
      (profile.kind === 'remote'
        ? failure(
            'unsupported',
            'REMOTE_PREPARATION_EXTERNAL',
            'Remote services are prepared by their administrator. Associate existing trusted connection settings instead.',
          )
        : null);
    if (unsupported) return { ...this.describe(domain, { projectDir }), ...unsupported, profileId };
    this.manager.withLock(() => {
      this.manager.assertIdle(domain);
      this.assertNotPreparing(domain);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.operationFile(domain), JSON.stringify({ pid: process.pid }), {
        flag: 'wx',
        mode: 0o600,
      });
    });
    try {
      await this.manager.runtimeAssets.ensure(
        (bundle.runtimeAssets || []).filter(asset => profile.assetIds.includes(asset.id)),
        { signal, onProgress },
      );
      signal?.throwIfAborted();
      this.write(
        state => {
          state.bindings[this.key(domain, projectDir)] = {
            profileId,
            assets: {},
            associatedAt: new Date().toISOString(),
          };
        },
        domain,
        { preparing: true },
      );
      return this.describe(domain, { projectDir });
    } finally {
      fs.rmSync(this.operationFile(domain), { force: true });
    }
  }
  clear(domain, { projectDir } = {}) {
    this.write(state => {
      if (projectDir) delete state.bindings[this.key(domain, projectDir)];
      else state.bindings[domain] = { disabled: true, source: 'explicit-unlink' };
    }, domain);
    return this.describe(domain, { projectDir });
  }
}
module.exports = { RuntimeEnvironmentManager, validateExecutionProfiles };
