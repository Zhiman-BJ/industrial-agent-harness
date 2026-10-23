'use strict';

// Replay drives ordinary product controls; it never reaches into React state
// or substitutes markup/canvas data. The same actions can be performed by a user.
function createProductNavigation(window) {
  let generation = 0;
  let pending = Promise.resolve();
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  async function wait(check, current) {
    const end = Date.now() + 30000;
    while (current() && Date.now() < end && !window.isDestroyed()) {
      if (await check()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  function snapshotChanged() {
    const selectedGeneration = ++generation;
    const current = () => selectedGeneration === generation;
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (!current() || window.isDestroyed()) return;
        const previous = await evaluate(`(() => {
        const view = document.querySelector('.ia-file-view:not([hidden])');
        const modes = view ? [...view.querySelectorAll('header button[aria-pressed="true"][aria-label]')].map(button=>button.getAttribute('aria-label')) : [];
        const path = view?.getAttribute('data-file-path');
        const treeOpen = document.querySelector('.ia-file-tree-toggle')?.getAttribute('aria-pressed') === 'true';
        if (path) {
          if (!treeOpen) document.querySelector('.ia-file-tree-toggle')?.click();
          document.querySelector('.ia-viewer-header > div:first-child > button:last-child')?.click();
        }
        return {path, modes, treeOpen};
      })()`);
        await wait(() => evaluate(`Boolean(document.querySelector('.ia-file-refresh'))`), current);
        if (!current()) return;
        await evaluate(`document.querySelector('.ia-file-refresh')?.click()`);
        if (!previous.path) return;
        const found = await wait(
          () =>
            evaluate(`(() => {
        const button = [...document.querySelectorAll('.ia-file-list button')].find(button=>button.title===${JSON.stringify(previous.path)});
        if (!button) return false; button.click(); return true;
      })()`),
          current,
        );
        if (!found || !current()) return;
        for (const label of previous.modes) {
          await wait(
            () =>
              evaluate(`(() => {
          const button = [...document.querySelectorAll('.ia-file-view:not([hidden]) header button[aria-label]')].find(button=>button.getAttribute('aria-label')===${JSON.stringify(label)});
          if (!button || button.disabled) return false;
          if(button.getAttribute('aria-pressed')!=='true')button.click();
          return true;
        })()`),
            current,
          );
        }
        if (!previous.treeOpen && current())
          await evaluate(
            `(() => {const button=document.querySelector('.ia-file-tree-toggle');if(button?.getAttribute('aria-pressed')==='true')button.click();})()`,
          );
      });
    return pending;
  }
  return {
    snapshotChanged,
    idle: () => pending,
    cancel: () => {
      generation++;
    },
  };
}
module.exports = { createProductNavigation };
