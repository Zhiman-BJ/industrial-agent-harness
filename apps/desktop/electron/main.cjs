const {app, BrowserWindow, dialog, ipcMain, protocol} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {RasterService} = require('../../../packages/viewer-builtin/src/layout/raster.cjs');
const {renderNetlist} = require('../../../packages/viewer-builtin/src/netlist/netlist.cjs');
const {createViewerProtocol} = require('../../../packages/viewer-builtin/src/waveform/protocol.cjs');
const {resolve, discloseDetail} = require('../../../packages/capability-broker/src/index.cjs');
const capabilities = require('../../../packages/domain-skills/src/capabilities.cjs');
const {KimiSession} = require('../../../packages/agent-kimi/src/index.cjs');

protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}}]);
if (process.argv.includes('--viewer-selftest')) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-selftest-')));

const desktopRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(desktopRoot, 'fixtures');
const viewerFixtureRoot = path.resolve(desktopRoot, '../../packages/viewer-builtin/fixtures');
const fixtures = [
  {id: 'reference-layout', kind: 'layout', name: 'FIFO physical layout', design: 'sync_fifo · SKY130', file: path.join(fixtureRoot, 'sync_fifo.gds')},
  {id: 'reference-netlist', kind: 'netlist', name: 'Counter logical netlist', design: 'counter · Yosys', file: path.join(viewerFixtureRoot, 'counter.json')},
  {id: 'reference-waveform', kind: 'waveform', name: 'Counter simulation waveform', design: 'counter · VCD', file: path.join(viewerFixtureRoot, 'counter.vcd')},
];
const artifacts = new Map();
const netlistSessions = new Map();
let activeLayoutToken;
let raster;
let viewerProtocol;
let brokerScope;
let brokerTrace = [];
let agent;
let projectDir;
let mainWindow;

function kindFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.gds', '.gdsii', '.oas', '.oasis'].includes(ext)) return 'layout';
  if (['.vcd', '.fst', '.ghw'].includes(ext)) return 'waveform';
  if (ext === '.json') return 'netlist';
  throw Error('This Viewer currently supports GDS/OAS, Yosys JSON, and VCD/FST/GHW.');
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
  const artifact = {
    id: entry.id, kind: entry.kind, name: entry.name, design: entry.design,
    sizeBytes: stat.size, sha256: await digest(file),
    source: entry.id.startsWith('reference-') ? 'reference fixture' : 'user selected file',
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
  ipcMain.handle('broker:resolve', (_event, request) => {
    if (agent?.turn) void agent.interrupt();
    const result = resolve(request, capabilities, brokerScope);
    brokerScope = result.scope;
    brokerTrace = result.trace;
    return result;
  });
  function loadDetail(capabilityId) {
    const detail = discloseDetail(brokerScope, capabilities, capabilityId);
    brokerTrace.push({level: 'L3', event: 'detail.load', detail: {capabilityId, skills: detail.skills.map(item => item.id), tools: detail.tools.map(item => item.id)}});
    return detail;
  }
  ipcMain.handle('broker:detail', (_event, capabilityId) => loadDetail(capabilityId));
  ipcMain.handle('broker:trace', () => brokerTrace);
  ipcMain.handle('agent:status', () => {
    const executable = process.env.KIMI_EXECUTABLE || 'kimi';
    const result = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 3000});
    return {available: !result.error && result.status === 0, version: result.status === 0 ? result.stdout.trim() : '', projectDir: projectDir || null};
  });
  ipcMain.handle('agent:choose-project', async () => {
    const result = await dialog.showOpenDialog({title: 'Choose engineering project', properties: ['openDirectory']});
    if (result.canceled) return projectDir || null;
    await agent?.close(); agent = undefined;
    projectDir = fs.realpathSync(result.filePaths[0]);
    return projectDir;
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
    if (!projectDir || typeof relative !== 'string') throw Error('Choose a project first.');
    const file = fs.realpathSync(path.resolve(projectDir, relative));
    if (!file.startsWith(projectDir + path.sep)) throw Error('File is outside the selected project.');
    return registerArtifact({id: crypto.randomUUID(), kind: kindFor(file), name: path.basename(file), design: path.basename(projectDir), file});
  });
  ipcMain.handle('agent:run', (_event, task) => {
    if (!projectDir) throw Error('Choose an engineering project first.');
    if (typeof task !== 'string' || !task.trim()) throw Error('Describe the task first.');
    if (!brokerScope) throw Error('Resolve capabilities first.');
    agent ||= new KimiSession(projectDir, () => brokerScope, async id => (await checked(id)).artifact, loadDetail, event => mainWindow?.webContents.send('agent:event', event));
    void agent.run(task).catch(error => mainWindow?.webContents.send('agent:event', {type: 'error', message: String(error)}));
    return {started: true};
  });
  ipcMain.handle('agent:approve', (_event, {id, response}) => agent?.approve(id, response));
  ipcMain.handle('agent:interrupt', () => agent?.interrupt());
  ipcMain.handle('viewer:list', async () => {
    if (!artifacts.size) await Promise.all(fixtures.map(registerArtifact));
    return [...artifacts.values()].map(item => item.artifact);
  });
  ipcMain.handle('viewer:choose', async () => {
    const result = await dialog.showOpenDialog({title: 'Open engineering artifact', properties: ['openFile'], filters: [
      {name: 'Viewable artifacts', extensions: ['gds', 'gdsii', 'oas', 'oasis', 'json', 'vcd', 'fst', 'ghw']},
    ]});
    if (result.canceled) return null;
    const file = fs.realpathSync(result.filePaths[0]);
    return registerArtifact({id: crypto.randomUUID(), kind: kindFor(file), name: path.basename(file), design: 'Selected file', file});
  });
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
      defaultSignals: artifactId === 'reference-waveform' ? ['tb.dut.count', 'tb.dut.enable'] : [],
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
    async function waitFor(text, timeout = 20000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Error(`Desktop UI did not show ${text}.`);
    }
    async function waitForViewer(kind) {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const state = await window.webContents.executeJavaScript(`({ready: document.querySelector('.ia-viewer-header span')?.innerText, active: document.querySelector('.ia-viewer-tabs button.active')?.innerText})`);
        if (state.ready === 'Ready' && state.active === kind) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Error(`Viewer ${kind} did not become ready.`);
    }
    await waitForViewer('Netlist');
    const output = process.env.VIEWER_SELFTEST_SCREENSHOT || path.join(app.getPath('temp'), 'industrial-viewer-selftest.png');
    fs.writeFileSync(output, await window.webContents.capturePage().then(image => image.toPNG()));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-suggestions button').click(); document.querySelector('.ia-chat-actions button').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-send').click()`);
    await waitFor('Broker disclosure log');
    await waitFor('chip.rtl.netlist.inspect');
    await new Promise(resolve => setTimeout(resolve, 120));
    const debugOutput = output.replace(/\.png$/, '-debug.png');
    fs.writeFileSync(debugOutput, await window.webContents.capturePage().then(image => image.toPNG()));
    for (const kind of ['Layout', 'Waveform']) {
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ia-viewer-tabs button')).find(button => button.innerText === ${JSON.stringify(kind)}).click()`);
      await waitForViewer(kind);
      const kindOutput = output.replace(/\.png$/, `-${kind.toLowerCase()}.png`);
      fs.writeFileSync(kindOutput, await window.webContents.capturePage().then(image => image.toPNG()));
    }
    await window.webContents.executeJavaScript(`document.querySelector('.ia-settings-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-settings-row button').click()`);
    const dark = await window.webContents.executeJavaScript(`document.querySelector('.ia-app').classList.contains('theme-dark')`);
    if (!dark) throw Error('Dark theme did not activate.');
    await new Promise(resolve => setTimeout(resolve, 180));
    const darkOutput = output.replace(/\.png$/, '-dark.png');
    fs.writeFileSync(darkOutput, await window.webContents.capturePage().then(image => image.toPNG()));
    await window.webContents.executeJavaScript(`document.querySelector('.ia-top-left button').click(); document.querySelector('.ia-top-right button').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const collapsed = await window.webContents.executeJavaScript(`!document.querySelector('.ia-tree') && !document.querySelector('.ia-viewer')`);
    if (!collapsed) throw Error('Sidebars did not collapse.');
    console.log(JSON.stringify({ok: true, screenshots: [output, debugOutput, output.replace(/\.png$/, '-layout.png'), output.replace(/\.png$/, '-waveform.png'), darkOutput]}));
    app.quit();
  }
}

app.whenReady().then(createWindow).catch(error => {console.error(error); app.exit(1);});
app.on('window-all-closed', () => {if (process.platform !== 'darwin') app.quit();});
app.on('before-quit', () => {raster?.close(); viewerProtocol?.close(); void agent?.close();});
