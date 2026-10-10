const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  nativeImage,
  shell,
  screen,
  systemPreferences,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const languageConfig = require('../i18n.config.json');
const { guiPermissions, guiPermissionSettingsUrl } = require('./gui-permissions.cjs');
const { PackManager, defaultPackDirectory } = require('@industrial-agent-harness/pack-manager');
const {
  PackCatalog,
  describeInstalled,
  InstallationJournal,
} = require('@industrial-agent-harness/pack-manager/src/catalog.cjs');
if (app.isPackaged && !process.env.INDUSTRIAL_HARNESS_PACK_STORE)
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = defaultPackDirectory();
if (process.argv.includes('--packaged-smoke'))
  process.env.INDUSTRIAL_HARNESS_PACK_STORE =
    process.env.HARNESS_PACKAGED_SMOKE_STORE ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-packs-smoke-'));
if (process.argv.includes('--cad-install-selftest')) {
  if (
    !app.isPackaged ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    !process.env.HARNESS_CAD_INSTALL_REPORT_DIR
  )
    throw Error(
      'CAD install selftest requires a packaged Apple Silicon app and fresh evidence directory.',
    );
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = path.join(
    process.env.HARNESS_CAD_INSTALL_REPORT_DIR,
    'packs',
  );
}
if (process.argv.includes('--packaged-smoke') && process.env.HARNESS_PACKAGED_SMOKE_FEED_DIR) {
  const fixture = process.env.HARNESS_PACKAGED_SMOKE_FEED_DIR;
  const nativeFetch = global.fetch;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname !== 'updates.example') return nativeFetch(url, options);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'updates.example' ||
      parsed.pathname.split('/').length !== 2
    )
      throw Error('Unexpected Pack smoke URL.');
    return new Response(fs.readFileSync(path.join(fixture, path.basename(parsed.pathname))));
  };
}
const { spawnSync } = require('node:child_process');
const { RasterService } = require('@industrial-agent-harness/viewer-builtin/runtime/layout');
const {
  renderNetlist,
  isYosysNetlist,
} = require('@industrial-agent-harness/viewer-builtin/runtime/netlist');
const {
  createViewerProtocol,
} = require('@industrial-agent-harness/viewer-builtin/runtime/waveform-protocol');
const {
  initialVcdSignals,
} = require('@industrial-agent-harness/viewer-builtin/runtime/waveform-signals');
const {
  GodotRuntimeManager,
  isGodotExport,
} = require('@industrial-agent-harness/viewer-builtin/runtime/godot');
const { createAssetPlugins } = require('@industrial-agent-harness/viewer-builtin/runtime/assets');
const {
  createDocumentPlugins,
} = require('@industrial-agent-harness/viewer-builtin/runtime/documents');
const {
  createEngineeringPlugins,
} = require('@industrial-agent-harness/viewer-builtin/runtime/engineering');
const {
  KiCadRuntimeManager,
  isKiCadFile,
} = require('@industrial-agent-harness/viewer-builtin/runtime/kicad');
const { createViewerRegistry } = require('@industrial-agent-harness/viewer-core/registry');
const { resolve } = require('@industrial-agent-harness/capability-broker');
const {
  resourceCatalog: baseResourceCatalog,
  ResourceSettings,
  RemoteSettings,
  defaultChatDirectory,
  ExternalMcpRegistry,
} = require('@industrial-agent-harness/harness-core');
const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
const {
  validatePromptImages,
} = require('@industrial-agent-harness/agent-kimi/src/image-input.cjs');
const {
  DiagnosticReader,
} = require('@industrial-agent-harness/agent-kimi/src/diagnostic-reader.cjs');
const {
  defaultLogDirectory,
} = require('@industrial-agent-harness/agent-kimi/src/diagnostic-log.cjs');
const { TaskService } = require('@industrial-agent-harness/harness-application');
const { CoreUpdater } = require('./updater.cjs');
const { bundledExecutable, KIMI_CODE_VERSION } = require('@industrial-agent-harness/agent-kimi');
const { ObservedContextStore } = require('@industrial-agent-harness/domain-runtime');
const {
  createGuiPlugin,
  ensureInstalled,
  status: guiBridgeStatus,
} = require('@industrial-agent-harness/computer-use-bridge');
const { readSettings, saveSettings } = require('./harness-settings.cjs');
const {
  readProfile,
  saveProfile,
  validateProfile,
  writeCliConfig,
  sessionEnv,
} = require('./model-config.cjs');
const { readBindings, addBinding, saveBindings } = require('./project-bindings.cjs');
const { resolveProjectFile, listProjectFiles, readSourcePreview } = require('./project-files.cjs');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
if (
  [
    '--task-results-selftest',
    '--viewer-selftest',
    '--kicad-selftest',
    '--godot-selftest',
    '--documents-selftest',
    '--language-selftest',
    '--ui-selftest',
    '--messages-selftest',
    '--gui-settings-selftest',
    '--engineering-selftest',
    '--cad-selftest',
    '--cad-resize-selftest',
    '--mcp-selftest',
    '--subagent-selftest',
    '--external-mcp-selftest',
    '--agent-log-selftest',
    '--chat-selftest',
    '--parallel-selftest',
    '--image-input-selftest',
    '--model-sync-selftest',
    '--agents-selftest',
    '--packaged-smoke',
    '--install-experience-selftest',
  ].some(flag => process.argv.includes(flag))
)
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-selftest-')));
if (process.argv.includes('--cad-install-selftest')) {
  const profile = path.join(process.env.HARNESS_CAD_INSTALL_REPORT_DIR, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

if (process.argv.includes('--chat-selftest') && process.env.INDUSTRIAL_CHAT_SELFTEST_USER_DATA)
  app.setPath('userData', process.env.INDUSTRIAL_CHAT_SELFTEST_USER_DATA);

const desktopRoot = path.resolve(__dirname, '..');
const packManager = new PackManager();
const managedPacks = Boolean(process.env.INDUSTRIAL_HARNESS_PACK_STORE);
let domainMutationActive = false;
let domainController;
let domainOperationDone = Promise.resolve();
let finishDomainOperation;
let domainProgress = null;
let catalogWarning = '';
let catalogState;
const installationJournal = new InstallationJournal(packManager);
function releaseConfig() {
  const file =
    process.env.INDUSTRIAL_HARNESS_PACK_FEED_FILE ||
    path.join(process.resourcesPath, 'pack-feed.json');
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
}
function packCatalog() {
  const config = releaseConfig();
  const keysFile = process.env.INDUSTRIAL_HARNESS_PACK_KEYS_FILE;
  return new PackCatalog({
    directory: packManager.directory,
    url: process.env.INDUSTRIAL_HARNESS_PACK_CATALOG_URL || config.catalogUrl,
    keys: keysFile ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : config.publicKeys,
    channel: config.channel || 'beta',
    bundledDirectory: path.join(process.resourcesPath, 'bootstrap-packs'),
    declaredDomains: require('@zhiman-bj/industrial-domain-packs').consumerMetadata().domains,
  });
}
function currentRegistry() {
  return loadRegistry();
}
function installedDomains() {
  return currentRegistry().domains;
}
async function availablePacks(options = {}) {
  const catalog = packCatalog();
  const packs = await catalog.available(options);
  catalogState = catalog.snapshot();
  catalogWarning = catalogState.state === 'unavailable' ? catalogState.message : '';
  return { manager: catalog.manager, packs, catalog };
}
const artifacts = new Map();
const netlistSessions = new Map();
let activeLayoutToken;
let raster;
let viewerProtocol;
const godotRuntime = new GodotRuntimeManager();
const kicadRuntime = new KiCadRuntimeManager();
const tasks = new TaskService({
  chatDirectory: process.argv.some(flag => flag.endsWith('-selftest'))
    ? path.join(app.getPath('userData'), 'chats')
    : defaultChatDirectory(),
  resourceDirectory: process.argv.some(flag => flag.endsWith('-selftest'))
    ? path.join(app.getPath('userData'), 'resources')
    : undefined,
  contextOptions: contextStoreOptions(),
  runtimeOptions: {
    ...contextStoreOptions(),
    environment: {
      ...process.env,
      INDUSTRIAL_HARNESS_CONFIG_DIR: process.argv.some(flag => flag.endsWith('-selftest'))
        ? path.join(app.getPath('userData'), 'resources')
        : process.env.INDUSTRIAL_HARNESS_CONFIG_DIR,
    },
  },
  packManager: managedPacks ? packManager : null,
  getRegistry: currentRegistry,
  resourcePolicy: project => projectResourcePolicy(project),
  getConfig: entry => runtimeConfig(entry.project, entry.externalServers, entry.id),
  logDirectory: diagnosticDirectory(),
  plugins: () => [guiPlugin()],
  createSession: process.argv.includes('--parallel-selftest')
    ? require('./parallel-selftest.cjs').createSession
    : process.argv.includes('--image-input-selftest')
      ? require('./image-input-selftest.cjs').createSession
      : process.argv.includes('--agent-log-selftest')
        ? require('./agent-log-selftest.cjs').createSession
        : process.argv.includes('--chat-selftest')
          ? require('./chat-selftest.cjs').createSession
          : undefined,
  onChanged: notifySessions,
  onEvent: (event, metadata) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('agent:event', { ...event, ...metadata });
  },
});
const sessions = tasks.sessions;
let contextStore;
let projectDir;
let projectBindings = { projects: [], activeId: null };
let mainWindow;
const coreUpdater = new CoreUpdater({
  updater: app.isPackaged ? require('electron-updater').autoUpdater : null,
  packaged: app.isPackaged,
  configured: !app.isPackaged || releaseConfig().coreUpdateEnabled !== false,
  channel: app.isPackaged ? releaseConfig().channel || 'stable' : 'stable',
  onChange: state => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('update:changed', state);
  },
  canInstall: () => sessions.assertIdle(),
});
let sessionApiKey = '';
let modelRevision = 0;
let appSettings = { guiPluginEnabled: false };
let guiBridge;
const chats = tasks.chats;
let activeChatId;
function chatList() {
  if (tasks.closing) return { chats: [], activeId: null, sessions: [] };
  return {
    chats: activeProject()?.domain
      ? chats.list(projectDir, activeProject().domain).map(chat => {
          const entry = sessions.find(chat.id);
          return {
            ...chat,
            running: sessions.busy(entry),
            awaitingApproval: Boolean(entry?.agent?.pendingApprovals.size),
            awaitingQuestion: Boolean(entry?.agent?.pendingQuestions.size),
          };
        })
      : [],
    activeId: activeChatId || null,
    sessions: sessions.snapshots(),
  };
}
function ensureChat() {
  if (!activeChatId) activeChatId = tasks.newChat(activeProject()).id;
  chats.get(activeChatId, projectDir, activeProject()?.domain);
  return activeChatId;
}
function chatHistory(id, before = null) {
  return tasks.history(activeProject(), id, before);
}
function selectedSession() {
  return tasks.resume(activeProject(), ensureChat());
}

function restoreChatSelection() {
  activeChatId = activeProject()?.domain
    ? chats.list(projectDir, activeProject().domain)[0]?.id
    : undefined;
}
function contextStoreOptions() {
  return process.argv.some(flag => flag.endsWith('-selftest'))
    ? { directory: path.join(app.getPath('userData'), 'state') }
    : {};
}

function sendToMainWindow(channel) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send(channel);
}
function notifySessions() {
  if (tasks.closing) return;
  sendToMainWindow('chat:updated');
}
// Renderer state for the model profile and project bindings is a snapshot
// pulled on demand; mutations must push an invalidation so the UI stays
// coherent even when the change did not originate in the main window.
function notifyModelChanged() {
  sendToMainWindow('model:changed');
}
function notifyProjectsChanged() {
  sendToMainWindow('projects:changed');
}
function diagnosticDirectory() {
  return process.argv.some(flag => flag.endsWith('-selftest'))
    ? path.join(app.getPath('userData'), 'logs')
    : defaultLogDirectory();
}
const diagnosticReader = new DiagnosticReader(diagnosticDirectory());

const resourceSettings = new ResourceSettings(
  process.argv.some(flag => flag.endsWith('-selftest'))
    ? path.join(app.getPath('userData'), 'resources')
    : undefined,
);
const externalRegistry = new ExternalMcpRegistry(path.dirname(resourceSettings.file));
const remoteSettings = new RemoteSettings({ directory: path.dirname(resourceSettings.file) });
const projectRuntimes = tasks.projects;
function resourceCatalog(domain) {
  return baseResourceCatalog(domain, externalRegistry.records());
}
let changingResources = false;
function projectResourcePolicy(project = activeProject()) {
  return resourceSettings.snapshot(resourceCatalog(project?.domain), project?.path).effective;
}

function configDir() {
  return path.join(app.getPath('userData'), 'model');
}
function projectConfigDir() {
  return path.join(app.getPath('userData'), 'workspace');
}
function guiBridgeDir() {
  return path.join(app.getPath('userData'), 'gui-bridge');
}
function activeProject() {
  return projectBindings.projects.find(item => item.id === projectBindings.activeId) || null;
}
function projectSnapshot() {
  return {
    ...projectBindings,
    projects: projectBindings.projects.map(project => ({
      ...project,
      executionLocation: project.domain
        ? remoteSettings.project(project.path, project.domain).location
        : 'local',
    })),
    projectDir: projectDir || null,
  };
}
function clearProjectArtifacts() {
  contextStore?.close();
  contextStore = undefined;
  artifacts.clear();
  netlistSessions.clear();
  activeLayoutToken = undefined;
  godotRuntime.close();
  kicadRuntime.close();
}
function observedContext() {
  const domain = activeProject()?.domain;
  if (!projectDir || !domain) throw Error('Choose a project with a domain first.');
  contextStore ||= new ObservedContextStore(projectDir, domain, contextStoreOptions());
  return contextStore;
}
function keyFile() {
  return path.join(configDir(), 'api-key.bin');
}
function canPersistKey() {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  );
}
function readApiKey() {
  // Local development and selftests can inject a key without the keychain.
  if (process.env.INDUSTRIAL_MODEL_API_KEY) return process.env.INDUSTRIAL_MODEL_API_KEY;
  if (
    [
      '--mcp-selftest',
      '--subagent-selftest',
      '--external-mcp-selftest',
      '--agent-log-selftest',
      '--chat-selftest',
      '--parallel-selftest',
      '--image-input-selftest',
    ].some(flag => process.argv.includes(flag))
  )
    return 'diagnostic-selftest-key';
  if (sessionApiKey) return sessionApiKey;
  if (!canPersistKey() || !fs.existsSync(keyFile())) return '';
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return '';
  }
}
function kimiExecutable() {
  if (process.env.KIMI_EXECUTABLE) return process.env.KIMI_EXECUTABLE;
  return bundledExecutable();
}
// The availability probe spawns the Kimi runtime twice (--version and
// `web --help`) and blocks the main process for roughly a second. Status is
// re-queried on every window focus and model/project broadcast, so cache the
// probe per resolved executable; the runtime binary cannot change while the
// app is running. Failures are not cached — a retry may catch a completed
// setup.
let cachedAgentRuntime;
function agentRuntimeStatus() {
  const executable = kimiExecutable();
  if (cachedAgentRuntime?.executable === executable) return cachedAgentRuntime;
  const script = /\.[cm]?js$/.test(executable);
  const command = script ? process.execPath : executable;
  const prefix = script ? [executable] : [];
  const probeOptions = {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' },
  };
  const result = spawnSync(command, [...prefix, '--version'], probeOptions);
  const help =
    result.status === 0 ? spawnSync(command, [...prefix, 'web', '--help'], probeOptions) : null;
  const available =
    !result.error &&
    result.status === 0 &&
    help?.status === 0 &&
    result.stdout.trim() === KIMI_CODE_VERSION &&
    help.stdout.includes('--no-open');
  const status = {
    executable,
    available,
    version: available ? result.stdout.split('\n')[0].trim() : '',
  };
  if (available) cachedAgentRuntime = status;
  return status;
}
function modelStatus() {
  return {
    ...readProfile(configDir()),
    hasApiKey: Boolean(readApiKey()),
    keyPersisted: canPersistKey() && fs.existsSync(keyFile()),
  };
}
function guiPlugin() {
  if (!guiBridge) {
    // Tool-call records are attributed per chat through the diagnostics
    // pluginLog sink each KimiSession passes into toolsFactory.
    guiBridge = createGuiPlugin({
      enabled: () => appSettings.guiPluginEnabled,
      installedDir: guiBridgeDir(),
    });
  }
  return guiBridge;
}
let guiInstallPromise;
let guiInstallError = '';
function guiBridgeState() {
  const installed = process.env.GUI_BRIDGE_BIN
    ? { state: 'ready' }
    : guiBridgeStatus(guiBridgeDir());
  return {
    enabled: appSettings.guiPluginEnabled,
    install: guiInstallPromise ? 'installing' : guiInstallError ? 'error' : installed.state,
    version: installed.version?.tag || null,
    permissions: guiPermissions(systemPreferences),
    ...(guiInstallError ? { error: guiInstallError } : {}),
  };
}
function guiInstallProgress(phase, detail) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('settings:gui-progress', {
    phase,
    ...(detail && typeof detail === 'object' ? { detail: Object.keys(detail) } : {}),
  });
}
function startGuiInstall() {
  if (guiInstallPromise) return guiInstallPromise;
  guiInstallError = '';
  guiInstallPromise = ensureInstalled(guiBridgeDir(), process.env, guiInstallProgress)
    .catch(error => {
      guiInstallError = String(error);
    })
    .finally(() => {
      guiInstallPromise = undefined;
      guiInstallProgress(guiInstallError ? 'error' : 'ready');
    });
  return guiInstallPromise;
}
function runtimeConfig(project, externalServers, chatId) {
  const profile = readProfile(configDir());
  const apiKey = readApiKey();
  return {
    profile,
    apiKey,
    revision: modelRevision,
    executable: kimiExecutable(),
    shareDir: writeCliConfig(configDir(), profile),
    env: sessionEnv(profile, apiKey),
    disabledMcpServers: projectResourcePolicy(project).mcpServers,
    externalServers,
    approvalMode: chats.get(chatId, project.path, project.domain).approvalMode,
  };
}

function kindFor(file) {
  const kind = viewerRegistry.match(file);
  if (!kind) throw Error('No registered Viewer supports this file.');
  return kind;
}

function projectFile(relative) {
  return resolveProjectFile(projectDir, relative);
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function registerArtifact(entry) {
  const file = fs.realpathSync(entry.file);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw Error('Artifact is not a file.');
  const observed = activeProject()?.domain
    ? await observedContext().observeArtifact({ id: entry.id, kind: entry.kind, file })
    : null;
  const artifact = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    design: entry.design,
    sizeBytes: observed?.sizeBytes ?? stat.size,
    sha256: observed?.sha256 ?? (await digest(file)),
    source: 'project file',
  };
  artifacts.set(entry.id, { artifact, file });
  return artifact;
}

async function checked(id) {
  const entry = artifacts.get(id);
  if (!entry) throw Error('Unknown artifact.');
  if (entry.recorded) {
    if (entry.projectId !== activeProject()?.id) throw Error('Result belongs to another project.');
    await tasks.openResult(selectedSession(), entry.recorded);
  }
  if ((await digest(entry.file)) !== entry.artifact.sha256)
    throw Error('Artifact content changed; reopen the file.');
  return entry;
}

function layoutPython() {
  const selected =
    process.env.KLAYOUT_PYTHON ||
    path.join(
      desktopRoot,
      '.venv-klayout',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
  if (!fs.existsSync(selected))
    throw Error('KLayout Python is unavailable. Set KLAYOUT_PYTHON or run pnpm setup:layout.');
  return selected;
}

function getRaster() {
  if (!raster || raster.failure) {
    raster?.close();
    raster = new RasterService(layoutPython());
  }
  return raster;
}

const viewerRegistry = createViewerRegistry([
  ...require('@industrial-agent-harness/viewer-builtin/runtime/cad').createCadPlugins({
    projectRoot: () => projectDir,
  }),
  ...createEngineeringPlugins({ projectRoot: () => projectDir }),
  ...createAssetPlugins({ projectRoot: () => projectDir }),
  {
    id: 'layout',
    matches: file =>
      ['.gds', '.gdsii', '.oas', '.oasis'].includes(path.extname(file).toLowerCase()),
    open: async ({ artifact, file }) => {
      const token = crypto.randomUUID();
      const data = await getRaster().call({ op: 'load', path: file, token });
      activeLayoutToken = token;
      return { artifact, kind: 'layout', data };
    },
  },
  {
    id: 'netlist',
    matches: isYosysNetlist,
    open: async ({ artifact, file }) => {
      const token = crypto.randomUUID();
      const data = await renderNetlist(file);
      netlistSessions.set(token, file);
      return { artifact, kind: 'netlist', data: { ...data, token } };
    },
  },
  {
    id: 'waveform',
    matches: file => ['.vcd', '.fst', '.ghw'].includes(path.extname(file).toLowerCase()),
    open: async ({ artifact, file }) => ({
      artifact,
      kind: 'waveform',
      data: {
        url: viewerProtocol.registerWave(file),
        name: artifact.name,
        defaultSignals: initialVcdSignals(file),
      },
    }),
  },
  {
    id: 'godot',
    matches: file => isGodotExport(file),
    open: async ({ artifact, file }) => ({
      artifact,
      kind: 'godot',
      data: await godotRuntime.open(file, artifact.sha256),
    }),
  },
  {
    id: 'kicad',
    matches: isKiCadFile,
    open: async ({ artifact, file }) => ({
      artifact,
      kind: 'kicad',
      data: await kicadRuntime.open(file, artifact.sha256, projectDir),
    }),
  },
  // Generic formats are fallbacks; preserve specialized JSON/HTML detection.
  ...createDocumentPlugins({ projectRoot: () => projectDir }),
]);

function registerHandlers() {
  ipcMain.on('window:minimize', event => {
    if (event.sender === mainWindow?.webContents) mainWindow?.minimize();
  });
  ipcMain.on('window:maximize-toggle', event => {
    if (event.sender !== mainWindow?.webContents || !mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window:close', event => {
    if (event.sender === mainWindow?.webContents) mainWindow?.close();
  });
  function diagnosticProject(event, request) {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      !projectDir ||
      request?.projectId !== activeProject()?.id
    )
      throw Error('Diagnostic logs belong to the selected project.');
    return projectDir;
  }
  async function diagnosticRequest(method, event, request) {
    const project = diagnosticProject(event, request);
    const result = await diagnosticReader[method](project, request);
    if (activeProject()?.id !== request.projectId || projectDir !== project)
      throw Error('Selected project changed; reopen agent logs.');
    return result;
  }
  ipcMain.handle('agent:log-runs', (event, request) => diagnosticRequest('list', event, request));
  ipcMain.handle('agent:log-page', (event, request) => diagnosticRequest('page', event, request));
  ipcMain.handle('agent:log-view', (event, request) => diagnosticRequest('view', event, request));
  ipcMain.handle('agent:log-detail', (event, request) =>
    diagnosticRequest('detail', event, request),
  );
  ipcMain.handle('agent:log-record', (event, request) =>
    diagnosticRequest('record', event, request),
  );
  ipcMain.handle('broker:domains', () => installedDomains());
  ipcMain.handle('update:status', () => coreUpdater.snapshot());
  ipcMain.handle('update:check', () => coreUpdater.check());
  ipcMain.handle('update:install', () => coreUpdater.install());
  ipcMain.handle('domains:status', () => ({
    managed: managedPacks,
    catalogWarning,
    catalog: catalogState || packCatalog().snapshot(),
    lastOperation: installationJournal.snapshot()?.active ? null : installationJournal.snapshot(),
    operation: domainMutationActive
      ? {
          active: true,
          progress: domainProgress,
          source: 'desktop',
          cancellable: Boolean(domainController),
        }
      : installationJournal.snapshot()?.active
        ? { ...installationJournal.snapshot(), source: 'external', cancellable: false }
        : null,
    installed: managedPacks
      ? packManager.list().map(item => describeInstalled(packManager, item))
      : installedDomains().map(item => ({
          domain: item.id,
          version: 'development',
          label: item.label,
          emoji: item.emoji,
        })),
    errors: managedPacks ? packManager.scan().errors : [],
  }));
  ipcMain.handle('domains:available', async () => {
    if (!managedPacks) return [];
    const { packs, catalog } = await availablePacks();
    return catalog.summaries(packs);
  });
  ipcMain.handle('domains:cancel', async () => {
    const cancelled = Boolean(domainController);
    domainController?.abort(Error('Domain preparation cancelled.'));
    await domainOperationDone;
    return { cancelled };
  });
  ipcMain.handle('domains:install', async (_event, request) => {
    if (!managedPacks) throw Error('Domain installation is available in managed builds.');
    if (
      !Array.isArray(request?.domains) ||
      !request.domains.length ||
      request.domains.length > 20 ||
      new Set(request.domains).size !== request.domains.length ||
      request.domains.some(id => typeof id !== 'string')
    )
      throw Error('Choose one or more distinct Domains.');
    sessions.assertIdle();
    if (domainMutationActive) throw Error('Domain preparation is already in progress.');
    installationJournal.begin(request.domains || [request.domain]);
    domainMutationActive = true;
    domainOperationDone = new Promise(resolve => {
      finishDomainOperation = resolve;
    });
    domainController = new AbortController();
    domainProgress = null;
    try {
      await sessions.reset();
      await projectRuntimes.close();
      const { manager, packs } = await availablePacks({ signal: domainController.signal });
      const selected = request.domains.map(id => {
        const item = packs.find(pack => pack.domain === id);
        if (!item) throw Error(`Domain is unavailable for this platform: ${id}`);
        return item;
      });
      for (const item of selected)
        await manager.install(item, {
          prepareRuntime: true,
          signal: domainController.signal,
          onProgress: progress => {
            domainProgress = { domain: item.domain, ...progress };
            installationJournal.progress(domainProgress);
            if (!_event.sender.isDestroyed())
              _event.sender.send('domains:progress', { domain: item.domain, ...progress });
          },
        });
      installationJournal.finish('completed');
      return { installed: installedDomains() };
    } catch (error) {
      installationJournal.finish(domainController.signal.aborted ? 'cancelled' : 'failed', error);
      throw error;
    } finally {
      domainMutationActive = false;
      domainController = undefined;
      domainProgress = null;
      finishDomainOperation?.();
      finishDomainOperation = undefined;
      const sender = _event.sender;
      if (!sender.isDestroyed())
        sender.send('domains:progress', {
          domain: '',
          label: '',
          phase: 'finished',
          active: false,
          outcome: installationJournal.snapshot()?.outcome,
          error: installationJournal.snapshot()?.error,
        });
    }
  });
  ipcMain.handle('domains:repair', async (event, request) => {
    if (!managedPacks || typeof request?.domain !== 'string') throw Error('Invalid Domain repair.');
    sessions.assertIdle();
    if (domainMutationActive) throw Error('Domain preparation is already in progress.');
    installationJournal.begin([request.domain], 'repair');
    domainMutationActive = true;
    domainOperationDone = new Promise(resolve => {
      finishDomainOperation = resolve;
    });
    domainController = new AbortController();
    domainProgress = null;
    try {
      await sessions.reset();
      await projectRuntimes.close();
      packManager.assertIdle(request.domain);
      const bundle = packManager.list().find(item => item.domain === request.domain);
      if (!bundle) throw Error('Domain is not installed.');
      await packManager.runtimeAssets.ensure(bundle.runtimeAssets, {
        recheck: true,
        signal: domainController.signal,
        onProgress: progress => {
          domainProgress = { domain: request.domain, ...progress };
          installationJournal.progress(domainProgress);
          if (!event.sender.isDestroyed())
            event.sender.send('domains:progress', { domain: request.domain, ...progress });
        },
      });
      installationJournal.finish('completed');
      return { installed: installedDomains() };
    } catch (error) {
      installationJournal.finish(domainController.signal.aborted ? 'cancelled' : 'failed', error);
      throw error;
    } finally {
      domainMutationActive = false;
      domainController = undefined;
      domainProgress = null;
      finishDomainOperation?.();
      finishDomainOperation = undefined;
      const sender = event.sender;
      if (!sender.isDestroyed())
        sender.send('domains:progress', {
          domain: '',
          label: '',
          phase: 'finished',
          active: false,
          outcome: installationJournal.snapshot()?.outcome,
          error: installationJournal.snapshot()?.error,
        });
    }
  });
  ipcMain.handle('domains:remove', async (_event, request) => {
    if (!managedPacks || typeof request?.domain !== 'string')
      throw Error('Invalid Domain removal.');
    sessions.assertIdle();
    if (domainMutationActive) throw Error('Domain preparation is already in progress.');
    if (projectBindings.projects.some(project => project.domain === request.domain))
      throw Error('A Project still uses this Domain.');
    installationJournal.begin([request.domain], 'remove');
    domainMutationActive = true;
    domainOperationDone = new Promise(resolve => {
      finishDomainOperation = resolve;
    });
    try {
      await sessions.reset();
      await projectRuntimes.close();
      packManager.remove(request.domain);
      installationJournal.finish('completed');
      return { installed: installedDomains() };
    } catch (error) {
      installationJournal.finish('failed', error);
      throw error;
    } finally {
      domainMutationActive = false;
      finishDomainOperation?.();
      finishDomainOperation = undefined;
      if (!_event.sender.isDestroyed())
        _event.sender.send('domains:progress', {
          asset: '',
          label: '',
          phase: 'finished',
          active: false,
          outcome: installationJournal.snapshot()?.outcome,
          error: installationJournal.snapshot()?.error,
        });
    }
  });
  ipcMain.handle('resource:catalog', () => resourceCatalog(activeProject()?.domain));
  ipcMain.handle('broker:resolve', async (event, request) => {
    chatRequest(event);
    if (changingResources) throw Error('Resource settings are being saved.');
    if (request?.chatId && request.chatId !== activeChatId)
      throw Error('Selected chat changed; retry the task.');
    const entry = selectedSession();
    return tasks.prepare(entry, request);
  });
  function loadDetail(capabilityId, entry = selectedSession()) {
    return tasks.detail(entry, capabilityId);
  }
  ipcMain.handle('broker:detail', (_event, capabilityId) => loadDetail(capabilityId));
  ipcMain.handle('broker:trace', () => selectedSession().trace);
  ipcMain.handle('model:get', () => modelStatus());
  ipcMain.handle('settings:gui-state', () => guiBridgeState());
  ipcMain.handle('settings:gui-permission-settings', async (event, permission) => {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw Error('Settings require the main app window.');
    await shell.openExternal(guiPermissionSettingsUrl(permission));
  });
  ipcMain.handle('settings:set-gui', (event, { enabled }) => {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw Error('Settings require the main app window.');
    if (typeof enabled !== 'boolean') throw Error('Invalid desktop control setting.');
    appSettings = { ...appSettings, guiPluginEnabled: Boolean(enabled) };
    saveSettings(configDir(), appSettings);
    // Enabling is the authorization. No live session is torn down here:
    // KimiSession detects the changed plugin set (plugins_changed) and rebuilds
    // itself on the next run of each chat.
    if (appSettings.guiPluginEnabled) void startGuiInstall();
    return guiBridgeState();
  });
  ipcMain.handle('model:save', async (_event, request) => {
    if (changingResources) throw Error('Settings are being saved.');
    sessions.assertIdle();
    const profile = validateProfile(request);
    if (
      request.apiKey !== undefined &&
      (typeof request.apiKey !== 'string' || request.apiKey.length > 8192)
    )
      throw Error('Invalid API key.');
    changingResources = true;
    try {
      await sessions.reset();
      saveProfile(configDir(), profile);
      if (request.apiKey) {
        sessionApiKey = request.apiKey.trim();
        if (canPersistKey()) {
          fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
          fs.writeFileSync(keyFile(), safeStorage.encryptString(sessionApiKey), { mode: 0o600 });
          fs.chmodSync(keyFile(), 0o600);
        }
      }
      if (request.clearApiKey) {
        sessionApiKey = '';
        fs.rmSync(keyFile(), { force: true });
      }
      writeCliConfig(configDir(), profile);
      modelRevision++;
      notifyModelChanged();
      return modelStatus();
    } finally {
      changingResources = false;
    }
  });
  ipcMain.handle('agent:status', () => {
    if (
      [
        '--mcp-selftest',
        '--subagent-selftest',
        '--external-mcp-selftest',
        '--agent-log-selftest',
        '--chat-selftest',
        '--parallel-selftest',
        '--image-input-selftest',
      ].some(flag => process.argv.includes(flag))
    )
      return { available: true, version: 'SDK seam selftest', projectDir, configured: true };
    const runtime = agentRuntimeStatus();
    return {
      available: runtime.available,
      version: runtime.version,
      projectDir: projectDir || null,
      configured: Boolean(readApiKey()),
      gui: guiBridgeState(),
    };
  });
  ipcMain.handle('project:bindings', () => projectSnapshot());
  ipcMain.handle('project:set-domain', async (_event, request) => {
    const { id, domain } = request || {};
    if (!installedDomains().some(item => item.id === domain)) throw Error('Unknown domain.');
    const project = projectBindings.projects.find(item => item.id === id);
    if (!project) throw Error('Unknown project.');
    if (id !== projectBindings.activeId)
      throw Error('Open this project before changing its domain.');
    if (project.domain === domain) return projectSnapshot();
    if (changingResources) throw Error('Settings are being saved.');
    sessions.assertIdle(project.id);
    changingResources = true;
    try {
      await sessions.reset(project.id);
      project.domain = domain;
      if (activeProject()?.id === project.id) {
        clearProjectArtifacts();
        activeChatId = undefined;
      }
      saveBindings(projectConfigDir(), projectBindings);
      notifyProjectsChanged();
      return projectSnapshot();
    } finally {
      changingResources = false;
    }
  });
  function resourceProject(event, request) {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw Error('Resource settings require the main app window.');
    if (
      request?.projectId !== undefined &&
      (!activeProject() || request.projectId !== activeProject().id)
    )
      throw Error('Open this project before configuring resources.');
    return request?.projectId !== undefined ? activeProject() : null;
  }
  function executionProject(event, request) {
    const project = resourceProject(event, request);
    if (!project?.domain) throw Error('Choose a project with a domain.');
    return project;
  }
  ipcMain.handle('remote:service', event => {
    resourceProject(event, {});
    return remoteSettings.view();
  });
  ipcMain.handle('remote:check', async event => {
    resourceProject(event, {});
    return remoteSettings.check();
  });
  ipcMain.handle('remote:project', async (event, request) => {
    const project = executionProject(event, request);
    const binding = remoteSettings.project(project.path, project.domain);
    if (remoteSettings.view().status === 'unchecked') await remoteSettings.check();
    return {
      location: binding.location,
      files: binding.files || [],
      syncedAt: binding.syncedAt || null,
      task: remoteSettings.task(project.path, project.domain),
      service: remoteSettings.view(),
    };
  });
  ipcMain.handle('remote:files', (event, request) => {
    const project = executionProject(event, request);
    return remoteSettings.candidates(project.path);
  });
  async function executionChange(event, request, operation) {
    const project = executionProject(event, request);
    if (changingResources) throw Error('Settings are being saved.');
    sessions.assertIdle(project.id);
    changingResources = true;
    try {
      await sessions.reset(project.id);
      await projectRuntimes.reset(project);
      const result = await operation(project);
      notifySessions();
      return result;
    } finally {
      changingResources = false;
    }
  }
  ipcMain.handle('remote:set-location', (event, request) =>
    executionChange(event, request, project => {
      remoteSettings.setLocation(project.path, project.domain, request.location);
      return projectSnapshot();
    }),
  );
  ipcMain.handle('remote:review', (event, request) =>
    executionChange(event, request, project =>
      remoteSettings.review(project.path, project.domain, request.files),
    ),
  );
  ipcMain.handle('remote:sync', (event, request) =>
    executionChange(event, request, async project => {
      await remoteSettings.sync(project.path, project.domain, request.reviewId);
      return projectSnapshot();
    }),
  );
  ipcMain.handle('remote:task', async (event, request) => {
    const project = executionProject(event, request);
    return remoteSettings.refreshTask(project.path, project.domain);
  });
  ipcMain.handle('remote:cancel', async (event, request) => {
    const project = executionProject(event, request);
    return remoteSettings.cancelTask(project.path, project.domain, request);
  });
  ipcMain.handle('resource:get', (event, request) => {
    const project = resourceProject(event, request);
    return resourceSettings.snapshot(resourceCatalog(project?.domain), project?.path);
  });
  ipcMain.handle('agent-profiles:list', (event, request) => {
    const project = resourceProject(event, request);
    return tasks.agentCatalog(project);
  });
  ipcMain.handle('agent-profiles:save', (event, request) => {
    resourceProject(event, {});
    const agent = tasks.saveAgent(request);
    notifySessions();
    return agent;
  });
  ipcMain.handle('agent-profiles:delete', (event, request) => {
    resourceProject(event, {});
    tasks.agents.remove(request?.id);
    notifySessions();
  });
  ipcMain.handle('project:set-agent', (event, request) => {
    const project = executionProject(event, request);
    const catalog = tasks.setProjectAgent(project, request.agentId);
    notifyProjectsChanged();
    return catalog;
  });
  ipcMain.handle('chat:set-agent', (event, request) => {
    chatRequest(event);
    if (request?.chatId !== activeChatId)
      throw Error('Agent selection belongs to the selected chat.');
    return tasks.setChatAgent(activeProject(), request.chatId, request.agentId);
  });
  async function setResource(event, request) {
    const project = resourceProject(event, request);
    if (changingResources) throw Error('Resource settings are being saved.');
    sessions.assertIdle(project?.id);
    changingResources = true;
    try {
      await sessions.reset(project?.id);
      resourceProject(event, request);
      const snapshot = resourceSettings.set(
        resourceCatalog(project?.domain),
        request,
        project?.path,
      );
      return snapshot;
    } finally {
      changingResources = false;
    }
  }
  ipcMain.handle('resource:set', setResource);
  ipcMain.handle('external-mcp:list', event => {
    resourceProject(event, {});
    return externalRegistry.list();
  });
  async function externalChange(event, request, operation) {
    resourceProject(event, {});
    if (changingResources) throw Error('Resource settings are being saved.');
    sessions.assertIdle();
    changingResources = true;
    try {
      await sessions.reset();
      await projectRuntimes.close();
      if (operation === 'add') return await externalRegistry.add(request?.configuration);
      if (typeof request?.id !== 'string') throw Error('Choose an external MCP service.');
      return operation === 'refresh'
        ? await externalRegistry.refresh(request.id)
        : externalRegistry.remove(request.id);
    } finally {
      changingResources = false;
    }
  }
  ipcMain.handle('external-mcp:add', (event, request) => externalChange(event, request, 'add'));
  ipcMain.handle('external-mcp:refresh', (event, request) =>
    externalChange(event, request, 'refresh'),
  );
  ipcMain.handle('external-mcp:remove', (event, request) =>
    externalChange(event, request, 'remove'),
  );
  ipcMain.handle('project:set-resource', async (event, request) => {
    if (!request?.projectId || typeof request?.enabled !== 'boolean')
      throw Error('Invalid project resource change.');
    await setResource(event, { ...request, mode: request.enabled ? 'enabled' : 'disabled' });
    notifyProjectsChanged();
    return projectSnapshot();
  });
  ipcMain.handle('project:select', async (_event, id) => {
    const item = projectBindings.projects.find(candidate => candidate.id === id);
    if (!item) throw Error('Unknown project.');
    const actual = fs.realpathSync(item.path);
    if (!fs.statSync(actual).isDirectory()) throw Error('Project directory is unavailable.');
    projectBindings.activeId = id;
    projectDir = actual;
    clearProjectArtifacts();
    restoreChatSelection();
    saveBindings(projectConfigDir(), projectBindings);
    notifyProjectsChanged();
    return projectSnapshot();
  });
  ipcMain.handle('project:choose-directory', async (_event, locale) => {
    const selectedLocale =
      typeof locale === 'string' && Object.hasOwn(languageConfig.locales, locale)
        ? locale
        : languageConfig.fallbackLocale;
    const titles = languageConfig.messages['Choose engineering project'];
    const result = await dialog.showOpenDialog({
      title: titles[selectedLocale] ?? titles[languageConfig.fallbackLocale],
      properties: ['openDirectory'],
    });
    return result.canceled ? null : fs.realpathSync(result.filePaths[0]);
  });
  ipcMain.handle('project:create', async (_event, request) => {
    if (!request || !installedDomains().some(item => item.id === request.domain))
      throw Error('Choose a valid project domain.');
    if (typeof request.directory !== 'string' || typeof request.name !== 'string')
      throw Error('Invalid project details.');
    const next = addBinding(projectBindings, request.directory, request.domain, request.name);
    projectBindings = next;
    projectDir = activeProject().path;
    activeChatId = undefined;
    clearProjectArtifacts();
    saveBindings(projectConfigDir(), projectBindings);
    notifyProjectsChanged();
    return projectSnapshot();
  });
  ipcMain.handle('agent:new', (event, request) => {
    chatRequest(event);
    activeChatId = tasks.newChat(activeProject(), {
      agentId: request?.agentId,
      preferredId: activeChatId,
    }).id;
    notifySessions();
    return chatHistory(activeChatId);
  });
  function chatRequest(event) {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw Error('Chats require the main app window.');
    if (!activeProject()?.domain) throw Error('Choose a project with a domain.');
  }
  ipcMain.handle('chat:list', event => {
    chatRequest(event);
    return chatList();
  });
  ipcMain.handle('chat:history', (event, request) => {
    chatRequest(event);
    const history = chatHistory(request.id, request.before || null);
    return process.argv.includes('--parallel-selftest')
      ? require('./parallel-selftest.cjs').historyResponse(history)
      : history;
  });
  ipcMain.handle('chat:select', (event, id) => {
    chatRequest(event);
    const history = chatHistory(id);
    activeChatId = id;
    return history;
  });
  ipcMain.handle('chat:set-approval-mode', (event, request) => {
    chatRequest(event);
    const project = activeProject();
    if (request?.projectId !== project.id || request?.chatId !== activeChatId)
      throw Error('Approval mode belongs to the selected chat.');
    if (sessions.busy(sessions.find(request.chatId)))
      throw Error('Stop this chat before changing approval mode.');
    const mode = chats.setApprovalMode(request.chatId, project.path, project.domain, request.mode);
    notifySessions();
    return mode;
  });
  ipcMain.handle('chat:delete', async (event, id) => {
    chatRequest(event);
    chats.get(id, projectDir, activeProject().domain);
    const project = activeProject();
    await sessions.remove(project, id);
    chats.remove(id, project.path, project.domain);
    if (id === activeChatId) activeChatId = undefined;
    notifySessions();
    return chatList();
  });
  ipcMain.handle('project:list', () =>
    listProjectFiles(projectDir, { includeBuildDirectories: activeProject()?.domain === 'godot' }),
  );
  ipcMain.handle('project:open', async (_event, relative) => {
    const file = projectFile(relative);
    return registerArtifact({
      id: crypto.randomUUID(),
      kind: kindFor(file),
      name: path.basename(file),
      design: path.basename(projectDir),
      file,
    });
  });
  ipcMain.handle('result:reveal', async (event, request) => {
    chatRequest(event);
    if (request?.chatId !== activeChatId) throw Error('Open the chat containing this result.');
    const { file } = await tasks.openResult(selectedSession(), { ...request, revealOnly: true });
    shell.showItemInFolder(file);
  });
  ipcMain.handle('result:open', async (event, request) => {
    chatRequest(event);
    if (request?.chatId !== activeChatId) throw Error('Open the chat containing this result.');
    const entry = selectedSession();
    const { artifact: recorded, file } = await tasks.openResult(entry, request);
    let kind = null;
    try {
      kind = viewerRegistry.match(file);
    } catch {}
    const source = readSourcePreview(file, recorded.relativePath, kind);
    if (request.previewOnly && (!kind || !viewerRegistry.canAutoPreview(file)))
      throw Error('No embedded Viewer is available for this result. Use its file entry.');
    if (!kind) return { path: recorded.relativePath, name: path.basename(file), source };
    const artifact = {
      id: recorded.id,
      kind,
      name: path.basename(file),
      design: path.basename(projectDir),
      sizeBytes: recorded.sizeBytes,
      sha256: recorded.sha256,
      source: 'project file',
    };
    artifacts.set(artifact.id, {
      artifact,
      file,
      recorded: request,
      projectId: activeProject().id,
    });
    return { path: recorded.relativePath, name: path.basename(file), artifact };
  });
  ipcMain.handle('project:read', (_event, relative) => {
    const file = projectFile(relative);
    let viewer = null;
    try {
      viewer = kindFor(file);
    } catch {}
    return readSourcePreview(file, relative, viewer);
  });
  function imageRequest(event, request) {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      !activeProject() ||
      request?.projectId !== activeProject().id
    )
      throw Error('Images belong to the selected project.');
    const images = validatePromptImages(request.images);
    for (const image of images) {
      // Electron nativeImage decodes PNG/JPEG only. WebP is decoded by Chromium
      // before upload; the shared validator independently bounds its header.
      if (image.mime === 'image/webp') continue;
      const decoded = nativeImage.createFromBuffer(
        Buffer.from(image.dataUrl.split(',')[1], 'base64'),
      );
      const size = decoded.getSize();
      if (
        decoded.isEmpty() ||
        !size.width ||
        !size.height ||
        size.width > 8192 ||
        size.height > 8192 ||
        size.width * size.height !== image.width * image.height
      )
        throw Error('This image is corrupt or cannot be decoded.');
    }
    return images;
  }
  ipcMain.handle('agent:validate-images', (event, request) => imageRequest(event, request));
  ipcMain.handle('agent:run', async (event, request) => {
    if (domainMutationActive) throw Error('Finish preparing domains before starting a task.');
    chatRequest(event);
    if (changingResources) throw Error('Resource settings are being saved.');
    if (request?.chatId && request.chatId !== activeChatId)
      throw Error('Selected chat changed; retry the task.');
    const entry = selectedSession();
    const task = typeof request === 'string' ? request : request?.task;
    const images =
      typeof request === 'string' || request?.images === undefined
        ? []
        : imageRequest(event, request);
    if (images.length && !readProfile(configDir()).imageInput)
      throw Error('Enable Image input in Model API settings for a model that supports images.');
    if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task, 'utf8') > 128 * 1024)
      throw Error('Describe the task first.');
    if (!entry.scope || entry.resolvedRequest?.task !== task)
      throw Error('Resolve this task in the current chat first.');
    if (sessions.busy(entry)) throw Error('This chat is already running.');
    const { completion, ...started } = await tasks.start(entry, task, { images });
    void completion.catch(error => console.error('Chat finalization failed:', error.message));
    return started;
  });
  ipcMain.handle('agent:approve', (event, { id, response, chatId }) => {
    chatRequest(event);
    if (chatId && chatId !== activeChatId) throw Error('Open the chat that requested approval.');
    const entry = selectedSession();
    if (!entry.agent) throw Error('No active approval.');
    return tasks.approve(entry, id, response);
  });
  ipcMain.handle('agent:answer-question', (event, { id, answers, chatId }) => {
    chatRequest(event);
    if (chatId && chatId !== activeChatId) throw Error('Open the chat that asked this question.');
    const entry = selectedSession();
    if (!entry.agent) throw Error('No active question.');
    return tasks.answer(entry, id, answers);
  });
  ipcMain.handle('agent:interrupt', (event, request) => {
    chatRequest(event);
    if (request?.chatId && request.chatId !== activeChatId)
      throw Error('Open the chat to stop it.');
    return tasks.cancel(selectedSession());
  });
  ipcMain.handle('viewer:open', async (_event, { artifactId }) => {
    const { artifact, file } = await checked(artifactId);
    const plugin = viewerRegistry.get(artifact.kind);
    if (!plugin) throw Error('Viewer plugin unavailable.');
    return plugin.open({ artifact, file });
  });
  ipcMain.handle('viewer:external-open', async (event, { artifactId } = {}) => {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw Error('External open is only available from the workspace.');
    const { artifact, file } = await checked(artifactId);
    if (
      artifact.kind !== 'engineering' ||
      !['.res', '.obj', '.gltf', '.glb', '.step', '.stp', '.wrl'].includes(
        path.extname(file).toLowerCase(),
      )
    )
      throw Error('This artifact has no external viewer action.');
    if (!projectDir || !file.startsWith(projectDir + path.sep) || fs.realpathSync(file) !== file)
      throw Error('Artifact is outside the selected project.');
    const error = await shell.openPath(file);
    if (error) throw Error(`Could not open the system application: ${error}`);
    return { launched: true };
  });
  ipcMain.handle('viewer:render', (_event, request) => {
    if (request?.token !== activeLayoutToken)
      throw Error('Layout artifact changed; reopen this view.');
    return getRaster().call({ ...request, op: 'render' });
  });
  ipcMain.handle('viewer:netlist', async (_event, request) => {
    const file = netlistSessions.get(request?.token);
    if (!file) throw Error('Unknown netlist view.');
    return renderNetlist(file, request.module, request.focus);
  });
}

async function createWindow() {
  if (process.argv.includes('--agents-selftest'))
    require('./agents-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--gui-settings-selftest'))
    require('./gui-settings-selftest.cjs').prepare();
  if (process.argv.includes('--ui-selftest'))
    require('./ui-selftest.cjs').prepare(projectConfigDir(), chats);
  if (process.argv.includes('--messages-selftest'))
    require('./messages-selftest.cjs').prepare(projectConfigDir(), chats);
  if (process.argv.includes('--task-results-selftest'))
    await require('./task-results-selftest.cjs').prepare(projectConfigDir(), configDir());
  if (process.argv.includes('--subagent-selftest'))
    await require('./subagent-selftest.cjs').prepare(projectConfigDir(), configDir());
  if (process.argv.includes('--mcp-selftest'))
    await require('./mcp-selftest.cjs').prepare(projectConfigDir(), configDir());
  if (process.argv.includes('--external-mcp-selftest'))
    await require('./external-mcp-selftest.cjs').prepare(
      projectConfigDir(),
      configDir(),
      path.dirname(resourceSettings.file),
    );
  appSettings = readSettings(configDir());
  // A previously enabled plugin whose install never completed (offline first
  // run, failed upgrade) must not stay durably enabled with no binary: retry
  // on every startup until it lands. Progress reaches the Settings panel.
  if (
    appSettings.guiPluginEnabled &&
    !process.env.GUI_BRIDGE_BIN &&
    guiBridgeStatus(guiBridgeDir()).state !== 'ready'
  )
    void startGuiInstall();
  if (process.argv.includes('--documents-selftest'))
    require('./documents-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--language-selftest'))
    require('./language-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--engineering-selftest'))
    require('./engineering-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--cad-selftest') || process.argv.includes('--cad-resize-selftest'))
    await require('./cad-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--parallel-selftest'))
    require('./parallel-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--image-input-selftest'))
    require('./image-input-selftest.cjs').prepare(projectConfigDir(), configDir());
  if (process.argv.includes('--chat-selftest'))
    require('./chat-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--agent-log-selftest'))
    require('./agent-log-selftest.cjs').prepare(projectConfigDir(), diagnosticDirectory());
  if (process.argv.includes('--kicad-selftest'))
    require('./kicad-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--godot-selftest'))
    require('./godot-selftest.cjs').prepare(projectConfigDir());
  projectBindings = readBindings(
    projectConfigDir(),
    path.resolve(desktopRoot, '../../examples/chip-sobel'),
  );
  resourceSettings.migrate(projectBindings.projects);
  projectDir = activeProject()?.path;
  restoreChatSelection();
  viewerProtocol = createViewerProtocol(desktopRoot);
  protocol.handle('app', request => {
    const host = new URL(request.url).hostname;
    if (host === 'godot') return godotRuntime.handle(request);
    if (host === 'kicad') return kicadRuntime.handle(request);
    return viewerProtocol.handle(request);
  });
  registerHandlers();
  const productIcon = path.join(desktopRoot, 'dist', 'app-icon.png');
  if (fs.existsSync(productIcon)) app.dock?.setIcon(productIcon);
  const window = new BrowserWindow({
    show: !process.argv.includes('--gui-settings-selftest'),
    ...require('./window-bounds.cjs').windowBounds(screen.getPrimaryDisplay().workArea),
    backgroundColor: '#0c1218',
    title: 'Industrial Agent Harness',
    icon: productIcon,
    // Frameless: the renderer draws its own top bars and drag regions. macOS
    // keeps the native traffic lights; other platforms get in-page controls.
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    trafficLightPosition: { x: 20, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Pixel assertions must keep receiving frames when another test app or
      // a hosted desktop temporarily covers this window.
      backgroundThrottling: !process.argv.some(
        flag => flag.endsWith('-selftest') || flag === '--packaged-smoke',
      ),
    },
  });
  if (process.argv.includes('--cad-selftest') || process.argv.includes('--cad-resize-selftest'))
    window.webContents.on('console-message', event =>
      fs.writeSync(2, 'CAD renderer: ' + event.message + '\n'),
    );
  mainWindow = window;
  const fitDisplay = () => {
    const bounds = require('./window-bounds.cjs').windowBounds(
      screen.getDisplayMatching(window.getBounds()).workArea,
      window.getBounds(),
    );
    window.setMinimumSize(bounds.minWidth, bounds.minHeight);
    if (!window.isFullScreen() && !window.isMaximized()) {
      const { minWidth, minHeight, ...frame } = bounds;
      window.setBounds(frame);
    }
  };
  screen.on('display-metrics-changed', fitDisplay);
  screen.on('display-removed', fitDisplay);
  window.on('closed', () => {
    screen.removeListener('display-metrics-changed', fitDisplay);
    screen.removeListener('display-removed', fitDisplay);
  });
  if (process.env.INDUSTRIAL_DEV_URL) await window.loadURL(process.env.INDUSTRIAL_DEV_URL);
  else await window.loadURL('app://viewer/index.html');
  if (process.argv.includes('--cad-install-selftest')) {
    await require('./selftest-language.cjs').setLanguage(window, 'en');
    await require('./cad-install-selftest.cjs').run(window, {
      manager: packManager,
      runtime: () => projectRuntimes.get(activeProject(), currentRegistry()).runtime,
    });
    app.quit();
    return;
  }
  if (process.argv.includes('--install-experience-selftest')) {
    await require('./install-experience-selftest.cjs').run(window, { manager: packManager });
    app.quit();
    return;
  }
  if (process.argv.includes('--packaged-smoke')) {
    if (!app.isPackaged) throw Error('Packaged smoke requires an installed app.');
    await require('./selftest-language.cjs').setLanguage(window, 'en');
    async function waitFor(script, timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        let ready;
        try {
          ready = await window.webContents.executeJavaScript(script);
        } catch (error) {
          throw Error(`Packaged Domain smoke script failed: ${script}: ${error}`);
        }
        if (ready) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const state = await window.webContents.executeJavaScript(
        `JSON.stringify({rows: Array.from(document.querySelectorAll('.ia-domain-install-row')).map(row => ({text: row.textContent, checked: row.querySelector('input')?.checked, disabled: row.querySelector('input')?.disabled})), cards: Array.from(document.querySelectorAll('.ia-pack-card')).map(card => ({title: card.querySelector('.ia-pack-title b')?.textContent, action: card.querySelector('.ia-pack-action')?.textContent, disabled: card.querySelector('.ia-pack-action')?.disabled})), primary: document.querySelector('.ia-domains-primary')?.textContent, primaryDisabled: document.querySelector('.ia-domains-primary')?.disabled, errors: Array.from(document.querySelectorAll('[role="alert"]')).map(node => node.textContent)})`,
      );
      throw Error(`Packaged Domain smoke timed out: ${script}; state=${state}`);
    }
    async function click(script) {
      const error = await window.webContents.executeJavaScript(
        `(() => {try {${script}; return null;} catch (error) {return String(error);}})()`,
      );
      if (error) throw Error(`Packaged Domain smoke click failed: ${script}: ${error}`);
    }
    await waitFor(
      `Boolean(document.querySelector('.ia-domains-modal')) && window.viewerHost.domainStatus().then(status => status.managed && status.installed.length === 0)`,
    );
    const { packs: offered } = await availablePacks();
    const offeredDomains = offered.map(item => item.domain).sort();
    await waitFor(
      `JSON.stringify(Array.from(document.querySelectorAll('.ia-domain-install-row:not([data-unavailable])')).map(row => row.dataset.domain).sort()) === ${JSON.stringify(JSON.stringify(offeredDomains))} && document.querySelector('.ia-domains-actions button')?.disabled === false`,
    );
    const knownDomains = [
      ...offeredDomains,
      ...catalogState.unavailableDomains.map(item => item.domain),
    ].sort();
    await waitFor(
      `JSON.stringify(Array.from(document.querySelectorAll('.ia-domain-install-row')).map(row => row.dataset.domain).sort()) === ${JSON.stringify(JSON.stringify(knownDomains))}`,
    );
    console.log(
      JSON.stringify({
        firstRunDomains: knownDomains,
        installableDomains: offeredDomains,
        catalog: catalogState.state,
      }),
    );
    if (process.env.HARNESS_PACKAGED_SMOKE_FEED_DIR) {
      const planned = JSON.parse(process.env.HARNESS_PACKAGED_SMOKE_DOMAINS || '[]');
      if (!planned.length || planned.some(item => !item.id || !item.label))
        throw Error('Packaged smoke requires an explicit platform-qualified install plan.');
      await waitFor(
        `document.querySelectorAll('.ia-domain-install-row').length >= ${planned.length}`,
      );
      const initial = planned.slice(0, 2);
      let installed = 0;
      async function installInitial(items) {
        await click(
          `for (const name of ${JSON.stringify(items.map(item => item.label))}) Array.from(document.querySelectorAll('.ia-domain-install-row')).find(row => row.textContent.includes(name)).querySelector('input').click()`,
        );
        await waitFor(
          `document.querySelector('.ia-domains-primary')?.textContent.includes('${items.length}') && !document.querySelector('.ia-domains-primary').disabled`,
        );
        await click(`document.querySelector('.ia-domains-primary').click()`);
        installed += items.length;
        await waitFor(
          `window.viewerHost.domainStatus().then(status => status.installed.length === ${installed} && Boolean(document.querySelector('.ia-domain-setup [data-action="done"]')))`,
          20 * 60 * 1000,
        );
        await click(`document.querySelector('.ia-domain-setup [data-action="done"]').click()`);
        await waitFor(`!document.querySelector('.ia-domains-modal')`);
      }
      await installInitial(initial);
      for (const item of planned.slice(initial.length)) {
        if (
          !(await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.ia-capability'))`,
          ))
        ) {
          await click(`document.querySelector('.ia-settings-button').click()`);
          await waitFor(`Boolean(document.querySelector('.ia-settings-row'))`);
          await click(
            `Array.from(document.querySelectorAll('.ia-settings-row')).find(row => row.textContent.includes('Domains')).querySelector('button').click()`,
          );
        }
        await waitFor(
          `Array.from(document.querySelectorAll('.ia-pack-card')).some(card => card.querySelector('.ia-pack-title b')?.textContent === ${JSON.stringify(item.label)} && card.querySelector('.ia-pack-action')?.textContent === 'Install' && !card.querySelector('.ia-pack-action').disabled)`,
        );
        await click(
          `Array.from(document.querySelectorAll('.ia-pack-card')).find(card => card.querySelector('.ia-pack-title b')?.textContent === ${JSON.stringify(item.label)}).querySelector('.ia-pack-action').click()`,
        );
        installed++;
        await waitFor(
          `window.viewerHost.domainStatus().then(status => status.installed.length === ${installed} && status.installed.some(item => item.domain === ${JSON.stringify(item.id)}))`,
          20 * 60 * 1000,
        );
      }
      const domains = await window.webContents.executeJavaScript(
        `window.viewerHost.domains().then(items => items.map(item => item.id).sort())`,
      );
      if (JSON.stringify(domains) !== JSON.stringify(planned.map(item => item.id).sort()))
        throw Error('Installed Domains did not reach the registry.');
    }
    const screenshot = process.env.HARNESS_PACKAGED_SMOKE_SCREENSHOT;
    if (screenshot)
      await require('./selftest-capture.cjs').captureSettled(window, { output: screenshot });
    app.quit();
    return;
  }
  if (app.isPackaged) {
    setTimeout(() => void coreUpdater.check(), 15000).unref();
    setInterval(() => void coreUpdater.check(), 24 * 60 * 60 * 1000).unref();
  }
  if (
    process.argv.some(flag => flag.endsWith('-selftest')) &&
    !process.argv.includes('--language-selftest')
  )
    await require('./selftest-language.cjs').setLanguage(window, 'en');
  if (process.argv.includes('--subagent-selftest')) {
    await require('./selftest-language.cjs').setLanguage(window, 'en');
    await require('./subagent-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--agents-selftest')) {
    await require('./agents-selftest.cjs').run(window, tasks);
    app.quit();
    return;
  }
  if (process.argv.includes('--mcp-selftest')) {
    await require('./mcp-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--external-mcp-selftest')) {
    await require('./external-mcp-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--documents-selftest')) {
    await require('./documents-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--language-selftest')) {
    await require('./language-selftest.cjs').run(window, dialog);
    app.quit();
    return;
  }
  if (process.argv.includes('--gui-settings-selftest')) {
    await require('./gui-settings-selftest.cjs').run(window, systemPreferences, shell);
    app.quit();
    return;
  }
  if (process.argv.includes('--model-sync-selftest')) {
    await require('./model-sync-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--ui-selftest')) {
    await require('./ui-selftest.cjs').run(window, dialog);
    app.quit();
    return;
  }
  if (process.argv.includes('--messages-selftest')) {
    await require('./messages-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--engineering-selftest')) {
    await require('./engineering-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--task-results-selftest')) {
    await require('./task-results-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--cad-selftest') || process.argv.includes('--cad-resize-selftest')) {
    await require('./cad-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--chat-selftest')) {
    await require('./chat-selftest.cjs').run(window, chats);
    app.quit();
    return;
  }
  if (process.argv.includes('--parallel-selftest')) {
    await require('./parallel-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--image-input-selftest')) {
    await require('./image-input-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--agent-log-selftest')) {
    await require('./agent-log-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--kicad-selftest')) {
    await require('./kicad-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--godot-selftest')) {
    await require('./godot-selftest.cjs').run(window);
    app.quit();
    return;
  }
  if (process.argv.includes('--viewer-selftest')) {
    async function waitFor(script, timeout = 30000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          if (await window.webContents.executeJavaScript(script)) return;
        } catch (error) {
          fs.writeFileSync(
            '/tmp/industrial-workspace-failure.png',
            await window.webContents.capturePage().then(image => image.toPNG()),
          );
          throw Error(`${script}: ${error}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      fs.writeFileSync(
        '/tmp/industrial-workspace-failure.png',
        await window.webContents.capturePage().then(image => image.toPNG()),
      );
      throw Error(`Desktop UI condition timed out: ${script}`);
    }
    const output =
      process.env.VIEWER_SELFTEST_SCREENSHOT ||
      path.join(app.getPath('temp'), 'industrial-viewer-selftest.png');
    const shot = async suffix => {
      const filename = suffix ? output.replace(/\.png$/, `-${suffix}.png`) : output;
      fs.writeFileSync(
        filename,
        await window.webContents.capturePage().then(image => image.toPNG()),
      );
      return filename;
    };
    await waitFor(
      `Boolean(document.querySelector('.ia-project-list button.selected')) && !document.querySelector('.ia-workspace')`,
    );
    await waitFor(
      `document.querySelector('.ia-domain-pill')?.innerText.includes('Chip') && document.querySelector('.ia-domain-pill')?.getAttribute('role') === 'status'`,
    );
    await waitFor(
      `document.querySelector('.ia-project-list button.selected .ia-project-domain-badge')?.innerText.includes('Chip')`,
    );
    if (
      !(await window.webContents.executeJavaScript(
        `window.viewerHost.resolve({task: 'PCB board', domain: 'pcb'}).then(() => false, () => true)`,
      ))
    )
      throw Error('A fixed project accepted a different domain.');
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-list button.selected').click()`,
    );
    await waitFor(
      `document.querySelector('.ia-project-page') && document.querySelector('select[aria-label="Project domain"]')?.value === 'chip'`,
    );
    await new Promise(resolve => setTimeout(resolve, 150));
    const projectScreenshot = await shot('project');
    const expectedResources = resourceCatalog(activeProject().domain);
    await waitFor(
      `document.querySelectorAll('.ia-project-resources select').length === ${expectedResources.skills.length + expectedResources.mcpServers.length}`,
    );
    await window.webContents.executeJavaScript(
      `(() => {const select = document.querySelector('.ia-project-resources select'); select.value = 'disabled'; select.dispatchEvent(new Event('change', {bubbles: true}));})()`,
    );
    await waitFor(
      `document.querySelector('.ia-project-resources select')?.value === 'disabled' && window.viewerHost.projectBindings().then(state => window.viewerHost.resourceGet({projectId: state.activeId})).then(state => state.effective.skills.includes('chip.netlist.inspect'))`,
    );
    await window.webContents.executeJavaScript(
      `(() => {const select = document.querySelector('.ia-project-resources select'); select.value = 'inherit'; select.dispatchEvent(new Event('change', {bubbles: true}));})()`,
    );
    await waitFor(
      `document.querySelector('.ia-project-resources select')?.value === 'inherit' && window.viewerHost.projectBindings().then(state => window.viewerHost.resourceGet({projectId: state.activeId})).then(state => !state.effective.skills.includes('chip.netlist.inspect'))`,
    );
    await window.webContents.executeJavaScript(
      `(() => {const domain = document.querySelector('select[aria-label="Project domain"]'); domain.value = 'pcb'; domain.dispatchEvent(new Event('change', {bubbles: true}));})()`,
    );
    await waitFor(`!document.querySelector('.ia-project-domain-edit button')?.disabled`);
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-domain-edit button').click()`,
    );
    await waitFor(
      `document.querySelector('select[aria-label="Project domain"]')?.value === 'pcb' && document.querySelector('.ia-project-domain-edit button')?.disabled`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-start').click()`,
    );
    await waitFor(
      `document.querySelector('.ia-domain-pill')?.innerText.includes('PCB') && document.querySelector('.ia-domain-pill')?.getAttribute('role') === 'status'`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-list button.selected').click()`,
    );
    await waitFor(`document.querySelector('select[aria-label="Project domain"]')?.value === 'pcb'`);
    await window.webContents.executeJavaScript(
      `(() => {const domain = document.querySelector('select[aria-label="Project domain"]'); domain.value = 'chip'; domain.dispatchEvent(new Event('change', {bubbles: true}));})()`,
    );
    await waitFor(`!document.querySelector('.ia-project-domain-edit button')?.disabled`);
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-domain-edit button').click()`,
    );
    await waitFor(
      `document.querySelector('select[aria-label="Project domain"]')?.value === 'chip' && document.querySelector('.ia-project-domain-edit button')?.disabled`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-start').click()`,
    );
    await waitFor(`document.querySelector('.ia-domain-pill')?.innerText.includes('Chip')`);
    const newProjectDirectory = path.join(app.getPath('userData'), 'new-board-project');
    fs.mkdirSync(newProjectDirectory);
    const showOpenDialog = dialog.showOpenDialog;
    let createScreenshot;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [newProjectDirectory] });
    try {
      await window.webContents.executeJavaScript(
        `document.querySelector('.ia-projects-heading button').click()`,
      );
      await waitFor(
        `Boolean(document.querySelector('.ia-create-project')) && document.querySelector('.ia-create-project button.primary')?.disabled`,
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('.ia-create-project .ia-folder-picker').click()`,
      );
      await waitFor(
        `document.querySelector('.ia-folder-picker')?.innerText.includes('new-board-project')`,
      );
      await waitFor(
        `Array.from(document.querySelectorAll('.ia-create-project .ia-domain-choice')).some(button => button.innerText.includes('PCB'))`,
      );
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ia-create-project .ia-domain-choice')).find(button => button.innerText.includes('PCB')).click()`,
      );
      await waitFor(
        `document.querySelector('.ia-create-project .ia-domain-choice[aria-pressed="true"]')?.innerText.includes('PCB')`,
      );
      await waitFor(`!document.querySelector('.ia-create-project button.primary')?.disabled`);
      await new Promise(resolve => setTimeout(resolve, 120));
      createScreenshot = await shot('create');
      await window.webContents.executeJavaScript(
        `document.querySelector('.ia-create-project button.primary').click()`,
      );
      await waitFor(
        `document.querySelector('.ia-project-page h1')?.innerText === 'new-board-project' && document.querySelector('select[aria-label="Project domain"]')?.value === 'pcb'`,
      );
    } finally {
      dialog.showOpenDialog = showOpenDialog;
    }
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.ia-project-list button')).find(button => button.innerText.includes('Sobel')).click()`,
    );
    await waitFor(
      `document.querySelector('select[aria-label="Project domain"]')?.value === 'chip'`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-project-start').click()`,
    );
    await waitFor(`document.querySelector('.ia-domain-pill')?.innerText.includes('Chip')`);
    const screenshots = [projectScreenshot, createScreenshot, await shot('initial')];
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-chat-actions button:last-child').click()`,
    );
    await waitFor(
      `Boolean(document.querySelector('.ia-workspace')) && !document.querySelector('.ia-workspace-tree')`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-file-tree-toggle').click()`,
    );
    await waitFor(`Boolean(document.querySelector('.ia-file-list button[title="README.md"]'))`);
    if (
      await window.webContents.executeJavaScript(
        `document.body.innerText.includes('VIEWER EXAMPLES')`,
      )
    )
      throw Error('Reference Viewer fixtures appeared in the project file tree.');
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-file-list button[title="README.md"]').click()`,
    );
    await waitFor(
      `Boolean(document.querySelector('.rp-document-markdown')?.innerText.includes('Sobel chip design sample')) && document.querySelector('.ia-viewer-footer')?.innerText.includes('MARKDOWN · Ready')`,
    );
    screenshots.push(await shot('source'));
    await waitFor(
      `Boolean(document.querySelector('.ia-file-list button[title="outputs/sobel_netlist.json"]'))`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-file-list button[title="outputs/sobel_netlist.json"]').click()`,
    );
    await waitFor(
      `document.querySelector('.ia-viewer-footer')?.innerText.includes('NETLIST · Ready')`,
      120000,
    );
    const measureNetlist = () =>
      window.webContents.executeJavaScript(
        `new DOMMatrix(getComputedStyle(document.querySelector('.rp-net-drawing')).transform).a`,
      );
    await require('./navigation-selftest.cjs').verifyNavigation(window, measureNetlist);
    await require('./navigation-selftest.cjs').verifyWheel(
      window,
      measureNetlist,
      (deltaY, ctrlKey) =>
        window.webContents.executeJavaScript(
          `(() => {const e=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('.rp-net-stage').dispatchEvent(e);return e.defaultPrevented;})()`,
        ),
    );
    screenshots.push(await shot('netlist'));
    await window.webContents.executeJavaScript(
      `const area = document.querySelector('.ia-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'Inspect the netlist signals'); area.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('.ia-chat-actions button[title="Toggle debug logs"]').click()`,
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-send').click()`);
    await waitFor(
      `document.querySelector('.ia-broker-tool:not([open])')?.innerText.includes('chip / rtl')`,
    );
    screenshots.push(await shot('debug'));
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-broker-tool>summary').click()`,
    );
    await waitFor(
      `document.querySelector('.ia-broker-tool[open]')?.innerText.includes('chip.rtl.netlist.inspect') && document.querySelector('.ia-broker-trace')`,
    );
    await new Promise(resolve => setTimeout(resolve, 150));
    if (
      !(await window.webContents.executeJavaScript(
        `(() => {const item=document.querySelector('.ia-broker-tool');const child=item.querySelector('.ia-tool-detail');return item.open && child.getBoundingClientRect().height > 100 && getComputedStyle(child).display !== 'none'})()`,
      ))
    )
      throw Error('Expanded Broker details are not visible.');
    screenshots.push(await shot('broker-detail'));
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-broker-tool>summary').click()`,
    );
    window.webContents.send('agent:event', {
      type: 'thinking',
      text: 'First thought\nSecond thought\nThird thought\nFourth thought',
    });
    window.webContents.send('agent:event', {
      type: 'tool',
      id: 'selftest-tool',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });
    window.webContents.send('agent:event', {
      type: 'tool-result',
      id: 'selftest-tool',
      error: false,
      message: 'Read complete',
      output: 'Project README',
    });
    window.webContents.send('agent:event', { type: 'done', result: { status: 'completed' } });
    await waitFor(
      `Boolean(document.querySelector('.ia-thinking')) && !document.querySelector('.ia-thinking p') && document.querySelectorAll('.ia-agent-flow>.ia-agent-tool').length === 1 && !document.querySelector('.ia-agent-flow>.ia-agent-tool[open]')`,
    );
    screenshots.push(await shot('compact-flow'));
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-thinking-head').click(); document.querySelector('.ia-agent-flow>.ia-agent-tool summary').click()`,
    );
    await waitFor(
      `document.querySelector('.ia-thinking p')?.innerText.includes('Fourth thought') && Boolean(document.querySelector('.ia-agent-flow>.ia-agent-tool[open]'))`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-thinking-head').click(); document.querySelector('.ia-agent-flow>.ia-agent-tool summary').click()`,
    );
    for (const [kind, file] of [
      ['layout', 'sobel_layout.gds'],
      ['waveform', 'sobel_wave.vcd'],
    ]) {
      await window.webContents.executeJavaScript(
        `document.querySelector('.ia-file-list button[title="outputs/${file}"]').click()`,
      );
      await waitFor(
        `document.querySelector('.ia-viewer-footer')?.innerText.includes('${kind.toUpperCase()} · Ready')`,
        120000,
      );
      if (kind === 'waveform')
        await waitFor(
          `document.querySelector('.rp-surfer iframe')?.getAttribute('data-signals-ready') === '6'`,
        );
      if (kind === 'layout') {
        const measure = () =>
          window.webContents.executeJavaScript(
            `Number(document.querySelector('.rp-view-footer span:last-child').innerText.match(/([0-9.]+)×/)[1])`,
          );
        await require('./navigation-selftest.cjs').verifyNavigation(window, measure);
        await require('./navigation-selftest.cjs').verifyWheel(window, measure, (deltaY, ctrlKey) =>
          window.webContents.executeJavaScript(
            `(() => {const e=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('.rp-canvas-host').dispatchEvent(e);return e.defaultPrevented;})()`,
          ),
        );
      }
      if (kind === 'waveform') {
        const frame = window.webContents.mainFrame.frames.find(item =>
          item.url.startsWith('app://surfer/'),
        );
        const measure = async () => {
          const state = await frame.executeJavaScript(
            `import('./surfer.js').then(module => module.get_state())`,
          );
          const range = state.match(
            /curr_left:\s*\(([-0-9.e+]+)\),\s*curr_right:\s*\(([-0-9.e+]+)\)/,
          );
          if (!range) throw Error('Surfer native time range is unavailable.');
          return 1 / (Number(range[2]) - Number(range[1]));
        };
        await require('./navigation-selftest.cjs').verifyNavigation(window, measure, {
          percent: false,
        });
        await require('./navigation-selftest.cjs').verifyWheel(window, measure, (deltaY, ctrlKey) =>
          frame.executeJavaScript(
            `(() => {const e=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('canvas').dispatchEvent(e);return e.defaultPrevented;})()`,
          ),
        );
      }
      screenshots.push(await shot(kind));
    }
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-settings-button').click()`,
    );
    await waitFor(`Boolean(document.querySelector('.ia-settings-row button'))`);
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-settings-row button').click()`,
    );
    await waitFor(`document.querySelector('.ia-app').classList.contains('theme-dark')`);
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.ia-settings-row')).find(row => row.innerText.includes('Model API')).querySelector('button').click()`,
    );
    await waitFor(`Boolean(document.querySelector('.ia-model-modal'))`);
    screenshots.push(await shot('settings'));
    await window.webContents.executeJavaScript(
      `document.querySelector('.ia-model-modal header button').click(); document.querySelector('.ia-sidebar-brand .ia-icon').click(); document.querySelector('.ia-chat-actions button:last-child').click()`,
    );
    await waitFor(
      `!document.querySelector('.ia-sidebar') && !document.querySelector('.ia-workspace')`,
    );
    console.log(JSON.stringify({ ok: true, screenshots }));
    app.quit();
  }
}

app
  .whenReady()
  .then(createWindow)
  .catch(error => {
    fs.writeSync(2, String(error?.stack || error) + '\n');
    app.exit(1);
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let shutdownComplete = false;
let shutdownPromise;
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  domainController?.abort(Error('Application is shutting down.'));
  if (shutdownPromise) return;
  raster?.close();
  viewerProtocol?.close();
  godotRuntime.close();
  kicadRuntime.close();
  shutdownPromise = (async () => {
    try {
      await domainOperationDone;
      await tasks.close();
    } finally {
      await guiBridge?.close();
    }
  })()
    .catch(error => console.error('Session shutdown failed:', error.message))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
