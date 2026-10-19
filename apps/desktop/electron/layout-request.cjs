// Read-only layout requests can finish after their window has been closed.
// Check liveness before accessing Electron frame properties and at every await.
function liveWorkspace(event, owner) {
  if (!owner || owner.isDestroyed()) return false;
  const contents = owner.webContents;
  if (contents.isDestroyed() || event.sender.isDestroyed()) return false;
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame)
    throw Error('Layout viewing is only available from the workspace.');
  return true;
}

async function layoutRequest({ event, getWindow, validate, render }) {
  const live = () => liveWorkspace(event, getWindow());
  try {
    if (!live()) return;
    await validate();
    if (!live()) return;
    const result = await render();
    if (!live()) return;
    await validate();
    if (!live()) return;
    return result;
  } catch (error) {
    if (!live()) return;
    throw error;
  }
}

module.exports = { layoutRequest };
