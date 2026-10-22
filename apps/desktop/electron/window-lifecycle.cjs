function createWindowLifecycle({ getWindow, createWindow, isQuitting }) {
  let opening;

  function open() {
    if (isQuitting()) return Promise.resolve(null);
    if (opening) return opening;
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return Promise.resolve(window);
    }
    opening = Promise.resolve()
      .then(() => (isQuitting() ? null : createWindow()))
      .finally(() => {
        opening = undefined;
      });
    return opening;
  }

  return { open };
}

module.exports = { createWindowLifecycle };
