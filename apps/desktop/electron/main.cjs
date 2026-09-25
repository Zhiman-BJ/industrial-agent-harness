const {app, BrowserWindow, dialog, ipcMain, protocol, safeStorage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {RasterService} = require('../../../packages/viewer-builtin/src/layout/raster.cjs');
const {renderNetlist} = require('../../../packages/viewer-builtin/src/netlist/netlist.cjs');
const {createViewerProtocol} = require('../../../packages/viewer-builtin/src/waveform/protocol.cjs');
const {initialVcdSignals} = require('../../../packages/viewer-builtin/src/waveform/signals.cjs');
const {resolve, discloseDetail} = require('../../../packages/capability-broker/src/index.cjs');
const {resolveProjectTask, effectiveCapabilities, resourceCatalog} = require('@industrial-agent-harness/harness-core');
const {capabilities, listDomains} = require('@industrial-agent-harness/domain-skills');
const {KimiSession} = require('../../../packages/agent-kimi/src/index.cjs');
const {ObservedContextStore} = require('@industrial-agent-harness/domain-runtime');
const {readProfile, saveProfile, validateProfile, writeCliConfig, sessionEnv} = require('./model-config.cjs');
const {readBindings, addBinding, saveBindings} = require('./project-bindings.cjs');

protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}}]);
if (process.argv.includes('--viewer-selftest')) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-selftest-')));

const desktopRoot = path.resolve(__dirname, '..');
const artifacts = new Map();
const netlistSessions = new Map();
let activeLayoutToken;
let raster;
let viewerProtocol;
let brokerScope;
let brokerTrace = [];
let agent;
let contextStore;
let projectDir;
let projectBindings = {projects: [], activeId: null};
let mainWindow;
let sessionApiKey = '';
let modelRevision = 0;

function configDir() {return path.join(app.getPath('userData'), 'model');}
function projectConfigDir() {return path.join(app.getPath('userData'), 'workspace');}
function activeProject() {return projectBindings.projects.find(item => item.id === projectBindings.activeId) || null;}
function projectSnapshot() {return {...projectBindings, projectDir: projectDir || null};}
function clearProjectArtifacts() {
  contextStore?.close(); contextStore = undefined;
  artifacts.clear();
  netlistSessions.clear(); activeLayoutToken = undefined;
}
function observedContext() {
  const domain = activeProject()?.domain;
  if (!projectDir || !domain) throw Error('Choose a project with a domain first.');
  contextStore ||= new ObservedContextStore(projectDir, domain);
  return contextStore;
}
function keyFile() {return path.join(configDir(), 'api-key.bin');}
function canPersistKey() {return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');}
function readApiKey() {
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
function runtimeConfig() {
  const profile = readProfile(configDir());
  const apiKey = readApiKey();
  return {profile, apiKey, revision: modelRevision, executable: kimiExecutable(), shareDir: writeCliConfig(configDir(), profile), env: sessionEnv(profile, apiKey), disabledMcpServers: activeProject()?.disabledMcpServers || []};
}

function kindFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.gds', '.gdsii', '.oas', '.oasis'].includes(ext)) return 'layout';
  if (['.vcd', '.fst', '.ghw'].includes(ext)) return 'waveform';
  if (ext === '.json') {
    const stat = fs.statSync(file);
    if (stat.size <= 20 * 1024 * 1024) {
      try {if (JSON.parse(fs.readFileSync(file, 'utf8'))?.modules) return 'netlist';} catch {}
    }
  }
  throw Error('This Viewer currently supports GDS/OAS, Yosys JSON, and VCD/FST/GHW.');
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

function registerHandlers() {
  ipcMain.handle('broker:domains', () => listDomains(capabilities));
  ipcMain.handle('resource:catalog', () => resourceCatalog(activeProject()?.domain));
  ipcMain.handle('broker:resolve', (_event, request) => {
    const fixedDomain = activeProject()?.domain;
    if (activeProject() && !fixedDomain) throw Error('Set this project’s domain before starting a session.');
    if (agent?.turn) void agent.interrupt();
    const project = activeProject();
    const disabled = {skills: project?.disabledSkills || [], mcpServers: project?.disabledMcpServers || []};
    const result = fixedDomain ? resolveProjectTask(fixedDomain, request, brokerScope, capabilities, disabled) : resolve(request, capabilities, brokerScope);
    brokerScope = result.scope;
    brokerTrace = result.trace;
    return result;
  });
  function loadDetail(capabilityId) {
    const project = activeProject();
    const detail = discloseDetail(brokerScope, effectiveCapabilities(capabilities, {skills: project?.disabledSkills || [], mcpServers: project?.disabledMcpServers || []}), capabilityId);
    brokerTrace.push({level: 'L3', event: 'detail.load', detail: {capabilityId, skills: detail.skills.map(item => item.id), tools: detail.tools.map(item => item.id)}});
    return detail;
  }
  ipcMain.handle('broker:detail', (_event, capabilityId) => loadDetail(capabilityId));
  ipcMain.handle('broker:trace', () => brokerTrace);
  ipcMain.handle('model:get', () => modelStatus());
  ipcMain.handle('model:save', async (_event, request) => {
    if (agent?.turn) throw Error('Stop the current Kimi turn before changing the model.');
    const profile = validateProfile(request);
    if (request.apiKey !== undefined && (typeof request.apiKey !== 'string' || request.apiKey.length > 8192)) throw Error('Invalid API key.');
    await agent?.close(); agent = undefined;
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
  });
  ipcMain.handle('agent:status', () => {
    const executable = kimiExecutable();
    const result = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 3000});
    const help = result.status === 0 ? spawnSync(executable, ['--help'], {encoding: 'utf8', timeout: 3000}) : null;
    const available = !result.error && result.status === 0 && help?.status === 0 && help.stdout.includes('--wire');
    return {available, version: available ? result.stdout.split('\n')[0].trim() : '', projectDir: projectDir || null, configured: Boolean(readApiKey())};
  });
  ipcMain.handle('project:bindings', () => projectSnapshot());
  ipcMain.handle('project:set-domain', async (_event, request) => {
    if (agent?.turn) throw Error('Stop the current turn before changing the project domain.');
    const {id, domain} = request || {};
    if (!listDomains(capabilities).some(item => item.id === domain)) throw Error('Unknown domain.');
    const project = projectBindings.projects.find(item => item.id === id);
    if (!project) throw Error('Unknown project.');
    if (id !== projectBindings.activeId) throw Error('Open this project before changing its domain.');
    if (project.domain === domain) return projectSnapshot();
    await agent?.close(); agent = undefined;
    project.domain = domain;
    brokerScope = undefined; brokerTrace = [];
    saveBindings(projectConfigDir(), projectBindings);
    return projectSnapshot();
  });
  ipcMain.handle('project:set-resource', async (_event, request) => {
    if (agent?.turn) throw Error('Stop the current turn before changing project resources.');
    const project = activeProject();
    if (!project || request?.projectId !== project.id) throw Error('Open this project before changing its resources.');
    const key = request.kind === 'skill' ? 'disabledSkills' : request.kind === 'mcp' ? 'disabledMcpServers' : null;
    if (!key || typeof request.id !== 'string' || typeof request.enabled !== 'boolean') throw Error('Invalid project resource change.');
    const catalog = resourceCatalog(project.domain);
    const entries = request.kind === 'skill' ? catalog.skills : catalog.mcpServers;
    if (!entries.some(item => item.id === request.id)) throw Error('Unknown project resource.');
    const disabled = new Set(project[key] || []);
    if (request.enabled) disabled.delete(request.id); else disabled.add(request.id);
    await agent?.close(); agent = undefined;
    project[key] = [...disabled].sort();
    brokerScope = undefined; brokerTrace = [];
    saveBindings(projectConfigDir(), projectBindings);
    return projectSnapshot();
  });
  ipcMain.handle('project:select', async (_event, id) => {
    if (agent?.turn) throw Error('Stop the current turn before switching projects.');
    const item = projectBindings.projects.find(candidate => candidate.id === id);
    if (!item) throw Error('Unknown project.');
    const actual = fs.realpathSync(item.path);
    if (!fs.statSync(actual).isDirectory()) throw Error('Project directory is unavailable.');
    await agent?.close(); agent = undefined;
    projectBindings.activeId = id; projectDir = actual;
    brokerScope = undefined; brokerTrace = [];
    clearProjectArtifacts();
    saveBindings(projectConfigDir(), projectBindings);
    return projectSnapshot();
  });
  ipcMain.handle('project:choose-directory', async () => {
    const result = await dialog.showOpenDialog({title: 'Choose engineering project', properties: ['openDirectory']});
    return result.canceled ? null : fs.realpathSync(result.filePaths[0]);
  });
  ipcMain.handle('project:create', async (_event, request) => {
    if (agent?.turn) throw Error('Stop the current turn before creating a project.');
    if (!request || !listDomains(capabilities).some(item => item.id === request.domain)) throw Error('Choose a valid project domain.');
    if (typeof request.directory !== 'string' || typeof request.name !== 'string') throw Error('Invalid project details.');
    const next = addBinding(projectBindings, request.directory, request.domain, request.name);
    await agent?.close(); agent = undefined;
    projectBindings = next;
    projectDir = activeProject().path;
    brokerScope = undefined; brokerTrace = [];
    clearProjectArtifacts();
    saveBindings(projectConfigDir(), projectBindings);
    return projectSnapshot();
  });
  ipcMain.handle('agent:new', async () => {
    if (agent?.turn) throw Error('Stop the current turn before starting a new chat.');
    await agent?.close(); agent = undefined;
    brokerScope = undefined; brokerTrace = [];
  });
  ipcMain.handle('project:list', () => {
    if (!projectDir) return [];
    const output = [];
    const walk = (dir, depth) => {
      if (depth > 3 || output.length >= 250) return;
      const entries = fs.readdirSync(dir, {withFileTypes: true}).filter(item => !item.name.startsWith('.') && !['node_modules', 'dist', 'build', '__pycache__', 'target'].includes(item.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
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
  ipcMain.handle('agent:run', (_event, task) => {
    if (!projectDir) throw Error('Choose an engineering project first.');
    if (typeof task !== 'string' || !task.trim()) throw Error('Describe the task first.');
    if (!brokerScope) throw Error('Resolve the task scope first.');
    agent ||= new KimiSession(projectDir, () => brokerScope, id => observedContext().readArtifact(id), loadDetail, event => mainWindow?.webContents.send('agent:event', event), runtimeConfig, undefined, {getBrokerTrace: () => brokerTrace, getContextAnchor: () => observedContext().anchor(), readContextPage: (checkpointId, offset, limit) => observedContext().readPage(checkpointId, offset, limit)});
    void agent.run(task).catch(error => mainWindow?.webContents.send('agent:event', {type: 'error', message: String(error)}));
    return {started: true};
  });
  ipcMain.handle('agent:approve', (_event, {id, response}) => agent?.approve(id, response));
  ipcMain.handle('agent:interrupt', () => agent?.interrupt());
  ipcMain.handle('viewer:open', async (_event, {artifactId}) => {
    const {artifact, file} = await checked(artifactId);
    if (artifact.kind === 'layout') {
      const token = crypto.randomUUID();
      const data = await getRaster().call({op: 'load', path: file, token});
      activeLayoutToken = token;
      return {artifact, kind: 'layout', data};
    }
    if (artifact.kind === 'netlist') {
      const token = crypto.randomUUID();
      const data = await renderNetlist(file);
      netlistSessions.set(token, file);
      return {artifact, kind: 'netlist', data: {...data, token}};
    }
    return {artifact, kind: 'waveform', data: {
      url: viewerProtocol.registerWave(file), name: artifact.name,
      defaultSignals: initialVcdSignals(file),
    }};
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
  projectBindings = readBindings(projectConfigDir(), path.resolve(desktopRoot, '../../examples/chip-sobel'));
  projectDir = activeProject()?.path;
  viewerProtocol = createViewerProtocol(desktopRoot);
  protocol.handle('app', viewerProtocol.handle);
  registerHandlers();
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 650,
    backgroundColor: '#0c1218', title: 'Industrial Agent Harness',
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true},
  });
  mainWindow = window;
  if (process.env.INDUSTRIAL_DEV_URL) await window.loadURL(process.env.INDUSTRIAL_DEV_URL);
  else await window.loadURL('app://viewer/index.html');
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
    await waitFor(`document.querySelectorAll('.ia-project-resources input[type="checkbox"]').length === 3`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-resources input[type="checkbox"]').click()`);
    await waitFor(`!document.querySelector('.ia-project-resources input[type="checkbox"]').checked && window.viewerHost.projectBindings().then(state => state.projects.find(item => item.id === state.activeId)?.disabledSkills.includes('chip.netlist.inspect'))`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-project-resources input[type="checkbox"]').click()`);
    await waitFor(`document.querySelector('.ia-project-resources input[type="checkbox"]').checked && window.viewerHost.projectBindings().then(state => !state.projects.find(item => item.id === state.activeId)?.disabledSkills.includes('chip.netlist.inspect'))`);
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
    await window.webContents.executeJavaScript(`document.querySelector('.ia-workspace-actions button').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-file-list button[title="README.md"]'))`);
    if (await window.webContents.executeJavaScript(`document.body.innerText.includes('VIEWER EXAMPLES')`)) throw Error('Reference Viewer fixtures appeared in the project file tree.');
    await window.webContents.executeJavaScript(`document.querySelector('.ia-file-list button[title="README.md"]').click()`);
    await waitFor(`Boolean(document.querySelector('.ia-source-panel pre')?.innerText.includes('Sobel chip design sample'))`);
    screenshots.push(await shot('source'));
    await waitFor(`Boolean(document.querySelector('.ia-file-list button[title="outputs/sobel_netlist.json"]'))`);
    await window.webContents.executeJavaScript(`document.querySelector('.ia-file-list button[title="outputs/sobel_netlist.json"]').click()`);
    await waitFor(`document.querySelector('.ia-viewer-footer')?.innerText.includes('NETLIST · Ready')`, 120000);
    screenshots.push(await shot('netlist'));
    await window.webContents.executeJavaScript(`const area = document.querySelector('.ia-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'Inspect the netlist signals'); area.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('.ia-chat-actions button').click()`);
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
app.on('before-quit', () => {raster?.close(); viewerProtocol?.close(); void agent?.close();});
