const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(t) {
  const { attachModalFocus } = await import('../src/modal-focus.ts');
  const document = { activeElement: null };
  class Element extends EventTarget {
    tabIndex = 0;
    isConnected = true;
    disabled = false;
    visible = true;
    visibility = 'visible';
    controls = [];
    focus() {
      document.activeElement = this;
    }
    matches() {
      return this.disabled;
    }
    getClientRects() {
      return this.visible ? [{}] : [];
    }
    querySelectorAll() {
      return this.controls;
    }
  }
  for (const [key, value] of Object.entries({
    document,
    HTMLElement: Element,
    getComputedStyle: node => ({ visibility: node.visibility }),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key],
    );
  }
  const opener = new Element(),
    modal = new Element(),
    first = new Element(),
    last = new Element();
  opener.focus();
  modal.controls = [first, last];
  let closed = 0;
  const cleanup = attachModalFocus(modal, () => closed++);
  const key = (name, options = {}) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({ key: name, ...options }).map(([k, value]) => [k, { value }]),
      ),
    );
    modal.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { document, opener, modal, first, last, Element, cleanup, key, closed: () => closed };
}

test('modal initial focus, forward/reverse entry, wrapping and cleanup', async t => {
  const f = await fixture(t);
  assert.equal(f.document.activeElement, f.modal);
  assert.equal(f.key('Tab', { shiftKey: true }), true);
  assert.equal(f.document.activeElement, f.last);
  f.key('Tab');
  assert.equal(f.document.activeElement, f.first);
  f.key('Tab', { shiftKey: true });
  assert.equal(f.document.activeElement, f.last);
  f.modal.focus();
  f.key('Tab');
  assert.equal(f.document.activeElement, f.first);
  assert.equal(f.key('Tab'), false, 'interior tab uses native browser traversal');
  f.cleanup();
  assert.equal(f.document.activeElement, f.opener);
  f.key('Escape');
  assert.equal(f.closed(), 0, 'listener removed');
});

test('modal recalculates disabled, hidden and negative-tabindex controls on every key', async t => {
  const f = await fixture(t);
  const hidden = new f.Element(),
    disabled = new f.Element(),
    excluded = new f.Element();
  hidden.visible = false;
  disabled.disabled = true;
  excluded.tabIndex = -1;
  f.modal.controls = [hidden, disabled, excluded, f.first, f.last];
  f.key('Tab');
  assert.equal(f.document.activeElement, f.first);
  f.last.visibility = 'hidden';
  f.key('Tab');
  assert.equal(f.document.activeElement, f.first);
  f.first.disabled = true;
  f.key('Tab');
  assert.equal(f.document.activeElement, f.modal);
  f.cleanup();
});

test('Escape respects IME composition and consumed events; detached opener is not focused', async t => {
  const f = await fixture(t);
  f.key('Escape', { isComposing: true });
  assert.equal(f.closed(), 0);
  f.key('Escape', { defaultPrevented: true });
  assert.equal(f.closed(), 0);
  assert.equal(f.key('Escape'), true);
  assert.equal(f.closed(), 1);
  f.opener.isConnected = false;
  f.cleanup();
  assert.notEqual(f.document.activeElement, f.opener);
});
