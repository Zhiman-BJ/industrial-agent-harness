const {z} = require('zod');

const str = (description) => z.string().describe(description);
const num = (description) => z.number().describe(description);
const int = (description) => z.number().int().describe(description);

// Frozen tool surface: canonical id -> real server tool + parameters + risk.
// Every entry is a 1:1 mapping onto the server's real tool (COMPUTER_USE_BROWSER=0
// hides the 12 browser_* tools). The canonical ids are frozen in
// doc/prototype-register.json (computer-use-plugin) and enforced by the architecture test.
const GUI_TOOLS = Object.freeze([
  {
    canonicalId: 'computer-use.app.list', name: 'list_apps', risk: 'read',
    description: 'List running apps with bundle id, pid, window count, and which is frontmost. Call first to learn the exact `app` value other tools accept.',
    parameters: z.object({}),
  },
  {
    canonicalId: 'computer-use.displays.list', name: 'list_displays', risk: 'read',
    description: 'List attached displays with index, resolution, and position for screenshot(display) and multi-monitor coordinates.',
    parameters: z.object({}),
  },
  {
    canonicalId: 'computer-use.app.state', name: 'get_app_state', risk: 'read',
    description: 'Read an app accessibility tree as an outline whose interactive elements carry ids like e12 that click, type_text, set_value accept. Preferred over screenshot when you intend to act: cheaper and exact. Ids are per-snapshot; re-read after UI changes.',
    parameters: z.object({
      app: str('App name, bundle id, or pid exactly as reported by list_apps'),
      query: str('Only elements whose role, label or value contains this text (case-insensitive)').optional(),
      max_depth: int('Maximum nesting depth (default 18)').optional(),
      max_elements: int('Maximum elements before truncation (default 800)').optional(),
      window: z.union([int('0-based window index'), z.string()]).describe('Limit to one window: a 0-based index or "agent"').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.screenshot', name: 'screenshot', risk: 'read',
    description: 'Capture an app window or a whole display as an image. Result states screen origin and pixels-per-point for coordinate conversion. Use to verify outcomes or see content the tree cannot describe; prefer get_app_state to act.',
    parameters: z.object({
      app: str('App name, bundle id, or pid. Captures its largest window. Provide either app or display.').optional(),
      display: int('0-based display index from list_displays. Captures the whole display.').optional(),
      max_width: int('Downscale image to this width in pixels (default 1400)').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.zoom', name: 'zoom', risk: 'read',
    description: 'Capture one screen region at full resolution to read small text, dense tables, or tiny controls a normal screenshot blurs. Region given as two corners in screen coordinates.',
    parameters: z.object({
      x0: num('Left edge, screen coordinates'),
      y0: num('Top edge, screen coordinates'),
      x1: num('Right edge, screen coordinates'),
      y1: num('Bottom edge, screen coordinates'),
      max_width: int('Downscale zoomed image to this width in pixels (default 1400)').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.wait', name: 'wait', risk: 'read',
    description: 'Pause before the next action so the UI can catch up (loads, dialogs, launches). Follow with get_app_state or screenshot to confirm. Sends no input.',
    parameters: z.object({seconds: num('Seconds to wait (default 1, maximum 30)').optional()}),
  },
  {
    canonicalId: 'computer-use.clipboard.read', name: 'clipboard_read', risk: 'read',
    description: 'Read the plain text on the system clipboard, e.g. after cmd+c. The clipboard can hold private data; do not repeat it beyond what the task needs.',
    parameters: z.object({max_chars: int('Maximum characters to return (default 20000, maximum 200000)').optional()}),
  },
  {
    canonicalId: 'computer-use.app.activate', name: 'activate_app', risk: 'mutating',
    description: 'Bring an app window to the foreground with keyboard focus. Call before press_key or type_text when the app is not frontmost. Side effect: the user window loses focus.',
    parameters: z.object({app: str('App name, bundle id, or pid exactly as reported by list_apps')}),
  },
  {
    canonicalId: 'computer-use.app.hover', name: 'hover', risk: 'mutating',
    description: 'Move the agent pointer over an element or position without clicking, to reveal hover menus or tooltips. Follow with get_app_state or screenshot. Pass element_id or x and y, not both.',
    parameters: z.object({
      element_id: str('Element id from the most recent get_app_state, e.g. e12').optional(),
      x: num('Screen x in points, with y when no element_id').optional(),
      y: num('Screen y in points, with x when no element_id').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.click', name: 'click', risk: 'mutating',
    description: 'Click an element by element_id (preferred) or at screen coordinates from a screenshot/zoom. Pass element_id or x and y, not both. Read the target with get_app_state first. Can trigger any user-visible action.',
    parameters: z.object({
      element_id: str('Element id from the most recent get_app_state, e.g. e12. Preferred over coordinates.').optional(),
      x: num('Screen x in points, with y when no element_id').optional(),
      y: num('Screen y in points, with x when no element_id').optional(),
      click_count: int('1 for single (default), 2 for double-click').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.right-click', name: 'right_click', risk: 'mutating',
    description: 'Right-click (secondary click) an element or position to open its context menu. Follow with get_app_state to read items, then click one. Pass element_id or x and y, not both.',
    parameters: z.object({
      element_id: str('Element id from the most recent get_app_state, e.g. e12').optional(),
      x: num('Screen x in points, with y when no element_id').optional(),
      y: num('Screen y in points, with x when no element_id').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.drag', name: 'drag', risk: 'mutating',
    description: 'Press at one point, move, and release at another to drag and drop, move a slider, or select a range. Give each end as an element id or screen coordinates. Verify the result with get_app_state.',
    parameters: z.object({
      from_element_id: str('Element to start the drag on, from get_app_state').optional(),
      from_x: num('Screen x to start at, with from_y when no from_element_id').optional(),
      from_y: num('Screen y to start at, with from_x when no from_element_id').optional(),
      to_element_id: str('Element to release on, from get_app_state').optional(),
      to_x: num('Screen x to release at, with to_y when no to_element_id').optional(),
      to_y: num('Screen y to release at, with to_x when no to_element_id').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.scroll', name: 'scroll', risk: 'mutating',
    description: 'Scroll up/down/left/right by a number of lines, over element_id when given. Use to bring off-screen content into view before get_app_state or screenshot. Only scrolls.',
    parameters: z.object({
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction (default down)').optional(),
      element_id: str('Element to scroll, from get_app_state. Omit to scroll the last inspected app.').optional(),
      amount: int('Number of scroll lines, 1 to 100 (default 5)').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.type', name: 'type_text', risk: 'mutating',
    description: 'Type literal text as keystrokes into the focused field, optionally focusing element_id first. For short entries or fields that reject set_value. Inserted at the caret without clearing. Password fields are refused by default.',
    parameters: z.object({
      text: str('Exact text to type, character by character'),
      element_id: str('Element to focus before typing, from get_app_state. Omit to type into current focus.').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.press-key', name: 'press_key', risk: 'mutating',
    description: 'Press one named key, optionally with modifiers (e.g. key=s modifiers=[cmd] to save, key=return to submit). For shortcuts and navigation. Goes to the focused app; call activate_app or click first when focus is uncertain.',
    parameters: z.object({
      key: str("Key name: a character, or a named key (return, tab, escape, space, delete, backspace, up, down, left, right, home, end, pageup, pagedown, f1-f20, punctuation, numpad keys)"),
      modifiers: z.array(z.string()).describe('Modifier keys held: any of cmd, shift, alt, ctrl, fn').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.app.set-value', name: 'set_value', risk: 'mutating',
    description: "Replace a text field's entire contents in one step through the accessibility API, without keystrokes. Prefer over type_text for long values or when the field already holds text. The previous value is discarded.",
    parameters: z.object({
      element_id: str('Text field to set, from get_app_state'),
      value: str('New complete value for the field'),
    }),
  },
  {
    canonicalId: 'computer-use.app.select-text', name: 'select_text', risk: 'mutating',
    description: 'Select a character range inside a text element, e.g. to copy part of a value or replace that part with type_text. Defaults from `start` to the end. Only the selection changes.',
    parameters: z.object({
      element_id: str('Text element to select in, from get_app_state'),
      start: int('Zero-based character offset to start at (default 0)').optional(),
      length: int('Number of characters to select (default: through the end)').optional(),
    }),
  },
  {
    canonicalId: 'computer-use.clipboard.write', name: 'clipboard_write', risk: 'mutating',
    description: 'Replace the system clipboard with plain text, typically to paste a long value with cmd+v where set_value is rejected. Overwrites whatever was on the clipboard and does not restore it; tell the user.',
    parameters: z.object({text: str('Exact text to place on the clipboard, replacing its contents')}),
  },
]);

const GUI_TOOL_NAMES = new Set(GUI_TOOLS.map(item => item.name));
const GUI_RISK_BY_NAME = Object.fromEntries(GUI_TOOLS.map(item => [item.name, item.risk]));

// Pre-call argument hints. Several GUI tools accept one of several argument
// shapes (element id OR coordinates, app OR display) that zod cannot express
// as a required group; a model that omits everything would otherwise hit the
// server and get an opaque error. The handler checks the shape first and
// answers with the exact fix so the model recovers in one round.
const elementOrPoint = tool => args => {
  if (args.element_id == null && (args.x == null || args.y == null)) {
    return `${tool} needs either \`element_id\` (from the most recent get_app_state) or both \`x\` and \`y\` (screen points from screenshot/zoom). Read the target with get_app_state first.`;
  }
  return null;
};
async function appCandidates(client) {
  try {
    const result = await client.call('list_apps', {});
    const names = result.output.split('\n').map(line => line.split(/\s{2}/)[0]).filter(Boolean).slice(0, 12);
    return names.length ? ` Apps I can see: ${names.join(', ')}.` : '';
  } catch {return '';}
}
const ARG_HINTS = {
  screenshot: async (args, client) => (args.app == null && args.display == null
    ? `screenshot needs either \`app\` (name, bundle id, or pid from list_apps) or \`display\` (0-based index from list_displays).${await appCandidates(client)}`
    : null),
  get_app_state: args => (!args.app ? 'get_app_state needs `app` (name, bundle id, or pid from list_apps).' : null),
  activate_app: args => (!args.app ? 'activate_app needs `app` (name, bundle id, or pid from list_apps).' : null),
  click: elementOrPoint('click'),
  right_click: elementOrPoint('right_click'),
  hover: elementOrPoint('hover'),
  zoom: args => (['x0', 'y0', 'x1', 'y1'].some(key => args[key] == null)
    ? 'zoom needs all four corners `x0`, `y0`, `x1`, `y1` in screen coordinates; take them from the mapping a screenshot or zoom reports.'
    : null),
  drag: args => {
    const from = args.from_element_id != null || (args.from_x != null && args.from_y != null);
    const to = args.to_element_id != null || (args.to_x != null && args.to_y != null);
    if (!from || !to) return 'drag needs a start and an end, each as an element id (`from_element_id`/`to_element_id` from get_app_state) or a coordinate pair (`from_x`/`from_y` and `to_x`/`to_y` in screen points).';
    return null;
  },
  type_text: args => (!args.text ? 'type_text needs `text` (the exact string to type); optionally `element_id` to focus first.' : null),
  press_key: args => (!args.key ? 'press_key needs `key` (a character or a named key like return, tab, escape, f5); optional `modifiers` array from cmd, shift, alt, ctrl, fn.' : null),
  set_value: args => (!args.element_id || args.value == null ? 'set_value needs `element_id` (text field from get_app_state) and `value` (the complete new contents).' : null),
  select_text: args => (!args.element_id ? 'select_text needs `element_id` (text element from get_app_state); optional `start` and `length`.' : null),
  clipboard_write: args => (!args.text ? 'clipboard_write needs `text` (replaces the clipboard contents).' : null),
};

// The handler enforces the execution boundary: the plugin must be enabled in the
// current session, and the tool must be one this bridge declared.
function createComputerUseTools({client, isEnabled, log}) {
  return GUI_TOOLS.map(item => ({
    name: item.name,
    description: item.description,
    parameters: item.parameters,
    handler: async (params) => {
      if (typeof isEnabled !== 'function' || !isEnabled()) {
        return {output: `[denied] The computer-use plugin is not enabled for this session.`, message: 'Plugin disabled'};
      }
      const hint = ARG_HINTS[item.name] ? (await ARG_HINTS[item.name](params || {}, client)) : null;
      if (hint) {
        log?.(item.canonicalId, item.risk, params, {denied: false, invalidArguments: true, hint});
        return {output: `[computer-use usage] ${hint}`, message: 'Missing or invalid arguments'};
      }
      let result;
      try {
        result = await client.call(item.name, params);
      } catch (error) {
        log?.(item.canonicalId, item.risk, params, {denied: false, error: String(error), needsSystemPermission: false});
        return {output: `[computer-use error] ${String(error)}`, message: 'Tool call failed'};
      }
      const images = Array.isArray(result.images) ? result.images : [];
      log?.(item.canonicalId, item.risk, params, {denied: false, isError: result.isError, needsSystemPermission: result.needsSystemPermission, outputBytes: result.outputBytes, imageCount: images.length});
      if (!result.isError && images.length) {
        // The SDK accepts a ContentPart array as output; image_url data URIs
        // are the channel that actually puts pixels in front of the model.
        return {output: [{type: 'text', text: result.output}, ...images.map(image => ({type: 'image_url', image_url: {url: `data:${image.mimeType};base64,${image.data}`}}))], message: 'Tool completed'};
      }
      return {output: result.output, message: result.isError ? 'Tool reported an error' : 'Tool completed'};
    },
  }));
}

module.exports = {GUI_TOOLS, GUI_TOOL_NAMES, GUI_RISK_BY_NAME, createComputerUseTools};
