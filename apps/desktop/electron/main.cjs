const {app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, nativeImage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {RasterService} = require('../../../packages/viewer-builtin/src/layout/raster.cjs');
const {renderNetlist, isYosysNetlist} = require('../../../packages/viewer-builtin/src/netlist/netlist.cjs');
const {createViewerProtocol} = require('../../../packages/viewer-builtin/src/waveform/protocol.cjs');
const {initialVcdSignals} = require('../../../packages/viewer-builtin/src/waveform/signals.cjs');
const {GodotRuntimeManager, isGodotExport} = require('../../../packages/viewer-builtin/src/godot/runtime.cjs');
const {createAssetPlugins} = require('../../../packages/viewer-builtin/src/assets/service.cjs');
const {createDocumentPlugins} = require('../../../packages/viewer-builtin/src/documents/service.cjs');
const {KiCadRuntimeManager, isKiCadFile} = require('../../../packages/viewer-builtin/src/kicad/runtime.cjs');
const {createViewerRegistry} = require('../../../packages/viewer-core/src/registry.cjs');
const {resolve, discloseDetail} = require('../../../packages/capability-broker/src/index.cjs');
const {resolveProjectTask, effectiveCapabilities, resourceCatalog, ResourceSettings, ChatStore, defaultChatDirectory} = require('@industrial-agent-harness/harness-core');
const {capabilities, listDomains} = require('@industrial-agent-harness/domain-skills');
const {validatePromptImages} = require('../../../packages/agent-kimi/src/image-input.cjs');
const {DiagnosticReader} = require('../../../packages/agent-kimi/src/diagnostic-reader.cjs');
const {defaultLogDirectory} = require('../../../packages/agent-kimi/src/diagnostic-log.cjs');
const {SessionManager} = require('./session-manager.cjs');
const {KimiSession} = require('../../../packages/agent-kimi/src/index.cjs');
const {ObservedContextStore} = require('@industrial-agent-harness/domain-runtime');
const {createGuiPlugin, ensureInstalled, status: guiBridgeStatus} = require('@industrial-agent-harness/computer-use-bridge');
const {readSettings, saveSettings} = require('./harness-settings.cjs');
const {readProfile, saveProfile, validateProfile, writeCliConfig, sessionEnv} = require('./model-config.cjs');
const {readBindings, addBinding, saveBindings} = require('./project-bindings.cjs');

protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}}]);
if (['--viewer-selftest', '--kicad-selftest', '--godot-selftest', '--documents-selftest', '--agent-log-selftest', '--chat-selftest', '--parallel-selftest', '--image-input-selftest'].some(flag => process.argv.includes(flag))) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-selftest-')));

if (process.argv.includes('--chat-selftest') && process.env.INDUSTRIAL_CHAT_SELFTEST_USER_DATA) app.setPath('userData', process.env.INDUSTRIAL_CHAT_SELFTEST_USER_DATA);

const desktopRoot = path.resolve(__dirname, '..');
const artifacts = new Map();
const netlistSessions = new Map();
let activeLayoutToken;
let raster;
let viewerProtocol;
const godotRuntime = new GodotRuntimeManager();
const kicadRuntime = new KiCadRuntimeManager();
const sessions = new SessionManager();
let contextStore;
let projectDir;
let projectBindings = {projects: [], activeId: null};
let mainWindow;
let sessionApiKey = '';
let modelRevision = 0;
let appSettings = {guiPluginEnabled: false};
let guiBridge;
const chats = new ChatStore(process.argv.some(flag => flag.endsWith('-selftest')) ? path.join(app.getPath('userData'), 'chats') : defaultChatDirectory());
let activeChatId;
function chatList() {return {chats: activeProject()?.domain ? chats.list(projectDir, activeProject().domain).map(chat => ({...chat, running: sessions.busy(sessions.get(activeProject(), chat.id)), awaitingApproval: Boolean(sessions.get(activeProject(), chat.id).agent?.pendingApprovals.size)})) : [], activeId: activeChatId || null, sessions: sessions.snapshots()};}
function ensureChat() {
  if (!activeChatId) activeChatId = chats.create(projectDir, activeProject()?.domain).id;
  chats.get(activeChatId, projectDir, activeProject()?.domain);
  return activeChatId;
}
function chatHistory(id, before = null) {
  const history = chats.history(id, projectDir, activeProject().domain, before);
  return {...history, executing: sessions.busy(sessions.get(activeProject(), id))};
}
function selectedSession() {
  const entry = sessions.get(activeProject(), ensureChat());
  if (!entry.scope && !sessions.busy(entry)) {
    const last = chats.history(entry.id, entry.project.path, entry.project.domain).turns.at(-1);
    entry.scope = last?.broker?.scope; entry.resolvedRequest = last?.broker?.request || (last ? {task: last.task} : undefined);
  }
  return entry;
}
function restoreChatSelection() {
  activeChatId = activeProject()?.domain ? chats.list(projectDir, activeProject().domain)[0]?.id : undefined;
}
function contextStoreOptions() {return process.argv.some(flag => flag.endsWith('-selftest')) ? {directory: path.join(app.getPath('userData'), 'state')} : {};}
function sessionContext(entry) {entry.context ||= new ObservedContextStore(entry.project.path, entry.project.domain, contextStoreOptions()); return entry.context;}
function notifySessions() {if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('chat:updated');}
function diagnosticDirectory() {return process.argv.some(flag => flag.endsWith('-selftest')) ? path.join(app.getPath('userData'), 'logs') : defaultLogDirectory();}
const diagnosticReader = new DiagnosticReader(diagnosticDirectory());

const resourceSettings = new ResourceSettings(process.argv.some(flag => flag.endsWith('-selftest')) ? path.join(app.getPath('userData'), 'resources') : undefined);
let changingResources = false;
function projectResourcePolicy(project = activeProject()) {return resourceSettings.snapshot(resourceCatalog(project?.domain), project?.path).effective;}

function configDir() {return path.join(app.getPath('userData'), 'model');}
function projectConfigDir() {return path.join(app.getPath('userData'), 'workspace');}
function guiBridgeDir() {return path.join(app.getPath('userData'), 'gui-bridge');}
function activeProject() {return projectBindings.projects.find(item => item.id === projectBindings.activeId) || null;}
function projectSnapshot() {return {...projectBindings, projectDir: projectDir || null};}
function clearProjectArtifacts() {
  contextStore?.close(); contextStore = undefined;
  artifacts.clear();
  netlistSessions.clear(); activeLayoutToken = undefined;
  godotRuntime.close();
  kicadRuntime.close();
}
function observedContext() {
  const domain = activeProject()?.domain;
  if (!projectDir || !domain) throw Error('Choose a project with a domain first.');
  contextStore ||= new ObservedContextStore(projectDir, domain, contextStoreOptions());
  return contextStore;
}
function keyFile() {return path.join(configDir(), 'api-key.bin');}
function canPersistKey() {return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');}
function readApiKey() {
  if (['--agent-log-selftest', '--chat-selftest', '--parallel-selftest', '--image-input-selftest'].some(flag => process.argv.includes(flag))) return 'diagnostic-selftest-key';
  if (sessionApiKey) return sessionApiKey;
  if (!canPersistKey() || !fs.existsSync(keyFile())) return '';
  try {return safeStorage.decryptString(fs.readFileSync(keyFile()));} catch {return '';}
}
function kimiExecutable() {
  if (process.env.KIMI_EXECUTABLE) return process.env.KIMI_EXECUTABLE;
  const local = path.join(desktopRoot, '.venv-kimi', process.platform === 'win32' ? 'Scripts/kimi.exe' : 'bin/kimi');
  return fs.existsSync(local) ? local : 'kimi';
}
function modelStatus() {return {...readProfile(configDir()), hasApiKey: Boolean(readApiKey()), keyPersisted: canPersistKey() && fs.existsSync(keyFile())};}
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
function guiBridgeState() {
  // A user-supplied GUI_BRIDGE_BIN never lands in the managed directory, so
  // disk state alone would report 'missing' forever; it is ready by definition.
  if (process.env.GUI_BRIDGE_BIN) return {enabled: appSettings.guiPluginEnabled, install: 'ready', version: null};
  const installed = guiBridgeStatus(guiBridgeDir());
  return {enabled: appSettings.guiPluginEnabled, install: installed.state, version: installed.version?.tag || null};
}
function guiInstallProgress(phase, detail) {
  mainWindow?.webContents.send('settings:gui-progress', {phase, ...(detail && typeof detail === 'object' ? {detail: Object.keys(detail)} : {})});
}
function startGuiInstall() {
  return ensureInstalled(guiBridgeDir(), process.env, guiInstallProgress)
    .then(result => mainWindow?.webContents.send('settings:gui-progress', {phase: 'ready', tag: result.tag, cached: Boolean(result.cached)}))
    .catch(error => mainWindow?.webContents.send('settings:gui-progress', {phase: 'error', error: String(error)}));
}
function runtimeConfig(project = activeProject()) {
  const profile = readProfile(configDir());
  const apiKey = readApiKey();
  return {profile, apiKey, revision: modelRevision, executable: kimiExecutable(), shareDir: writeCliConfig(configDir(), profile), env: sessionEnv(profile, apiKey), disabledMcpServers: projectResourcePolicy(project).mcpServers};
}

function kindFor(file) {
  const kind = viewerRegistry.match(file);
  if (!kind) throw Error('No registered Viewer supports this file.');
  return kind;
}

function projectFile(relative) {
  if (!projectDir || typeof relative !== 'string') throw Error('Choose a project first.');
  const file = fs.realpathSync(path.resolve(projectDir, relative));
  if (!file.startsWith(projectDir + path.sep) || !fs.statSync(file).isFile()) throw Error('File is outside the selected project.');
  return file;
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
  const observed = activeProject()?.domain ? await observedContext().observeArtifact({id: entry.id, kind: entry.kind, file}) : null;
  const artifact = {
    id: entry.id, kind: entry.kind, name: entry.name, design: entry.design,
    sizeBytes: observed?.sizeBytes ?? stat.size, sha256: observed?.sha256 ?? await digest(file),
    source: 'project file',
  };
  artifacts.set(entry.id, {artifact, file});
  return artifact;
}

async function checked(id) {
  const entry = artifacts.get(id);
  if (!entry) throw Error('Unknown artifact.');
  if (await digest(entry.file) !== entry.artifact.sha256) throw Error('Artifact content changed; reopen the file.');
  return entry;
}

function layoutPython() {
  const selected = process.env.KLAYOUT_PYTHON || path.join(desktopRoot, '.venv-klayout', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(selected)) throw Error('KLayout Python is unavailable. Set KLAYOUT_PYTHON or run pnpm setup:layout.');
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
  ...createAssetPlugins({projectRoot: () => projectDir}),
  {id: 'layout', matches: file => ['.gds', '.gdsii', '.oas', '.oasis'].includes(path.extname(file).toLowerCase()), open: async ({artifact, file}) => {
    const token = crypto.randomUUID();
    const data = await getRaster().call({op: 'load', path: file, token});
    activeLayoutToken = token;
    return {artifact, kind: 'layout', data};
  }},
  {id: 'netlist', matches: isYosysNetlist, open: async ({artifact, file}) => {
    const token = crypto.randomUUID();
    const data = await renderNetlist(file);
    netlistSessions.set(token, file);
    return {artifact, kind: 'netlist', data: {...data, token}};
  }},
  {id: 'waveform', matches: file => ['.vcd', '.fst', '.ghw'].includes(path.extname(file).toLowerCase()), open: async ({artifact, file}) => ({artifact, kind: 'waveform', data: {
    url: viewerProtocol.registerWave(file), name: artifact.name, defaultSignals: initialVcdSignals(file),
  }})},
  {id: 'godot', matches: file => isGodotExport(file), open: async ({artifact, file}) => ({artifact, kind: 'godot', data: await godotRuntime.open(file, artifact.sha256)})},
  {id: 'kicad', matches: isKiCadFile, open: async ({artifact, file}) => ({artifact, kind: 'kicad', data: await kicadRuntime.open(file, artifact.sha256, projectDir)})},
  // Generic formats are fallbacks; preserve specialized JSON/HTML detection.
  ...createDocumentPlugins({projectRoot: () => projectDir}),
]);

function registerHandlers() {
  function diagnosticProject(event, request) {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !projectDir || request?.projectId !== activeProject()?.id) throw Error('Diagnostic logs belong to the selected project.');
    return projectDir;
  }
  async function diagnosticRequest(method, event, request) {
    const project = diagnosticProject(event, request);
    const result = await diagnosticReader[method](project, request);
    if (activeProject()?.id !== request.projectId || projectDir !== project) throw Error('Selected project changed; reopen agent logs.');
    return result;
  }
  ipcMain.handle('agent:log-runs', (event, request) => diagnosticRequest('list', event, request));
  ipcMain.handle('agent:log-page', (event, request) => diagnosticRequest('page', event, request));
  ipcMain.handle('agent:log-view', (event, request) => diagnosticRequest('view', event, request));
  ipcMain.handle('agent:log-detail', (event, request) => diagnosticRequest('detail', event, request));
  ipcMain.handle('agent:log-record', (event, request) => diagnosticRequest('record', event, request));
  ipcMain.handle('broker:domains', () => listDomains(capabilities));
  ipcMain.handle('resource:catalog', () => resourceCatalog(activeProject()?.domain));
  ipcMain.handle('broker:resolve', (event, request) => {
    chatRequest(event);
    if (changingResources) throw Error('Resource settings are being saved.');
    if (request?.chatId && request.chatId !== activeChatId) throw Error('Selected chat changed; retry the task.');
    const entry = selectedSession();
    if (sessions.busy(entry)) throw Error('This chat is already running.');
    const result = resolveProjectTask(entry.project.domain, request, entry.scope, capabilities, projectResourcePolicy(entry.project));
    entry.resolvedRequest = {...request}; result.request = entry.resolvedRequest;
    entry.scope = result.scope; entry.trace = result.trace;
    entry.preparedTurn = {id: chats.beginTurn(entry.id, request.task, result, false), task: request.task, broker: result};
    notifySessions(); return {...result, chatId: entry.id, turnId: entry.preparedTurn.id};
  });
  function loadDetail(capabilityId, entry = selectedSession()) {
    const detail = discloseDetail(entry.scope, effectiveCapabilities(capabilities, projectResourcePolicy(entry.project)), capabilityId);
    entry.trace.push({level: 'L3', event: 'detail.load', detail: {capabilityId, skills: detail.skills.map(item => item.id), tools: detail.tools.map(item => item.id)}});
    return detail;
  }
  ipcMain.handle('broker:detail', (_event, capabilityId) => loadDetail(capabilityId));
  ipcMain.handle('broker:trace', () => selectedSession().trace);
  ipcMain.handle('model:get', () => modelStatus());
  ipcMain.handle('settings:gui-state', () => guiBridgeState());
  ipcMain.handle('settings:set-gui', (_event, {enabled}) => {
    appSettings = {...appSettings, guiPluginEnabled: Boolean(enabled)};
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
    if (request.apiKey !== undefined && (typeof request.apiKey !== 'string' || request.apiKey.length > 8192)) throw Error('Invalid API key.');
    changingResources = true;
    try {
      await sessions.reset();
      saveProfile(configDir(), profile);
      if (request.apiKey) {
        sessionApiKey = request.apiKey.trim();
        if (canPersistKey()) {
          fs.mkdirSync(configDir(), {recursive: true, mode: 0o700});
          fs.writeFileSync(keyFile(), safeStorage.encryptString(sessionApiKey), {mode: 0o600});
          fs.chmodSync(keyFile(), 0o600);
        }
      }
      if (request.clearApiKey) {sessionApiKey = ''; fs.rmSync(keyFile(), {force: true});}
      writeCliConfig(configDir(), profile);
      modelRevision++;
      return modelStatus();
    } finally {changingResources = false;}
  });
  ipcMain.handle('agent:status', () => {
    if (['--agent-log-selftest', '--chat-selftest', '--parallel-selftest', '--image-input-selftest'].some(flag => process.argv.includes(flag))) return {available:true,version:'SDK seam selftest',projectDir,configured:true};
    const executable = kimiExecutable();
    const result = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 3000});
    const help = result.status === 0 ? spawnSync(executable, ['--help'], {encoding: 'utf8', timeout: 3000}) : null;
    const available = !result.error && result.status === 0 && help?.status === 0 && help.stdout.includes('--wire');
    return {available, version: available ? result.stdout.split('\n')[0].trim() : '', projectDir: projectDir || null, configured: Boolean(readApiKey()), gui: guiBridgeState()};
  });
  ipcMain.handle('project:bindings', () => projectSnapshot());
  ipcMain.handle('project:set-domain', async (_event, request) => {
    const {id, domain} = request || {};
    if (!listDomains(capabilities).some(item => item.id === domain)) throw Error('Unknown domain.');
    const project = projectBindings.projects.find(item => item.id === id);
    if (!project) throw Error('Unknown project.');
    if (id !== projectBindings.activeId) throw Error('Open this project before changing its domain.');
    if (project.domain === domain) return projectSnapshot();
    if (changingResources) throw Error('Settings are being saved.');
    sessions.assertIdle(project.id);
    changingResources = true;
    try {
      await sessions.reset(project.id);
      project.domain = domain;
      if (activeProject()?.id === project.id) {clearProjectArtifacts(); activeChatId = undefined;}
      saveBindings(projectConfigDir(), projectBindings);
      return projectSnapshot();
    } finally {changingResources = false;}
  });
  function resourceProject(event, request) {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw Error('Resource settings require the main app window.');
    if (request?.projectId !== undefined && (!activeProject() || request.projectId !== activeProject().id)) throw Error('Open this project before configuring resources.');
    return request?.projectId !== undefined ? activeProject() : null;
  }
  ipcMain.handle('resource:get', (event, request) => {
    const project = resourceProject(event, request);
    return resourceSettings.snapshot(resourceCatalog(project?.domain), project?.path);
  });
  async function setResource(event, request) {
    const project = resourceProject(event, request);
    if (changingResources) throw Error('Resource settings are being saved.');
    sessions.assertIdle(project?.id);
    changingResources = true;
    try {
      await sessions.reset(project?.id);
      resourceProject(event, request);
      const snapshot = resourceSettings.set(resourceCatalog(project?.domain), request, project?.path);
      return snapshot;
    } finally {changingResources = false;}
  }
  ipcMain.handle('resource:set', setResource);
  ipcMain.handle('project:set-resource', async (event, request) => {
    if (!request?.projectId || typeof request?.enabled !== 'boolean') throw Error('Invalid project resource change.');
    await setResource(event, {...request, mode: request.enabled ? 'enabled' : 'disabled'});
    return projectSnapshot();
  });
  ipcMain.handle('project:select', async (_event, id) => {
    const item = projectBindings.projects.find(candidate => candidate.id === id);
    if (!item) throw Error('Unknown project.');
    const actual = fs.realpathSync(item.path);
    if (!fs.statSync(actual).isDirectory()) throw Error('Project directory is unavailable.');
    projectBindings.activeId = id; projectDir = actual;
    clearProjectArtifacts();
    restoreChatSelection();
    saveBindings(projectConfigDir(), projectBindings);
    return projectSnapshot();
  });
  ipcMain.handle('project:choose-directory', async () => {
    const result = await dialog.showOpenDialog({title: 'Choose engineering project', properties: ['openDirectory']});
    return result.canceled ? null : fs.realpathSync(result.filePaths[0]);
  });
  ipcMain.handle('project:create', async (_event, request) => {
    if (!request || !listDomains(capabilities).some(item => item.id === request.domain)) throw Error('Choose a valid project domain.');
    if (typeof request.directory !== 'string' || typeof request.name !== 'string') throw Error('Invalid project details.');
    const next = addBinding(projectBindings, request.directory, request.domain, request.name);
    projectBindings = next;
    projectDir = activeProject().path;
    activeChatId = undefined;
    clearProjectArtifacts();
    saveBindings(projectConfigDir(), projectBindings);
    return projectSnapshot();
  });
  ipcMain.handle('agent:new', event => {
    chatRequest(event);
    activeChatId = chats.createDraft(projectDir, activeProject().domain, activeChatId).id;
    notifySessions(); return chatHistory(activeChatId);
  });
  function chatRequest(event) {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw Error('Chats require the main app window.');
    if (!activeProject()?.domain) throw Error('Choose a project with a domain.');
  }
  ipcMain.handle('chat:list', event => {chatRequest(event); return chatList();});
  ipcMain.handle('chat:history', (event, request) => {chatRequest(event); return chatHistory(request.id, request.before || null);});
  ipcMain.handle('chat:select', (event, id) => {
    chatRequest(event);
    const history = chatHistory(id);
    activeChatId = id; return history;
  });
  ipcMain.handle('chat:delete', async (event, id) => {
    chatRequest(event); chats.get(id, projectDir, activeProject().domain);
    const project = activeProject();
    await sessions.remove(project, id);
    chats.remove(id, project.path, project.domain);
    if (id === activeChatId) activeChatId = undefined;
    notifySessions(); return chatList();
  });
  ipcMain.handle('project:list', () => {
    if (!projectDir) return [];
    const output = [];
    const walk = (dir, depth) => {
      if (depth > 3 || output.length >= 250) return;
      const hidden = activeProject()?.domain === 'godot' ? ['node_modules', '__pycache__', 'target'] : ['node_modules', 'dist', 'build', '__pycache__', 'target'];
      const entries = fs.readdirSync(dir, {withFileTypes: true}).filter(item => !item.name.startsWith('.') && !hidden.includes(item.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (output.length >= 250) break;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(projectDir, absolute);
        output.push({path: relative, name: entry.name, depth, directory: entry.isDirectory()});
        if (entry.isDirectory()) walk(absolute, depth + 1);
      }
    };
    walk(projectDir, 0);
    return output;
  });
  ipcMain.handle('project:open', async (_event, relative) => {
    const file = projectFile(relative);
    return registerArtifact({id: crypto.randomUUID(), kind: kindFor(file), name: path.basename(file), design: path.basename(projectDir), file});
  });
  ipcMain.handle('project:read', (_event, relative) => {
    const file = projectFile(relative);
    const sizeBytes = fs.statSync(file).size;
    let viewer = null;
    try {viewer = kindFor(file);} catch {}
    if (viewer) return {path: relative, name: path.basename(file), sizeBytes, viewer, content: null, truncated: false};
    const limit = 2 * 1024 * 1024;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(sizeBytes, limit));
    try {fs.readSync(fd, buffer, 0, buffer.length, 0);} finally {fs.closeSync(fd);}
    return {path: relative, name: path.basename(file), sizeBytes, viewer: null, content: buffer.includes(0) ? null : buffer.toString('utf8'), truncated: sizeBytes > limit};
  });
  function imageRequest(event, request) {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !activeProject() || request?.projectId !== activeProject().id) throw Error('Images belong to the selected project.');
    const images = validatePromptImages(request.images);
    for (const image of images) {
      // Electron nativeImage decodes PNG/JPEG only. WebP is decoded by Chromium
      // before upload; the shared validator independently bounds its header.
      if (image.mime === 'image/webp') continue;
      const decoded = nativeImage.createFromBuffer(Buffer.from(image.dataUrl.split(',')[1], 'base64'));
      const size = decoded.getSize();
      if (decoded.isEmpty() || !size.width || !size.height || size.width > 8192 || size.height > 8192 || size.width * size.height !== image.width * image.height) throw Error('This image is corrupt or cannot be decoded.');
    }
    return images;
  }
  ipcMain.handle('agent:validate-images', (event, request) => imageRequest(event, request));
  ipcMain.handle('agent:run', (event, request) => {
    chatRequest(event);
    if (changingResources) throw Error('Resource settings are being saved.');
    if (request?.chatId && request.chatId !== activeChatId) throw Error('Selected chat changed; retry the task.');
    const entry = selectedSession();
    const task = typeof request === 'string' ? request : request?.task;
    const images = typeof request === 'string' || request?.images === undefined ? [] : imageRequest(event, request);
    if (images.length && !readProfile(configDir()).imageInput) throw Error('Enable Image input in Model API settings for a model that supports images.');
    if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task, 'utf8') > 128 * 1024) throw Error('Describe the task first.');
    if (!entry.scope || entry.resolvedRequest?.task !== task) throw Error('Resolve this task in the current chat first.');
    if (sessions.busy(entry)) throw Error('This chat is already running.');
    entry.release = chats.acquire(entry.id);
    try {
      chats.recoverInterrupted();
      const current = resolveProjectTask(entry.project.domain, {...entry.resolvedRequest, task}, entry.scope, capabilities, projectResourcePolicy(entry.project));
      current.request = entry.resolvedRequest; entry.scope = current.scope; entry.trace = current.trace;
      const turnId = entry.preparedTurn?.task === task ? entry.preparedTurn.id : chats.beginTurn(entry.id, task, current, false);
      chats.updateBroker(turnId, current); entry.preparedTurn = undefined;
      chats.start(turnId);
      let outcome = 'error';
      const emit = event => {
        chats.append(turnId, event);
        if (event.type === 'done') outcome = event.result.status;
        if (event.type === 'error') outcome = 'error';
        if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('agent:event', {...event, chatId: entry.id, projectId: entry.project.id, turnId});
        if (['approval', 'approval-resolved', 'done', 'error'].includes(event.type)) notifySessions();
      };
      entry.agent ||= new KimiSession(entry.project.path, () => entry.scope, id => sessionContext(entry).readArtifact(id), id => loadDetail(id, entry), emit, () => runtimeConfig(entry.project),
        process.argv.includes('--parallel-selftest') ? require('./parallel-selftest.cjs').createSession : process.argv.includes('--image-input-selftest') ? require('./image-input-selftest.cjs').createSession : process.argv.includes('--agent-log-selftest') ? require('./agent-log-selftest.cjs').createSession : process.argv.includes('--chat-selftest') ? require('./chat-selftest.cjs').createSession : undefined,
        {directory: diagnosticDirectory(), getBrokerTrace: () => entry.trace, pluginLog: (canonicalId, risk, args, info) => {entry.trace.push({level: 'L2', event: 'plugin.tool-call', detail: {plugin: 'computer-use', tool: canonicalId, risk, args, ...info}}); if (entry.trace.length > 500) entry.trace.splice(0, entry.trace.length - 500);}, getContextAnchor: () => sessionContext(entry).anchor(), readContextPage: (checkpointId, offset, limit) => sessionContext(entry).readPage(checkpointId, offset, limit), resolveSession: key => chats.runtimeSession(entry.id, key), sessionInitialized: id => chats.initialized(id)}, [guiPlugin()]);
      entry.agent.emit = emit;
      if (images.length) emit({type: 'user-images', images});
      void entry.agent.run(task, images).catch(error => emit({type: 'error', message: String(error)})).finally(() => {
        chats.finish(turnId, outcome);
        const release = entry.release; entry.release = undefined; release?.();
        notifySessions();
      });
      notifySessions(); return {started: true, chatId: entry.id, turnId};
    } catch (error) {entry.release?.(); entry.release = undefined; throw error;}
  });
  ipcMain.handle('agent:approve', (event, {id, response, chatId}) => {
    chatRequest(event);
    if (chatId && chatId !== activeChatId) throw Error('Open the chat that requested approval.');
    const entry = selectedSession();
    if (!entry.agent) throw Error('No active approval.'); return entry.agent.approve(id, response);
  });
  ipcMain.handle('agent:interrupt', (event, request) => {
    chatRequest(event);
    if (request?.chatId && request.chatId !== activeChatId) throw Error('Open the chat to stop it.');
    return selectedSession().agent?.interrupt();  });
  ipcMain.handle('viewer:open', async (_event, {artifactId}) => {
    const {artifact, file} = await checked(artifactId);
    const plugin = viewerRegistry.get(artifact.kind);
    if (!plugin) throw Error('Viewer plugin unavailable.');
    return plugin.open({artifact, file});
  });
  ipcMain.handle('viewer:render', (_event, request) => {
    if (request?.token !== activeLayoutToken) throw Error('Layout artifact changed; reopen this view.');
    return getRaster().call({...request, op: 'render'});
  });
  ipcMain.handle('viewer:netlist', async (_event, request) => {
    const file = netlistSessions.get(request?.token);
    if (!file) throw Error('Unknown netlist view.');
    return renderNetlist(file, request.module, request.focus);
  });
}

async function createWindow() {
  appSettings = readSettings(configDir());
  // A previously enabled plugin whose install never completed (offline first
  // run, failed upgrade) must not stay durably enabled with no binary: retry
  // on every startup until it lands. Progress reaches the Settings panel.
  if (appSettings.guiPluginEnabled && !process.env.GUI_BRIDGE_BIN && guiBridgeStatus(guiBridgeDir()).state !== 'ready') void startGuiInstall();
  if (process.argv.includes('--documents-selftest')) require('./documents-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--parallel-selftest')) require('./parallel-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--image-input-selftest')) require('./image-input-selftest.cjs').prepare(projectConfigDir(), configDir());
  if (process.argv.includes('--chat-selftest')) require('./chat-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--agent-log-selftest')) require('./agent-log-selftest.cjs').prepare(projectConfigDir(), diagnosticDirectory());
  if (process.argv.includes('--kicad-selftest')) require('./kicad-selftest.cjs').prepare(projectConfigDir());
  if (process.argv.includes('--godot-selftest')) require('./godot-selftest.cjs').prepare(projectConfigDir());
  projectBindings = readBindings(projectConfigDir(), path.resolve(desktopRoot, '../../examples/chip-sobel'));
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
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 650,
    backgroundColor: '#0c1218', title: 'Industrial Agent Harness',
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true},
  });
  mainWindow = window;
  if (process.env.INDUSTRIAL_DEV_URL) await window.loadURL(process.env.INDUSTRIAL_DEV_URL);
  else await window.loadURL('app://viewer/index.html');
  if (process.argv.includes('--documents-selftest')) {await require('./documents-selftest.cjs').run(window); app.quit(); return;}
  if (process.argv.includes('--chat-selftest')) {
    await require('./chat-selftest.cjs').run(window, chats);
    app.quit(); return;
  }
  if (process.argv.includes('--parallel-selftest')) {await require('./parallel-selftest.cjs').run(window); app.quit(); return;}
  if (process.argv.includes('--image-input-selftest')) {await require('./image-input-selftest.cjs').run(window); app.quit(); return;}
  if (process.argv.includes('--agent-log-selftest')) {
    await require('./agent-log-selftest.cjs').run(window);
    app.quit(); return;
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
        try {if (await window.webContents.executeJavaScript(script)) return;}
        catch (error) {fs.writeFileSync('/tmp/industrial-workspace-failure.png', await window.webContents.capturePage().then(image => image.toPNG())); throw Error(`${script}: ${error}`);}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      fs.writeFileSync('/tmp/industrial-workspace-failure.png', await window.webContents.capturePage().then(image => image.toPNG()));
      throw Error(`Desktop UI condition timed out: ${script}`);
    }
    const output = process.env.VIEWER_SELFTEST_SCREENSHOT || path.join(app.getPath('temp'), 'industrial-viewer-selftest.png');
    const shot = async suffix => {
      const filename = suffix ? output.replace(/\.png$/, `-${suffix}.png`) : output;
      fs.writeFileSync(filename, await window.webContents.capturePage().then(image => image.toPNG()));
      return filename;
    };
    await waitFor(`Boolean(document.querySelector('.ia-project-list button.selected')) && !document.querySelector('.ia-workspace')`);
    await waitFor(`document.querySelector('.ia-domain-pill')?.innerText.includes('Chip') && document.querySelector('.ia-domain-pill')?.getAttribute('role') === 'status'`);
    await waitFor(`document.querySelector('.ia-project-list button.selected .ia-project-domain-badge')?.innerText.includes('Chip')`);
    if (!await window.webContents.executeJavaScript(`window.viewerHost.resolve({task: 'PCB board', domain: 'pcb'}).then(() => false, () => true)`)) throw Error('A fixed project accepted a different domain.');
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-list button.selected').click()`);
    await waitFor(`document.querySelector('.ia-project-page') && document.querySelector('select[aria-label="Project domain"]')?.value === 'chip'`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const projectScreenshot = await shot('project');
    await waitFor(`document.querySelectorAll('.ia-project-resources select').length === 3`);
    await window.webContents.executeJavaScript(`(() => {const select = document.querySelector('.ia-project-resources select'); select.value = 'disabled'; select.dispatchEvent(new Event('change', {bubbles: true}));})()`);
    await waitFor(`document.querySelector('.ia-project-resources select')?.value === 'disabled' && window.viewerHost.projectBindings().then(state => window.viewerHost.resourceGet({projectId: state.activeId})).then(state => state.effective.skills.includes('chip.netlist.inspect'))`);
    await window.webContents.executeJavaScript(`(() => {const select = document.querySelector('.ia-project-resources select'); select.value = 'inherit'; select.dispatchEvent(new Event('change', {bubbles: true}));})()`);
    await waitFor(`document.querySelector('.ia-project-resources select')?.value === 'inherit' && window.viewerHost.projectBindings().then(state => window.viewerHost.resourceGet({projectId: state.activeId})).then(state => !state.effective.skills.includes('chip.netlist.inspect'))`);
    await window.webContents.executeJavaScript(`(() => {const domain = document.querySelector('select[aria-label="Project domain"]'); domain.value = 'pcb'; domain.dispatchEvent(new Event('change', {bubbles: true}));})()`);
    await waitFor(`!document.querySelector('.ia-project-domain-edit button')?.disabled`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-domain-edit button').click()`);
    await waitFor(`document.querySelector('select[aria-label="Project domain"]')?.value === 'pcb' && document.querySelector('.ia-project-domain-edit button')?.disabled`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-start').click()`);
    await waitFor(`document.querySelector('.ia-domain-pill')?.innerText.includes('PCB') && document.querySelector('.ia-domain-pill')?.getAttribute('role') === 'status'`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-list button.selected').click()`);
    await waitFor(`document.querySelector('select[aria-label="Project domain"]')?.value === 'pcb'`);
    await window.webContents.executeJavaScript(`(() => {const domain = document.querySelector('select[aria-label="Project domain"]'); domain.value = 'chip'; domain.dispatchEvent(new Event('change', {bubbles: true}));})()`);
    await waitFor(`!document.querySelector('.ia-project-domain-edit button')?.disabled`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-domain-edit button').click()`);
    await waitFor(`document.querySelector('select[aria-label="Project domain"]')?.value === 'chip' && document.querySelector('.ia-project-domain-edit button')?.disabled`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-start').click()`);
    await waitFor(`document.querySelector('.ia-domain-pill')?.innerText.includes('Chip')`);
    const newProjectDirectory = path.join(app.getPath('userData'), 'new-board-project');
    fs.mkdirSync(newProjectDirectory);
    const showOpenDialog = dialog.showOpenDialog;
    let createScreenshot;
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [newProjectDirectory]});
    try {
      await window.webContents.executeJavaScript(`document.querySelector('.ia-projects-heading button').click()`);
      await waitFor(`Boolean(document.querySelector('.ia-create-project')) && document.querySelector('.ia-create-project button.primary')?.disabled`);
      await window.webContents.executeJavaScript(`document.querySelector('.ia-create-project .ia-folder-picker').click()`);
      await waitFor(`document.querySelector('.ia-folder-picker')?.innerText.includes('new-board-project')`);
      await waitFor(`Array.from(document.querySelectorAll('.ia-create-project .ia-domain-choice')).some(button => button.innerText.includes('PCB'))`);
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ia-create-project .ia-domain-choice')).find(button => button.innerText.includes('PCB')).click()`);
      await waitFor(`document.querySelector('.ia-create-project .ia-domain-choice[aria-pressed="true"]')?.innerText.includes('PCB')`);
      await waitFor(`!document.querySelector('.ia-create-project button.primary')?.disabled`);
      await new Promise(resolve => setTimeout(resolve, 120));
      createScreenshot = await shot('create');
      await window.webContents.executeJavaScript(`document.querySelector('.ia-create-project button.primary').click()`);
      await waitFor(`document.querySelector('.ia-project-page h1')?.innerText === 'new-board-project' && document.querySelector('select[aria-label="Project domain"]')?.value === 'pcb'`);
    } finally {dialog.showOpenDialog = showOpenDialog;}
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ia-project-list button')).find(button => button.innerText.includes('Sobel')).click()`);
    await waitFor(`document.querySelector('select[aria-label="Project domain"]')?.value === 'chip'`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-start').click()`);
    await waitFor(`document.querySelector('.ia-domain-pill')?.innerText.includes('Chip')`);
    const screenshots = [projectScreenshot, createScreenshot, await shot('initial')];
    await window.webContents.executeJavaScript(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-workspace')) && !document.querySelector('.ia-workspace-tree')`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-file-tree-toggle').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-file-list button[title="README.md"]'))`);
    if (await window.webContents.executeJavaScript(`document.body.innerText.includes('VIEWER EXAMPLES')`)) throw Error('Reference Viewer fixtures appeared in the project file tree.');
    await window.webContents.executeJavaScript(`document.querySelector('.ia-file-list button[title="README.md"]').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-source-panel pre')?.innerText.includes('Sobel chip design sample'))`);
    screenshots.push(await shot('source'));
    await waitFor(`Boolean(document.querySelector('.ia-file-list button[title="outputs/sobel_netlist.json"]'))`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-file-list button[title="outputs/sobel_netlist.json"]').click()`);
    await waitFor(`document.querySelector('.ia-viewer-footer')?.innerText.includes('NETLIST · Ready')`, 120000);
    const measureNetlist = () => window.webContents.executeJavaScript(`new DOMMatrix(getComputedStyle(document.querySelector('.rp-net-drawing')).transform).a`);
    await require('./navigation-selftest.cjs').verifyNavigation(window, measureNetlist);
    await require('./navigation-selftest.cjs').verifyWheel(window, measureNetlist, (deltaY,ctrlKey) => window.webContents.executeJavaScript(`(() => {const e=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('.rp-net-stage').dispatchEvent(e);return e.defaultPrevented;})()`));
    screenshots.push(await shot('netlist'));
    await window.webContents.executeJavaScript(`const area = document.querySelector('.ia-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'Inspect the netlist signals'); area.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('.ia-chat-actions button[title="Toggle debug logs"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-send').click()`);
    await waitFor(`document.querySelector('.ia-broker-tool:not([open])')?.innerText.includes('chip / rtl')`);
    screenshots.push(await shot('debug'));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-broker-tool>summary').click()`);
    await waitFor(`document.querySelector('.ia-broker-tool[open]')?.innerText.includes('chip.rtl.netlist.inspect') && document.querySelector('.ia-broker-trace')`);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!await window.webContents.executeJavaScript(`(() => {const item=document.querySelector('.ia-broker-tool');const child=item.querySelector('.ia-tool-detail');return item.open && child.getBoundingClientRect().height > 100 && getComputedStyle(child).display !== 'none'})()`)) throw Error('Expanded Broker details are not visible.');
    screenshots.push(await shot('broker-detail'));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-broker-tool>summary').click()`);
    window.webContents.send('agent:event', {type: 'thinking', text: 'First thought\nSecond thought\nThird thought\nFourth thought'});
    window.webContents.send('agent:event', {type: 'tool', id: 'selftest-tool', name: 'read_file', arguments: '{"path":"README.md"}'});
    window.webContents.send('agent:event', {type: 'tool-result', id: 'selftest-tool', error: false, message: 'Read complete', output: 'Project README'});
    window.webContents.send('agent:event', {type: 'done', result: {status: 'completed'}});
    await waitFor(`Boolean(document.querySelector('.ia-thinking')) && !document.querySelector('.ia-thinking p') && document.querySelectorAll('.ia-agent-flow>.ia-agent-tool').length === 1 && !document.querySelector('.ia-agent-flow>.ia-agent-tool[open]')`);
    screenshots.push(await shot('compact-flow'));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-thinking-head').click(); document.querySelector('.ia-agent-flow>.ia-agent-tool summary').click()`);
    await waitFor(`document.querySelector('.ia-thinking p')?.innerText.includes('Fourth thought') && Boolean(document.querySelector('.ia-agent-flow>.ia-agent-tool[open]'))`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-thinking-head').click(); document.querySelector('.ia-agent-flow>.ia-agent-tool summary').click()`);
    for (const [kind, file] of [['layout', 'sobel_layout.gds'], ['waveform', 'sobel_wave.vcd']]) {
      await window.webContents.executeJavaScript(`document.querySelector('.ia-file-list button[title="outputs/${file}"]').click()`);
      await waitFor(`document.querySelector('.ia-viewer-footer')?.innerText.includes('${kind.toUpperCase()} · Ready')`, 120000);
      if (kind === 'waveform') await waitFor(`document.querySelector('.rp-surfer iframe')?.getAttribute('data-signals-ready') === '6'`);
      if (kind === 'layout') {
        const measure = () => window.webContents.executeJavaScript(`Number(document.querySelector('.rp-view-footer span:last-child').innerText.match(/([0-9.]+)×/)[1])`);
        await require('./navigation-selftest.cjs').verifyNavigation(window, measure);
        await require('./navigation-selftest.cjs').verifyWheel(window, measure, (deltaY,ctrlKey) => window.webContents.executeJavaScript(`(() => {const e=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('.rp-canvas-host').dispatchEvent(e);return e.defaultPrevented;})()`));
      }
      if (kind === 'waveform') {
        const frame = window.webContents.mainFrame.frames.find(item => item.url.startsWith('app://surfer/'));
        const measure = async () => {
          const state = await frame.executeJavaScript(`import('./surfer.js').then(module => module.get_state())`);
          const range = state.match(/curr_left:\s*\(([-0-9.e+]+)\),\s*curr_right:\s*\(([-0-9.e+]+)\)/);
          if (!range) throw Error('Surfer native time range is unavailable.');
          return 1 / (Number(range[2]) - Number(range[1]));
        };
        await require('./navigation-selftest.cjs').verifyNavigation(window, measure, {percent:false});
        await require('./navigation-selftest.cjs').verifyWheel(window, measure, (deltaY,ctrlKey) => frame.executeJavaScript(`(() => {const e=new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:${ctrlKey},cancelable:true});document.querySelector('canvas').dispatchEvent(e);return e.defaultPrevented;})()`));
      }
      screenshots.push(await shot(kind));
    }
    await window.webContents.executeJavaScript(`document.querySelector('.ia-settings-button').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-settings-row button'))`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-settings-row button').click()`);
    await waitFor(`document.querySelector('.ia-app').classList.contains('theme-dark')`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ia-settings-row')).find(row => row.innerText.includes('Model API')).querySelector('button').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-model-modal'))`);
    screenshots.push(await shot('settings'));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-model-modal header button').click(); document.querySelector('.ia-sidebar-brand .ia-icon').click(); document.querySelector('.ia-chat-actions button:last-child').click()`);
    await waitFor(`!document.querySelector('.ia-sidebar') && !document.querySelector('.ia-workspace')`);
    console.log(JSON.stringify({ok: true, screenshots}));
    app.quit();
  }
}

app.whenReady().then(createWindow).catch(error => {console.error(error); app.exit(1);});
app.on('window-all-closed', () => {if (process.platform !== 'darwin') app.quit();});
app.on('before-quit', () => {raster?.close(); viewerProtocol?.close(); godotRuntime.close(); kicadRuntime.close(); void sessions.close(); void guiBridge?.close();});
