'use strict';

// Internal recorded-data composition. The product renderer and its preload are
// unchanged; neither the public main process nor its live TaskService is loaded.
const { app, BrowserWindow, ipcMain, protocol, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { windowBounds } = require('../../electron/window-bounds.cjs');
const { createRendererProtocol } = require('./product-protocol.cjs');

function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const input = option('--replay');
const rendererDirectory = path.resolve(
  option('--renderer-dir') || path.join(__dirname, '../../dist'),
);
if (!input || input.startsWith('--')) throw Error('Replay input is required.');
const selftest = process.argv.includes('--replay-selftest');
app.setName('Industrial Harness Recorded Session');
const profile = fs.mkdtempSync(path.join(app.getPath('temp'), 'harness-product-replay-'));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const guard = require('./safety-guard.cjs').installReplaySafetyGuard();
const { loadReplayInput } = require('../../../../packages/harness-recording/src/index.cjs');
const { createProductReplayBackend } = require('./product-backend.cjs');

app
  .whenReady()
  .then(async () => {
    const bundle = await loadReplayInput(path.resolve(input));
    const backend = createProductReplayBackend(bundle);
    if (option('--position'))
      backend.control({ action: 'seek', value: Number(option('--position')) });
    const renderer = createRendererProtocol(rendererDirectory);
    const partition = session.fromPartition(`recorded-product-${process.pid}`);
    const allowedHosts = new Set(['viewer', ...(backend.viewer.protocolHosts || [])]);
    let blockedRequests = 0;
    partition.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed =
        (url.protocol === 'app:' && allowedHosts.has(url.hostname)) ||
        ['devtools:', 'data:', 'blob:'].includes(url.protocol);
      if (!allowed) blockedRequests++;
      callback({ cancel: !allowed });
    });
    partition.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestUrl = details.requestingUrl || contents?.getURL() || '';
      callback(
        permission === 'fullscreen' &&
          contents === window.webContents &&
          details.isMainFrame !== false &&
          requestUrl.startsWith('app://viewer/'),
      );
    });
    partition.protocol.handle('app', request => {
      const host = new URL(request.url).hostname;
      return host !== 'viewer' ? backend.viewer.handleProtocol(request) : renderer.handle(request);
    });
    const productPreload = path.resolve(__dirname, '../../electron/preload.cjs');
    const window = new BrowserWindow({
      ...windowBounds(screen.getPrimaryDisplay().workArea),
      width: Number(option('--width')) || 1600,
      height: Number(option('--height')) || 1000,
      title: 'Industrial Agent Harness · Recorded Session',
      backgroundColor: '#0c1218',
      icon: path.join(rendererDirectory, 'app-icon.png'),
      frame: process.platform === 'darwin',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
      trafficLightPosition: { x: 20, y: 18 },
      webPreferences: {
        preload: productPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        backgroundThrottling: false,
        session: partition,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const uiErrors = [];
    window.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) uiErrors.push(event.message);
    });
    function productSender(event) {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw Error('Recorded product IPC requires the product main frame.');
    }
    // Bind exactly the unchanged production preload surface. The backend exposes
    // a bounded read-only subset and rejects every unsupported/mutating call.
    const channels = new Set(
      [...fs.readFileSync(productPreload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(
        match => match[1],
      ),
    );
    for (const channel of channels)
      ipcMain.handle(channel, (event, payload) => {
        productSender(event);
        return backend.invoke(channel, payload);
      });
    for (const [channel, action] of Object.entries({
      'window:minimize': () => window.minimize(),
      'window:maximize-toggle': () =>
        window.isMaximized() ? window.unmaximize() : window.maximize(),
      'window:close': () => window.close(),
    }))
      ipcMain.on(channel, event => {
        productSender(event);
        action();
      });

    const navigation = require('./product-navigation.cjs').createProductNavigation(window);
    backend.presentationIdle = navigation.idle;
    let controls;
    let refreshing = false;
    let refreshAgain = false;
    async function refreshProductHistory() {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        // Reopen through the existing product handler. No React state, HTML or
        // Viewer state is replaced by the replay host.
        for (let attempt = 0; attempt < 50 && !window.isDestroyed(); attempt++) {
          const clicked = await window.webContents.executeJavaScript(
            `(() => {
          const button = document.querySelector('.ia-sidebar-chat[aria-current="page"]');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()`,
            true,
          );
          if (clicked) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          void refreshProductHistory();
        }
      }
    }
    const unsubscribe = backend.subscribe(({ channel, payload }) => {
      if (window.isDestroyed()) return;
      if (channel === 'replay:history-invalidated') void refreshProductHistory();
      else if (
        channel === 'replay:snapshot-changed' &&
        !selftest &&
        !process.argv.includes('--manual-artifacts')
      )
        void navigation.snapshotChanged().catch(error => uiErrors.push(String(error)));
      else if (!channel.startsWith('replay:')) window.webContents.send(channel, payload);
      if (controls && !controls.isDestroyed())
        controls.webContents.send('replay:changed', backend.controller.snapshot());
    });
    if (!process.argv.includes('--hide-controls') && !selftest) {
      controls = new BrowserWindow({
        width: 480,
        height: 650,
        title: 'Recorded session controls · Internal',
        webPreferences: {
          preload: path.join(__dirname, 'product-controls-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      controls.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      controls.webContents.on('will-navigate', event => event.preventDefault());
      for (const [channel, handler] of Object.entries({
        'replay:metadata': () => backend.controller.metadata(),
        'replay:control': request => backend.control(request),
        'replay:page': request => backend.controller.page(request),
        'replay:select-agent': id => backend.invoke('chat:select', id),
      }))
        ipcMain.handle(channel, (event, request) => {
          if (
            event.sender !== controls.webContents ||
            event.senderFrame !== controls.webContents.mainFrame
          )
            throw Error('Replay controls require their dedicated window.');
          return handler(request);
        });
      await controls.loadFile(path.join(__dirname, 'product-controls.html'));
    }
    let previous = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      backend.tick(now - previous);
      previous = now;
      if (controls && !controls.isDestroyed())
        controls.webContents.send('replay:changed', backend.controller.snapshot());
    }, 100);
    window.on('closed', () => {
      clearInterval(timer);
      navigation.cancel();
      unsubscribe();
      backend.close();
      if (controls && !controls.isDestroyed()) controls.close();
    });
    await window.loadURL('app://viewer/index.html');
    const receipt = {
      pid: process.pid,
      windowId: window.id,
      profile,
      rendererDirectory,
      renderer: renderer.manifest,
      productPreloadSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(productPreload))
        .digest('hex'),
      url: window.webContents.getURL(),
      recordingId: bundle.manifest.recordingId,
      app: 'unchanged complete production App with internal recorded-data backend',
    };
    if (option('--receipt'))
      fs.writeFileSync(path.resolve(option('--receipt')), JSON.stringify(receipt, null, 2) + '\n');
    console.log(
      JSON.stringify({
        productReplayReady: true,
        pid: process.pid,
        windowId: window.id,
        rendererDirectory,
        rendererFiles: renderer.manifest.length,
        recordingId: bundle.manifest.recordingId,
      }),
    );
    if (option('--replay-capture')) {
      try {
        // Explicit trusted local capture driver, never code from a recording.
        await require(path.resolve(option('--replay-capture'))).run(window, backend, guard.calls);
        console.log(JSON.stringify({ captureComplete: true, uiErrors, blockedRequests }));
        app.exit(0);
      } catch (error) {
        console.error(error);
        console.error(JSON.stringify({ uiErrors, blockedRequests }));
        app.exit(1);
      }
    }
    if (selftest) {
      try {
        await require('./product-selftest.cjs').run(window, backend, guard.calls);
        console.log(JSON.stringify({ uiErrors, blockedRequests }));
        app.exit(0);
      } catch (error) {
        console.error(error);
        console.error(JSON.stringify({ uiErrors, blockedRequests }));
        app.exit(1);
      }
    }
  })
  .catch(error => {
    console.error(error);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
