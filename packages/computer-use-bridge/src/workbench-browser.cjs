const { z } = require('zod');

const str = description => z.string().describe(description);
const int = description => z.number().int().describe(description);

// Frozen tool surface for the workspace browser: the agent drives the
// workbench's embedded browser tab (an isolated <webview> guest) through a
// host-side driver injected by the desktop app. Canonical ids are frozen in
// doc/prototype-register.json (workbench-browser-plugin) and enforced by the
// architecture test. Names deliberately avoid the browser_* prefix, which is
// reserved for the upstream computer-use server's (hidden) Chrome tools.
const WORKBENCH_BROWSER_TOOLS = Object.freeze([
  {
    canonicalId: 'workbench-browser.navigate',
    name: 'web_navigate',
    risk: 'mutating',
    description:
      'Open a URL in the workspace browser tab, creating the tab when none is open. Accepts full URLs, bare domains, or search terms (routed to the default search engine). Waits for the load to finish and reports the final URL and title. The user watches the tab live.',
    parameters: z.object({
      url: str('Full URL (https://…), bare domain (example.com), or a search phrase'),
    }),
  },
  {
    canonicalId: 'workbench-browser.snapshot',
    name: 'web_snapshot',
    risk: 'read',
    description:
      'Read the current page as text plus a numbered list of interactive elements (links, buttons, inputs) with refs like e3 that web_click and web_type accept. Preferred over web_screenshot when you intend to act: cheaper and exact. Refs are per-page; re-read after navigation or major page changes.',
    parameters: z.object({
      max_chars: int('Maximum page text characters to return (default 4000)').optional(),
      max_elements: int('Maximum interactive elements before truncation (default 60)').optional(),
    }),
  },
  {
    canonicalId: 'workbench-browser.click',
    name: 'web_click',
    risk: 'mutating',
    description:
      'Click an element by ref (preferred, from the most recent web_snapshot) or at viewport coordinates from a web_screenshot. Pass ref or x and y, not both. Can trigger any user-visible page action; the user sees it happen in the tab.',
    parameters: z.object({
      ref: str('Element ref from the most recent web_snapshot, e.g. e3').optional(),
      x: z.number().describe('Viewport x in CSS pixels, with y when no ref').optional(),
      y: z.number().describe('Viewport y in CSS pixels, with x when no ref').optional(),
    }),
  },
  {
    canonicalId: 'workbench-browser.type',
    name: 'web_type',
    risk: 'mutating',
    description:
      'Focus an element by ref (or keep the current focus) and type text as real keystrokes. Set submit to press Enter afterwards, e.g. to run a search. Does not clear existing content; the text is inserted at the caret.',
    parameters: z.object({
      text: str('Exact text to type'),
      ref: str('Input element to focus first, from web_snapshot').optional(),
      submit: z
        .boolean()
        .describe('Press Enter after typing (default false), e.g. to submit a search')
        .optional(),
    }),
  },
  {
    canonicalId: 'workbench-browser.scroll',
    name: 'web_scroll',
    risk: 'mutating',
    description:
      'Scroll the page up/down/left/right by a number of lines to bring off-screen content into view before web_snapshot or web_screenshot. Only scrolls.',
    parameters: z.object({
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .describe('Scroll direction (default down)')
        .optional(),
      amount: int('Number of scroll lines, 1 to 100 (default 5)').optional(),
    }),
  },
  {
    canonicalId: 'workbench-browser.back',
    name: 'web_back',
    risk: 'mutating',
    description: "Go back one page in the workspace browser history, like the tab's Back button.",
    parameters: z.object({}),
  },
  {
    canonicalId: 'workbench-browser.wait',
    name: 'web_wait',
    risk: 'read',
    description:
      'Pause before the next action so the page can catch up (loads, scripts, dialogs). Follow with web_snapshot to confirm. Sends no input.',
    parameters: z.object({
      seconds: z.number().describe('Seconds to wait (default 1, maximum 30)').optional(),
    }),
  },
  {
    canonicalId: 'workbench-browser.screenshot',
    name: 'web_screenshot',
    risk: 'read',
    description:
      'Capture the current page as an image. Use to verify visual outcomes or read content the text snapshot cannot describe; prefer web_snapshot to act.',
    parameters: z.object({
      max_width: int('Downscale image to this width in pixels (default 1200)').optional(),
    }),
  },
]);

const WORKBENCH_BROWSER_TOOL_NAMES = new Set(WORKBENCH_BROWSER_TOOLS.map(item => item.name));

// Pre-call argument hints, mirroring the desktop GUI tools: shapes zod cannot
// express as a required group get an exact-fix message instead of an opaque
// driver error, so the model recovers in one round.
const ARG_HINTS = {
  web_navigate: args =>
    !args.url ? 'web_navigate needs `url` (full URL, bare domain, or search phrase).' : null,
  web_click: args =>
    args.ref == null && (args.x == null || args.y == null)
      ? 'web_click needs either `ref` (from the most recent web_snapshot) or both `x` and `y` (viewport CSS pixels from web_screenshot).'
      : null,
  web_type: args =>
    !args.text
      ? 'web_type needs `text` (the exact string to type); optionally `ref` to focus first.'
      : null,
};

// The handler enforces the execution boundary: the plugin must be enabled in
// the current session, and every call goes to the host-side driver (the
// desktop main process driving the <webview> guest) — never into the
// sandboxed agent process.
function createWorkbenchBrowserTools({ driver, isEnabled, log }) {
  return WORKBENCH_BROWSER_TOOLS.map(item => ({
    name: item.name,
    description: item.description,
    parameters: item.parameters,
    handler: async params => {
      if (typeof isEnabled !== 'function' || !isEnabled()) {
        return {
          output: `[denied] The workspace browser automation is not enabled for this session.`,
          message: 'Plugin disabled',
        };
      }
      const hint = ARG_HINTS[item.name] ? await ARG_HINTS[item.name](params || {}) : null;
      if (hint) {
        log?.(item.canonicalId, item.risk, params, { denied: false, invalidArguments: true, hint });
        return {
          output: `[workbench-browser usage] ${hint}`,
          message: 'Missing or invalid arguments',
        };
      }
      let result;
      try {
        result = await driver.call(item.name, params);
      } catch (error) {
        log?.(item.canonicalId, item.risk, params, { denied: false, error: String(error) });
        return {
          output: `[workbench-browser error] ${String(error)}`,
          message: 'Tool call failed',
        };
      }
      const images = Array.isArray(result.images) ? result.images : [];
      log?.(item.canonicalId, item.risk, params, {
        denied: false,
        isError: result.isError,
        outputBytes: result.outputBytes,
        imageCount: images.length,
      });
      if (!result.isError && images.length) {
        // The SDK accepts a ContentPart array as output; image_url data URIs
        // are the channel that actually puts pixels in front of the model.
        return {
          output: [
            { type: 'text', text: result.output },
            ...images.map(image => ({
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.data}` },
            })),
          ],
          message: 'Tool completed',
        };
      }
      return {
        output: result.output,
        message: result.isError ? 'Tool reported an error' : 'Tool completed',
      };
    },
  }));
}

module.exports = {
  WORKBENCH_BROWSER_TOOLS,
  WORKBENCH_BROWSER_TOOL_NAMES,
  createWorkbenchBrowserTools,
};
