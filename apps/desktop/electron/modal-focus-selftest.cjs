const assert = require('node:assert/strict');

// Exercise actual rendered controls, including dynamically disabled/hidden fields.
async function check(window, selector) {
  const result = await window.webContents.executeJavaScript(
    `(() => {
    const modal = document.querySelector(${JSON.stringify(selector)});
    const controls = Array.from(modal.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]'))
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const first = controls[0], last = controls.at(-1);
    const key = (shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', shiftKey, bubbles: true, cancelable: true}));
    const initial = modal === document.activeElement;
    modal.focus(); key(true);
    const reverseEntry = document.activeElement === last;
    key();
    const forwardWrap = document.activeElement === first;
    key(true);
    const reverseWrap = document.activeElement === last;
    modal.focus(); key();
    const forwardEntry = document.activeElement === first;
    // An IME candidate-window Escape must not dismiss the dialog.
    first.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, bubbles: true, cancelable: true}));
    return {initial, reverseEntry, forwardWrap, reverseWrap, forwardEntry, composing: modal.isConnected};
  })()`,
    true,
  );
  assert.deepEqual(
    result,
    {
      initial: true,
      reverseEntry: true,
      forwardWrap: true,
      reverseWrap: true,
      forwardEntry: true,
      composing: true,
    },
    `${selector}: modal keyboard boundaries`,
  );
}
module.exports = { check };
