const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ExternalMcpRegistry } = require('@industrial-agent-harness/harness-core');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');
const { saveBindings } = require('./project-bindings.cjs');
const { saveProfile, defaults } = require('./model-config.cjs');
let fixture, evidence, settings, marker, configuration;
const calls = [];
async function prepare(config, modelDirectory, resources) {
  fixture = await startModel({ calls, success: 'EXTERNAL_MCP_CONFIRMED' });
  settings = resources;
  evidence = path.dirname(config);
  marker = path.join(evidence, 'host-click.json');
  const directory = path.join(config, 'external-project');
  fs.mkdirSync(directory, { recursive: true });
  saveBindings(config, {
    activeId: 'external-chip',
    projects: [
      {
        id: 'external-chip',
        name: 'External MCP test',
        path: fs.realpathSync(directory),
        domain: 'chip',
      },
    ],
  });
  saveProfile(modelDirectory, {
    ...defaults,
    provider: 'openai_legacy',
    endpoint: fixture.endpoint,
    model: 'controlled-external',
    thinking: false,
    imageInput: true,
    imageInputMode: 'enabled',
  });
  configuration = JSON.stringify({
    mcpServers: {
      'computer-use': {
        command: process.execPath,
        args: [
          path.resolve(__dirname, '../../../tests/integration/fixtures/external-mcp-server.cjs'),
        ],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          FIXTURE_CLICK_MARKER: marker,
          FIXTURE_SECRET: 'selftest-private-credential',
        },
      },
    },
  });
}
async function run(window) {
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (cause) {
      throw new Error(`External MCP UI script failed: ${script}`, { cause });
    }
  };
  async function wait(script) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(
      `External MCP UI timed out: ${script}\n${await evaluate('document.body.innerText')}`,
    );
  }
  async function settingsPage() {
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await wait(
      `Array.from(document.querySelectorAll('.ia-settings-row')).some(row=>row.innerText.includes('MCP & Skills'))`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.innerText.includes('MCP & Skills')).querySelector('button').click()`,
    );
    await wait(`Boolean(document.querySelector('.ia-capability-nav button[title="Tools & MCP"]'))`);
    await evaluate(
      `document.querySelector('.ia-capability-nav button[title="Tools & MCP"]').click()`,
    );
    await wait(`Boolean(document.querySelector('.ia-external-mcp > button:not(:disabled)'))`);
    await evaluate(`document.querySelector('.ia-external-mcp > button').click()`);
    await wait(
      `Boolean(document.querySelector('.ia-external-mcp form button[type="submit"]:not(:disabled)'))`,
    );
  }
  try {
    await wait(`Boolean(document.querySelector('.ia-project-row'))`);
    await settingsPage();
    await evaluate(
      `(() => {const select=document.querySelector('.ia-external-mcp select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'import');select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(`Boolean(document.querySelector('.ia-external-mcp textarea'))`);
    await evaluate(
      `(() => {const area=document.querySelector('.ia-external-mcp textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(configuration)});area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await evaluate(`document.querySelector('.ia-external-mcp form button[type="submit"]').click()`);
    await wait(`document.querySelector('.ia-external-server')?.innerText.includes('3 tools')`);
    assert.ok(
      !(await evaluate(`document.querySelector('.ia-capability').innerText`)).includes(
        'selftest-private-credential',
      ),
    );
    const summary = await evaluate(`window.viewerHost.externalMcpList()`);
    assert.equal(summary[0].id, 'external.computer-use');
    assert.ok(!JSON.stringify(summary).includes('credential'));
    // The resource list must pick up the added server on the same page: the
    // row appears without re-entering the settings and its global switch
    // reflects (and drives) the resolved configuration.
    const row = `[data-resource-id="external.computer-use"]`;
    await wait(`Boolean(document.querySelector('${row} input[type="checkbox"]'))`);
    assert.ok(
      await evaluate(`document.querySelector('${row} input[type="checkbox"]').checked`),
      'external server must be enabled by default',
    );
    await evaluate(`document.querySelector('${row} input[type="checkbox"]').click()`);
    // ResourceList briefly unmounts its rows while onChanged reloads the
    // snapshot. An absent or still-saving checkbox is not the expected state.
    await wait(
      `(() => {const checkbox=document.querySelector('${row} input[type="checkbox"]');return Boolean(checkbox && !checkbox.disabled && checkbox.checked === false);})()`,
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.resourceGet({}).then(snapshot=>snapshot.effective.mcpServers.includes('external.computer-use'))`,
      ),
      true,
      'unchecking the global switch must disable the server',
    );
    await evaluate(`document.querySelector('${row} input[type="checkbox"]').click()`);
    await wait(
      `(() => {const checkbox=document.querySelector('${row} input[type="checkbox"]');return Boolean(checkbox && !checkbox.disabled && checkbox.checked === true);})()`,
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.resourceGet({}).then(snapshot=>snapshot.effective.mcpServers.includes('external.computer-use'))`,
      ),
      false,
      'rechecking the global switch must re-enable the server',
    );
    const registry = new ExternalMcpRegistry(settings);
    assert.equal(registry.list()[0].id, 'external.computer-use');
    const tools = registry.records()[0].tools;
    const screenshot = tools.find(tool => tool.name === 'screenshot').id,
      click = tools.find(tool => tool.name === 'click').id;
    calls.push(
      { name: 'external_tool_list', arguments: {} },
      { name: 'external_tool_describe', arguments: { toolId: screenshot } },
      { name: 'external_tool_call', arguments: { toolId: screenshot, arguments: {} } },
      { name: 'external_tool_describe', arguments: { toolId: click } },
      { name: 'external_tool_call', arguments: { toolId: click, arguments: { x: 40, y: 60 } } },
      { name: 'external_tool_call', arguments: { toolId: click, arguments: { x: 13, y: 25 } } },
    );
    fs.writeFileSync(
      path.join(evidence, 'external-mcp-settings.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    await wait(
      `!document.querySelector('.ia-capability') && Boolean(document.querySelector('.ia-project-row'))`,
    );
    await evaluate(`document.querySelector('.ia-project-row').click()`);
    await wait(
      `document.querySelector('.ia-project-resources[aria-label="Tools & MCP"]')?.innerText.includes('computer-use')`,
    );
    await evaluate(
      `window.viewerHost.resourceSet({projectId:'external-chip',kind:'mcp',id:'external.computer-use',mode:'disabled'})`,
    );
    assert.ok(
      !(
        await evaluate(
          `window.viewerHost.resolve({task:'Use the host screenshot'}).then(result=>result.scope.tools)`,
        )
      ).some(id => id.startsWith('external.')),
    );
    await evaluate(
      `window.viewerHost.resourceSet({projectId:'external-chip',kind:'mcp',id:'external.computer-use',mode:'inherit'})`,
    );
    await evaluate(`document.querySelector('.ia-project-start').click()`);
    await wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
    await evaluate(
      `(() => {const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'Use the host screenshot and click');area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await evaluate(`document.querySelector('.ia-send').click()`);
    const approvals = calls.filter(call => call.name === 'external_tool_call').length;
    for (let index = 0; index < approvals; index++) {
      await wait(`Boolean(document.querySelector('.ia-approval button'))`);
      const approvalId = await evaluate(
        `document.querySelector('.ia-approval').dataset.approvalId`,
      );
      const preview = await evaluate(
        `document.querySelector('.ia-approval-operation')?.textContent`,
      );
      assert.match(preview, /computer-use/);
      assert.match(preview, /screenshot|click/);
      if (preview.includes('click')) {
        assert.match(preview, index === 1 ? /40/ : /13/);
        assert.match(preview, index === 1 ? /60/ : /25/);
      }
      if (index === 0) {
        const rejected = await evaluate(
          `window.viewerHost.externalMcpRemove('external.computer-use').then(()=>false,error=>String(error))`,
        );
        assert.match(rejected, /running|active|stop|busy/i);
      }
      await evaluate(`document.querySelector('.ia-approval button').click()`);
      await wait(
        `document.querySelector('.ia-approval')?.dataset.approvalId !== ${JSON.stringify(approvalId)}`,
      );
    }
    await wait(
      `document.querySelector('.ia-agent-flow')?.innerText.includes('EXTERNAL_MCP_CONFIRMED')&&!document.querySelector('button[title="Stop agent"]')`,
    );
    const clickEvidence = JSON.parse(fs.readFileSync(marker));
    assert.deepEqual(clickEvidence.arguments, { x: 13, y: 25 });
    assert.equal(clickEvidence.count, 2, 'Both desktop clicks must use the same service process.');
    assert.ok(
      fixture.requests.some(request =>
        JSON.stringify(request.messages).includes('data:image/png;base64,'),
      ),
    );
    assert.ok(
      fixture.requests.some(request =>
        request.messages.some(message =>
          (typeof message.content === 'string'
            ? message.content
            : message.content?.map(part => part.text || '').join('\n') || ''
          ).includes('"total":3'),
        ),
      ),
      'Empty discovery arguments must apply pagination defaults through the native SDK.',
    );
    fs.writeFileSync(
      path.join(evidence, 'external-mcp-chat.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await settingsPage();
    const revision = registry.records()[0].revision;
    await evaluate(
      `document.querySelector('button[aria-label="Refresh computer-use tools"]').click()`,
    );
    await wait(
      `document.querySelector('.ia-external-mcp [role="status"]')?.innerText.includes('refreshed')`,
    );
    assert.notEqual(registry.records()[0].revision, revision);
    await evaluate(`document.querySelector('button[aria-label="Remove computer-use"]').click()`);
    await wait(`!document.querySelector('.ia-external-server')`);
    // The stale row must disappear from the resource list on the same page.
    await wait(`!document.querySelector('[data-resource-id="external.computer-use"]')`);
    assert.equal(
      await evaluate(
        `window.viewerHost.resourceGet({}).then(snapshot=>snapshot.catalog.mcpServers.some(item=>item.id==='external.computer-use'))`,
      ),
      false,
      'removed server must be gone from the catalog',
    );
    assert.deepEqual(registry.list(), []);
    console.log(
      JSON.stringify({
        ok: true,
        desktop: true,
        sharedRegistry: true,
        pinnedKimi: true,
        approvals,
        nativeImage: true,
        busyChangeRejected: true,
        resourceListRefresh: true,
        screenshotDirectory: evidence,
      }),
    );
  } finally {
    fixture.close();
  }
}
module.exports = { prepare, run };
