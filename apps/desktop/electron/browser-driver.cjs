const {
  WORKBENCH_BROWSER_TOOLS,
  createWorkbenchBrowserTools,
  materializeWorkbenchBrowserSkill,
} = require('@industrial-agent-harness/computer-use-bridge');

// Drives the workspace browser tab (the <webview> guest created by
// BrowserPanel) on behalf of the workbench-browser plugin. Everything runs in
// the main process: the guest is located through the registry below, pages
// are read and acted on through executeJavaScript / sendInputEvent, and the
// user watches every action live in the tab. The guest keeps its existing
// isolation — no preload, no Node, in-memory partition; the agent never
// enters the guest process, it only sends commands from the host side.
const guests = new Map();
let lastGuestId = null;

function registerGuest(contents) {
  if (!contents || contents.isDestroyed()) return;
  guests.set(contents.id, contents);
  lastGuestId = contents.id;
  contents.once('destroyed', () => {
    guests.delete(contents.id);
    if (lastGuestId === contents.id) lastGuestId = null;
  });
}

function pickGuest() {
  const preferred = lastGuestId != null ? guests.get(lastGuestId) : null;
  if (preferred && !preferred.isDestroyed()) return preferred;
  for (const contents of guests.values()) if (!contents.isDestroyed()) return contents;
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Same routing as the BrowserPanel address bar: full URLs pass through, bare
// domains get https://, anything else is a search on the default engine. Any
// scheme counts (data:, about:, app://), not just hierarchical `://` URLs.
function normalizeAddress(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+([/?#:].*)?$/.test(value)) return `https://${value}`;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(value)}`;
}

// Reads the page as text plus a numbered list of visible interactive
// elements. The elements array is kept on window.__waRefs so web_click /
// web_type can resolve refs (e3) until the next snapshot replaces them.
const SNAPSHOT_SCRIPT = `(() => {
  const maxChars = %MAXCHARS%, maxElements = %MAXELEMENTS%;
  const text = ((document.body && document.body.innerText) || '')
    .replace(/[ \\t]+/g, ' ').replace(/\\n\\s+/g, '\\n').trim();
  const candidates = document.querySelectorAll(
    'a[href], button, input, textarea, select, [role="button"], [onclick], summary, [contenteditable="true"]'
  );
  const refs = [];
  const elements = [];
  for (const el of candidates) {
    if (elements.length >= maxElements) break;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
    const ref = 'e' + (refs.length + 1);
    refs.push(el);
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      label: label || undefined,
      href: el.tagName === 'A' ? el.href : undefined,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      offscreen: r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || undefined,
    });
  }
  window.__waRefs = refs;
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, maxChars),
    textTruncated: text.length > maxChars,
    elements,
    elementsTruncated: candidates.length > elements.length,
  };
})()`;

function resolveRefScript(ref, action) {
  const index = Number.parseInt(String(ref).replace(/^e/, ''), 10);
  if (!Number.isInteger(index) || index < 1) return null;
  return `(() => {
    const refs = window.__waRefs || [];
    const el = refs[${index - 1}];
    if (!el || !el.isConnected) return 'stale';
    el.scrollIntoView({ block: 'center', inline: 'center' });
    ${action}
    return 'ok';
  })()`;
}

function createBrowserDriver({ getWindow, openWaitMs = 8000 }) {
  async function ensureGuest() {
    let guest = pickGuest();
    if (guest) return guest;
    const window = getWindow?.();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed())
      throw Error('The workbench window is not available; open the app window first.');
    window.webContents.send('browser:open');
    const until = Date.now() + openWaitMs;
    while (Date.now() < until) {
      await sleep(150);
      guest = pickGuest();
      if (guest) return guest;
    }
    throw Error(
      'The workspace browser tab did not open in time. Open it once manually (globe icon) and retry.',
    );
  }

  function requireGuest() {
    const guest = pickGuest();
    if (!guest)
      throw Error('No workspace browser tab is open. Call web_navigate first to open one.');
    return guest;
  }

  async function settled(guest, ms = 600) {
    await sleep(ms);
    return guest.isDestroyed() ? null : guest;
  }

  async function describe(guest, prefix) {
    if (guest.isDestroyed()) return `${prefix} (the browser tab was closed)`;
    try {
      const title = await guest.executeJavaScript('document.title');
      return `${prefix} — now at ${guest.getURL()} — "${title}"`;
    } catch {
      return `${prefix} — now at ${guest.getURL()}`;
    }
  }

  const operations = {
    async web_navigate({ url }) {
      const target = normalizeAddress(url);
      const guest = await ensureGuest();
      try {
        await guest.loadURL(target);
      } catch (error) {
        // ERR_ABORTED means another navigation interrupted this one; anything
        // else is a real load failure worth reporting to the model.
        if (!String(error).includes('ERR_ABORTED'))
          return { output: `Failed to load ${target}: ${error.message}`, isError: true };
      }
      return { output: await describe(guest, `Navigated to ${target}`) };
    },

    async web_snapshot({ max_chars = 4000, max_elements = 60 } = {}) {
      const guest = requireGuest();
      const script = SNAPSHOT_SCRIPT.replace('%MAXCHARS%', Math.max(200, max_chars | 0)).replace(
        '%MAXELEMENTS%',
        Math.max(1, max_elements | 0),
      );
      const page = await guest.executeJavaScript(script, true);
      const lines = [`URL: ${page.url}`, `Title: ${page.title}`, '', page.text];
      if (page.textTruncated) lines.push('… [text truncated]');
      lines.push('', `Interactive elements (${page.elements.length}):`);
      for (const el of page.elements) {
        const parts = [el.ref, `<${el.tag}${el.type ? ` type=${el.type}` : ''}>`];
        if (el.label) parts.push(`"${el.label}"`);
        if (el.href) parts.push(el.href);
        parts.push(`at (${el.x},${el.y})`);
        if (el.offscreen) parts.push('[offscreen — scroll first]');
        lines.push(parts.join(' '));
      }
      if (page.elementsTruncated) lines.push('… [elements truncated; scroll or narrow the page]');
      return { output: lines.join('\n'), outputBytes: lines.join('\n').length };
    },

    async web_click({ ref, x, y }) {
      const guest = requireGuest();
      if (ref != null) {
        const script = resolveRefScript(
          ref,
          "el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); el.click();",
        );
        if (!script) return { output: `Invalid ref "${ref}". Refs look like e3.`, isError: true };
        const outcome = await guest.executeJavaScript(script, true);
        if (outcome === 'stale')
          return {
            output: `Element ${ref} is gone (page changed). Take a fresh web_snapshot.`,
            isError: true,
          };
        if (!(await settled(guest))) return { output: `Clicked ${ref}; the browser tab closed.` };
        return { output: await describe(guest, `Clicked ${ref}`) };
      }
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      if (!(await settled(guest)))
        return { output: `Clicked (${x},${y}); the browser tab closed.` };
      return { output: await describe(guest, `Clicked (${x},${y})`) };
    },

    async web_type({ text, ref, submit }) {
      const guest = requireGuest();
      if (ref != null) {
        const script = resolveRefScript(ref, 'el.focus();');
        if (!script) return { output: `Invalid ref "${ref}". Refs look like e3.`, isError: true };
        const outcome = await guest.executeJavaScript(script, true);
        if (outcome === 'stale')
          return {
            output: `Element ${ref} is gone (page changed). Take a fresh web_snapshot.`,
            isError: true,
          };
      }
      guest.insertText(String(text));
      if (submit) {
        await guest.executeJavaScript(`(() => {
          const el = document.activeElement || document.body;
          for (const type of ['keydown', 'keypress', 'keyup'])
            el.dispatchEvent(new KeyboardEvent(type, {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
            }));
        })()`);
      }
      if (!(await settled(guest))) return { output: 'Typed text; the browser tab closed.' };
      return {
        output: await describe(
          guest,
          `Typed ${JSON.stringify(String(text).slice(0, 60))}${submit ? ' and pressed Enter' : ''}`,
        ),
      };
    },

    async web_scroll({ direction = 'down', amount = 5 } = {}) {
      const guest = requireGuest();
      const lines = Math.min(100, Math.max(1, amount | 0)) * 40;
      const [dx, dy] =
        direction === 'up'
          ? [0, -lines]
          : direction === 'left'
            ? [-lines, 0]
            : direction === 'right'
              ? [lines, 0]
              : [0, lines];
      const position = await guest.executeJavaScript(
        `window.scrollBy(${dx}, ${dy}), JSON.stringify({ x: scrollX, y: scrollY })`,
        true,
      );
      return { output: `Scrolled ${direction} by ${amount} lines; now at ${position}.` };
    },

    async web_back() {
      const guest = requireGuest();
      if (!guest.canGoBack())
        return { output: 'No earlier page in the browser history.', isError: true };
      guest.goBack();
      if (!(await settled(guest))) return { output: 'Went back; the browser tab closed.' };
      return { output: await describe(guest, 'Went back') };
    },

    async web_wait({ seconds = 1 } = {}) {
      const clamped = Math.min(30, Math.max(0, Number(seconds) || 0));
      await sleep(clamped * 1000);
      return { output: `Waited ${clamped}s.` };
    },

    async web_screenshot({ max_width = 1200 } = {}) {
      const guest = requireGuest();
      let image = await guest.capturePage();
      const size = image.getSize();
      if (!size.width || !size.height)
        return {
          output: 'The page rendered an empty frame; try web_wait then retry.',
          isError: true,
        };
      const limit = Math.max(200, max_width | 0);
      if (size.width > limit) image = image.resize({ width: limit });
      const scaled = image.getSize();
      return {
        output: `Screenshot of ${guest.getURL()} (${scaled.width}×${scaled.height}px${
          scaled.width !== size.width ? `, downscaled from ${size.width}×${size.height}` : ''
        }).`,
        images: [{ mimeType: 'image/png', data: image.toPNG().toString('base64') }],
      };
    },
  };

  // One guest, one action at a time: calls serialize through a FIFO chain so a
  // snapshot's refs cannot be invalidated by an interleaved navigation from
  // another session. A queued caller merely awaits its turn.
  let queueTail = Promise.resolve();
  return {
    call: (name, args) => {
      const operation = operations[name];
      const run = queueTail.then(() =>
        operation
          ? operation(args || {})
          : { output: `Unknown browser operation ${name}.`, isError: true },
      );
      queueTail = run.catch(() => {});
      return run;
    },
  };
}

// The plugin consumed by both the session runtime and the settings UI.
// Enabling it is the authorization; every call is recorded through the
// per-session diagnostics log sink.
function createWorkbenchBrowserPlugin({ enabled, getWindow, log } = {}) {
  const driver = createBrowserDriver({ getWindow });
  const isEnabled = () => (typeof enabled === 'function' ? enabled() : Boolean(enabled));
  return {
    name: 'workbench-browser',
    // Host-side execution, explicit enable toggle, per-call diagnostics —
    // same trust model as the computer-use plugin.
    protectedSafe: true,
    enabled: isEnabled,
    toolNames: WORKBENCH_BROWSER_TOOLS.map(item => item.name),
    materializeSkill: directory => materializeWorkbenchBrowserSkill(directory),
    toolsFactory: sessionLog =>
      createWorkbenchBrowserTools({ driver, isEnabled, log: sessionLog || log }),
  };
}

module.exports = { registerGuest, createBrowserDriver, createWorkbenchBrowserPlugin };
