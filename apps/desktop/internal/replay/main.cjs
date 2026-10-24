'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setName('Industrial Harness Internal Replay');
app.setPath(
  'userData',
  fs.mkdtempSync(path.join(app.getPath('temp'), `industrial-harness-replay-${process.pid}-`)),
);
const guard = process.argv.includes('--replay-selftest')
  ? require('./safety-guard.cjs').installReplaySafetyGuard()
  : null;
const {
  loadReplayInput,
  readReplayImage,
} = require('../../../../packages/harness-recording/src/index.cjs');
const { createReplayController } = require('./controller.cjs');

const argument = process.argv.indexOf('--replay');
const input = argument >= 0 ? process.argv[argument + 1] : null;
if (!input || input.startsWith('--'))
  throw Error('Usage: launch.cjs --replay <directory or .tar.gz>');

app
  .whenReady()
  .then(async () => {
    const controller = createReplayController(await loadReplayInput(path.resolve(input)));
    const partition = session.fromPartition(`replay-${process.pid}`);
    // File-only renderer. Imported content cannot navigate, execute scripts, or
    // make network requests; no live product preload/API is available.
    partition.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:'),
      });
    });
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const window = new BrowserWindow({
      width: 1320,
      height: 920,
      minWidth: 820,
      minHeight: 600,
      title: 'Recording replay · Internal',
      backgroundColor: '#f6f7f9',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: partition,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    function bind(channel, handler) {
      ipcMain.handle(channel, (event, request) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw Error('Replay IPC requires the replay window');
        return handler(request);
      });
    }
    bind('replay:metadata', () => controller.metadata());
    bind('replay:page', request => controller.page(request));
    bind('replay:control', request => controller.control(request));
    bind('replay:flow', request => controller.flow(request));
    bind('replay:image', assetId => controller.image(assetId, readReplayImage));
    let previousMs = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const state = controller.tick(now - previousMs);
      previousMs = now;
      if (!window.isDestroyed()) window.webContents.send('replay:changed', state);
    }, 100);
    window.on('closed', () => {
      clearInterval(timer);
      for (const name of ['metadata', 'page', 'control', 'image', 'flow'])
        ipcMain.removeHandler(`replay:${name}`);
    });
    await window.loadFile(path.join(__dirname, 'dist', 'index.html'));
    if (process.argv.includes('--replay-selftest')) {
      try {
        await require('./selftest.cjs').run(window, controller, guard.calls);
        app.exit(0);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    }
  })
  .catch(error => {
    console.error(error);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
