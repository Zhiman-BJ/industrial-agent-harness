const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {GUI_TOOLS, GUI_TOOL_NAMES, createComputerUseTools} = require('../src/tools.cjs');

test('the GUI tool surface has 18 declared canonical tools, browser tools excluded', () => {
  assert.equal(GUI_TOOLS.length, 18);
  const canonical = GUI_TOOLS.map(item => item.canonicalId).sort();
  assert.equal(new Set(canonical).size, 18);
  for (const item of GUI_TOOLS) assert.ok(GUI_TOOL_NAMES.has(item.name), item.name);
  for (const item of GUI_TOOLS) assert.ok(!item.name.startsWith('browser_'), item.name);
  assert.equal(GUI_TOOLS.filter(item => item.risk === 'read').length, 7);
});

test('an enabled plugin tool forwards to the client and logs the call', async () => {
  const calls = [];
  const client = {call: async (name, args) => {calls.push({name, args}); return {output: 'ok', isError: false, needsSystemPermission: false, outputBytes: 2};}};
  const log = [];
  const tools = createComputerUseTools({client, isEnabled: () => true, log: (id, risk, args, info) => log.push({id, risk, args, info})});
  const list = tools.find(item => item.name === 'list_apps');
  const result = await list.handler({});
  assert.deepEqual(result, {output: 'ok', message: 'Tool completed'});
  assert.deepEqual(calls, [{name: 'list_apps', args: {}}]);
  assert.equal(log[0].id, 'computer-use.app.list');
});

test('a disabled plugin refuses the call without touching the client', async () => {
  let touched = false;
  const client = {call: async () => {touched = true;}};
  const tools = createComputerUseTools({client, isEnabled: () => false, log: () => {}});
  const click = tools.find(item => item.name === 'click');
  const result = await click.handler({element_id: 'e1'});
  assert.match(result.output, /not enabled for this session/);
  assert.equal(touched, false);
});

test('a disabled mid-session tool call is rejected by the handler', async () => {
  let enabled = true;
  const client = {call: async () => ({output: 'ok', isError: false, outputBytes: 2})};
  const tools = createComputerUseTools({client, isEnabled: () => enabled, log: () => {}});
  const state = tools.find(item => item.name === 'get_app_state');
  assert.equal((await state.handler({app: 'Notes'})).output, 'ok');
  enabled = false;
  const denied = await state.handler({app: 'Notes'});
  assert.match(denied.output, /not enabled for this session/);
});

test('server errors and permission errors surface as structured output', async () => {
  const tools = createComputerUseTools({client: {call: async () => ({output: '[computer-use error] Screen Recording is not granted', isError: true, needsSystemPermission: true, outputBytes: 40})}, isEnabled: () => true, log: () => {}});
  const shot = tools.find(item => item.name === 'screenshot');
  const result = await shot.handler({display: 0});
  assert.match(result.output, /Screen Recording is not granted/);
});

test('client failures are reported, not thrown into the tool loop', async () => {
  const log = [];
  const tools = createComputerUseTools({client: {call: async () => {throw new Error('server exited');}}, isEnabled: () => true, log: (id, risk, args, info) => log.push({info})});
  const list = tools.find(item => item.name === 'list_apps');
  const result = await list.handler({});
  assert.match(result.output, /server exited/);
  assert.deepEqual(log[0].info, {denied: false, error: 'Error: server exited', needsSystemPermission: false});
});

test('missing arguments are answered with an actionable hint instead of hitting the server', async () => {
  const calls = [];
  const client = {call: async (name, args) => {calls.push(name); return {output: 'ChatGPT  [com.openai.codex]  pid=1  windows=1\nElectron  [com.github.Electron]  pid=2  windows=1', isError: false, outputBytes: 80};}};
  const tools = createComputerUseTools({client, isEnabled: () => true, log: () => {}});
  const shot = await tools.find(item => item.name === 'screenshot').handler({});
  assert.match(shot.output, /needs either `app`.*or `display`/);
  assert.match(shot.output, /ChatGPT, Electron/);
  const click = await tools.find(item => item.name === 'click').handler({});
  assert.match(click.output, /either `element_id`.*or both `x` and `y`/);
  const drag = await tools.find(item => item.name === 'drag').handler({from_x: 1, from_y: 2});
  assert.match(drag.output, /start and an end/);
  const zoom = await tools.find(item => item.name === 'zoom').handler({x0: 0, y0: 0});
  assert.match(zoom.output, /all four corners/);
  assert.deepEqual(calls, ['list_apps']);
});

test('an image result becomes a ContentPart array so the model actually sees the pixels', async () => {
  const log = [];
  const b64 = 'iVBORw0KGgoAAAANSUh';
  const tools = createComputerUseTools({client: {call: async () => ({output: 'window of Electron, origin 0,0, 2 px per pt', isError: false, needsSystemPermission: false, outputBytes: 40, images: [{data: b64, mimeType: 'image/png'}]})}, isEnabled: () => true, log: (id, risk, args, info) => log.push(info)});
  const shot = await tools.find(item => item.name === 'screenshot').handler({app: 'Electron'});
  assert.ok(Array.isArray(shot.output));
  assert.deepEqual(shot.output[0], {type: 'text', text: 'window of Electron, origin 0,0, 2 px per pt'});
  assert.deepEqual(shot.output[1], {type: 'image_url', image_url: {url: `data:image/png;base64,${b64}`}});
  assert.deepEqual(log[0], {denied: false, isError: false, needsSystemPermission: false, outputBytes: 40, imageCount: 1});
});

test('an error result with no images stays a plain string output', async () => {
  const tools = createComputerUseTools({client: {call: async () => ({output: '[computer-use error] screen capture failed', isError: true, outputBytes: 40, images: []})}, isEnabled: () => true, log: () => {}});
  const result = await tools.find(item => item.name === 'screenshot').handler({app: 'Electron'});
  assert.equal(typeof result.output, 'string');
  assert.match(result.output, /screen capture failed/);
});

test('hinted tools still forward valid calls and a valid screenshot with display', async () => {
  const calls = [];
  const client = {call: async (name, args) => {calls.push({name, args}); return {output: 'ok', isError: false, outputBytes: 2};}};
  const tools = createComputerUseTools({client, isEnabled: () => true, log: () => {}});
  assert.equal((await tools.find(item => item.name === 'screenshot').handler({display: 0})).output, 'ok');
  assert.equal((await tools.find(item => item.name === 'click').handler({element_id: 'e3'})).output, 'ok');
  assert.deepEqual(calls.map(item => item.name), ['screenshot', 'click']);
});
