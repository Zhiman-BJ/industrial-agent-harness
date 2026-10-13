const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WORKBENCH_BROWSER_TOOLS,
  WORKBENCH_BROWSER_TOOL_NAMES,
  createWorkbenchBrowserTools,
  materializeWorkbenchBrowserSkill,
} = require('../src/index.cjs');

function fakeDriver(respond = () => ({ output: 'ok' })) {
  const calls = [];
  return {
    calls,
    call: async (name, args) => {
      calls.push({ name, args });
      return respond(name, args);
    },
  };
}

function enabledTools(driver) {
  return createWorkbenchBrowserTools({ driver, isEnabled: () => true });
}

test('the workspace browser surface declares 8 tools with unique names and valid risks', () => {
  assert.equal(WORKBENCH_BROWSER_TOOLS.length, 8);
  assert.equal(WORKBENCH_BROWSER_TOOL_NAMES.size, 8);
  for (const item of WORKBENCH_BROWSER_TOOLS) {
    assert.match(item.canonicalId, /^workbench-browser\./, item.name);
    assert.ok(['read', 'mutating'].includes(item.risk), item.name);
    // browser_* is reserved for the upstream computer-use server's Chrome tools.
    assert.ok(!item.name.startsWith('browser_'), item.name);
    assert.match(item.name, /^web_/, item.name);
  }
});

test('a disabled plugin denies every call without touching the driver', async () => {
  const driver = fakeDriver();
  const tools = createWorkbenchBrowserTools({ driver, isEnabled: () => false });
  for (const tool of tools) {
    const result = await tool.handler({});
    assert.match(result.output, /^\[denied\]/, tool.name);
  }
  assert.equal(driver.calls.length, 0);
});

test('argument hints short-circuit before the driver for incomplete shapes', async () => {
  const driver = fakeDriver();
  const tools = Object.fromEntries(enabledTools(driver).map(tool => [tool.name, tool]));
  const click = await tools.web_click.handler({});
  assert.match(click.output, /either `ref`/);
  assert.match(click.output, /both `x` and `y`/);
  const type = await tools.web_type.handler({});
  assert.match(type.output, /needs `text`/);
  const navigate = await tools.web_navigate.handler({});
  assert.match(navigate.output, /needs `url`/);
  assert.equal(driver.calls.length, 0);
});

test('valid calls reach the driver and pass the output through', async () => {
  const driver = fakeDriver(() => ({ output: 'Navigated to https://example.com' }));
  const tools = Object.fromEntries(enabledTools(driver).map(tool => [tool.name, tool]));
  const result = await tools.web_navigate.handler({ url: 'example.com' });
  assert.equal(result.output, 'Navigated to https://example.com');
  assert.deepEqual(driver.calls, [{ name: 'web_navigate', args: { url: 'example.com' } }]);
});

test('driver errors and isError results surface as text, not exceptions', async () => {
  const failing = fakeDriver(() => {
    throw Error('guest gone');
  });
  const tools = Object.fromEntries(enabledTools(failing).map(tool => [tool.name, tool]));
  const thrown = await tools.web_snapshot.handler({});
  assert.match(thrown.output, /\[workbench-browser error\] .*guest gone/);

  const errorResult = fakeDriver(() => ({
    output: 'No workspace browser tab is open.',
    isError: true,
  }));
  const tools2 = Object.fromEntries(enabledTools(errorResult).map(tool => [tool.name, tool]));
  const reported = await tools2.web_back.handler({});
  assert.equal(reported.message, 'Tool reported an error');
  assert.match(reported.output, /No workspace browser tab/);
});

test('image results become image_url content parts for the model', async () => {
  const driver = fakeDriver(() => ({
    output: 'Screenshot of https://example.com (1200×700px).',
    images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
  }));
  const tools = Object.fromEntries(enabledTools(driver).map(tool => [tool.name, tool]));
  const result = await tools.web_screenshot.handler({});
  assert.equal(result.output[0].type, 'text');
  assert.equal(result.output[1].type, 'image_url');
  assert.equal(result.output[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
});

test('every call is recorded through the log sink with its canonical id and risk', async () => {
  const records = [];
  const driver = fakeDriver();
  const tools = createWorkbenchBrowserTools({
    driver,
    isEnabled: () => true,
    log: (canonicalId, risk, params, meta) => records.push({ canonicalId, risk, params, meta }),
  });
  const navigate = tools.find(tool => tool.name === 'web_navigate');
  await navigate.handler({ url: 'example.com' });
  assert.equal(records.length, 1);
  assert.equal(records[0].canonicalId, 'workbench-browser.navigate');
  assert.equal(records[0].risk, 'mutating');
  assert.equal(records[0].meta.denied, false);
});

test('the skill materializes into the session skills directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-skill-'));
  const root = materializeWorkbenchBrowserSkill(directory);
  const target = path.join(root, 'workbench-browser', 'SKILL.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /web_navigate/);
  assert.match(content, /web_snapshot/);
});
