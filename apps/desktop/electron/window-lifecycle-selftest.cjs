const assert = require('node:assert/strict');
const { once } = require('node:events');

async function run({ app, BrowserWindow, screen, getWindow, getServices }) {
  const services = getServices();
  const displays = ['display-metrics-changed', 'display-removed'];
  const listeners = () => displays.map(name => screen.listenerCount(name));
  const initialListeners = listeners();
  const guestListeners = app.listenerCount('web-contents-created');
  const snapshot = window =>
    window.webContents.executeJavaScript(`(async () => {
      const projects = await window.viewerHost.projectBindings();
      const chats = await window.viewerHost.chats();
      return {
        projectId: projects.activeId,
        projectIds: projects.projects.map(project => project.id).sort(),
        chatId: chats.activeId,
        chatIds: chats.chats.map(chat => chat.id).sort(),
      };
    })()`);
  const initial = await snapshot(getWindow());
  async function waitFor(read, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Window lifecycle selftest timed out: ${label}`);
  }

  for (let cycle = 0; cycle < 3; cycle++) {
    const previous = getWindow();
    const previousId = previous.id;
    const closed = once(previous, 'closed', { signal: AbortSignal.timeout(15000) });
    previous.close();
    await closed;
    assert.equal(previous.isDestroyed(), true);
    assert.equal(getWindow(), undefined);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.deepEqual(
      listeners(),
      initialListeners.map(count => count - 1),
    );
    // Dock clicks enter through Electron's activate event. The repeated events
    // also exercise activation while the replacement renderer is still loading.
    for (let activation = 0; activation < 3; activation++) app.emit('activate');
    await waitFor(
      () => getWindow() && !getWindow().webContents.isLoading(),
      'replacement renderer load',
    );
    const window = getWindow();
    assert.notEqual(window.id, previousId);
    assert.equal(window.isVisible(), true);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.deepEqual(await snapshot(window), initial);
    assert.equal(
      await window.webContents.executeJavaScript(`Boolean(document.querySelector('.ia-columns'))`),
      true,
    );
    assert.deepEqual(listeners(), initialListeners);
    assert.equal(app.listenerCount('web-contents-created'), guestListeners);
    for (const [name, service] of Object.entries(services))
      assert.equal(getServices()[name], service, `${name} survives window recreation`);
  }

  const window = getWindow();
  const minimized = once(window, 'minimize', { signal: AbortSignal.timeout(15000) });
  window.minimize();
  await minimized;
  app.emit('activate');
  await waitFor(() => !window.isMinimized() && window.isVisible(), 'minimized window restore');
  assert.equal(getWindow(), window);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  app.once('before-quit', () => app.emit('activate'));
  app.once('will-quit', () => {
    assert.equal(getWindow(), undefined);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.deepEqual(
      listeners(),
      initialListeners.map(count => count - 1),
    );
    console.log('Window lifecycle selftest passed: close/reopen x3, IPC/state, minimize, quit.');
  });
}

module.exports = { run };
