const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resourceCatalog } = require('@industrial-agent-harness/harness-core');
const { setLanguage } = require('./selftest-language.cjs');

function prepare(config) {
  return [...new Set(resourceCatalog().mcpServers.map(provider => provider.domain))]
    .filter(domain => domain !== 'chip' && domain !== '*')
    .map(domain => {
      const directory = path.join(config, `resources-${domain}`);
      fs.mkdirSync(directory, { recursive: true });
      return {
        id: `resources-${domain}`,
        name: `MCP resources · ${domain}`,
        path: directory,
        domain,
      };
    });
}

async function run(window, output) {
  const evidence = process.env.INDUSTRIAL_UI_SCREENSHOTS || output;
  fs.mkdirSync(evidence, { recursive: true });
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(
      `Tool resources timed out: ${script}\n${await evaluate('document.body.innerText')}`,
    );
  }
  const row = id =>
    `.ia-project-resources[data-resource-kind="mcpServers"] [data-resource-id="${id}"]`;
  async function project(name) {
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-project-row')).find(button=>button.querySelector('.ia-project-row-name').textContent===${JSON.stringify(name)}).click()`,
    );
    await wait(
      `document.querySelector('.ia-project-page h1')?.textContent===${JSON.stringify(name)} && document.querySelector('[data-resource-kind="mcpServers"] [data-resource-id]') !== null`,
    );
  }
  async function capture(name) {
    await evaluate('document.fonts.ready');
    fs.writeFileSync(
      path.join(evidence, name + '.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  async function openGlobal() {
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
    await wait(
      `document.querySelector('[data-resource-kind="mcpServers"] input[type="checkbox"]') !== null`,
    );
  }
  async function closeGlobal() {
    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    await wait(`document.querySelector('.ia-project-page') !== null`);
  }
  const providers = resourceCatalog().mcpServers.filter(provider => !provider.external);
  const summary = [];
  for (const provider of providers) {
    await project(
      provider.domain === 'chip' ? 'Chip MCP test' : `MCP resources · ${provider.domain}`,
    );
    await wait(`document.querySelector(${JSON.stringify(row(provider.id))}) !== null`);
    const snapshot = await evaluate(
      `window.viewerHost.resourceGet({projectId:${JSON.stringify(provider.domain === 'chip' ? 'mcp-chip' : `resources-${provider.domain}`)}})`,
    );
    const actual = snapshot.catalog.mcpServers.find(item => item.id === provider.id);
    assert.deepEqual(actual.toolIds, provider.toolIds);
    assert.ok(
      !(
        await evaluate(`document.querySelector('[data-resource-kind="mcpServers"]').textContent`)
      ).includes('No default domain MCP servers'),
    );
    if (provider.tools.length) {
      await evaluate(
        `document.querySelector(${JSON.stringify(row(provider.id) + ' details summary')}).click()`,
      );
      await wait(`document.querySelector(${JSON.stringify(row(provider.id) + ' details')}).open`);
      assert.deepEqual(
        await evaluate(
          `Array.from(document.querySelectorAll(${JSON.stringify(row(provider.id) + ' details:first-of-type [data-tool-id]')})).map(node=>node.dataset.toolId)`,
        ),
        provider.toolIds,
      );
      await evaluate(
        `document.querySelector(${JSON.stringify(row(provider.id) + ' details summary')}).focus()`,
      );
      assert.equal(await evaluate(`document.activeElement.tagName`), 'SUMMARY');
    } else {
      assert.ok(
        (
          await evaluate(`document.querySelector(${JSON.stringify(row(provider.id))}).textContent`)
        ).includes('No active tools are registered'),
      );
    }
    await evaluate(
      `document.querySelector(${JSON.stringify(row(provider.id))}).scrollIntoView({block:'center'})`,
    );
    await capture(`domain-tools-${provider.domain}`);
    summary.push({
      domain: provider.domain,
      provider: provider.id,
      transport: provider.transport,
      tools: provider.toolIds,
    });
  }
  await project('Chip MCP test');
  const chip = providers.find(provider => provider.domain === 'chip');
  await openGlobal();
  assert.equal(
    await evaluate(
      `document.querySelectorAll('[data-resource-kind="mcpServers"] [data-resource-id]').length`,
    ),
    providers.length,
  );
  const target = providers
    .find(provider => provider.domain === 'pcb')
    .tools.find(tool => tool.id.includes('verify'));
  await evaluate(
    `(() => {const input=document.querySelector('.ia-resource-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(target.id)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(
    `document.querySelectorAll('[data-resource-kind="mcpServers"] [data-resource-id]').length===1 && document.querySelector('[data-tool-id="${target.id}"]') !== null`,
  );
  await capture('domain-tools-search');
  await evaluate(
    `(() => {const input=document.querySelector('.ia-resource-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'no-such-resource');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(
    `document.querySelector('[data-resource-kind="mcpServers"]').textContent.includes('No resources match your search.')`,
  );
  await evaluate(
    `(() => {const input=document.querySelector('.ia-resource-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(`document.querySelector(${JSON.stringify(row(chip.id) + ' input')}) !== null`);
  await evaluate(`document.querySelector(${JSON.stringify(row(chip.id) + ' input')}).click()`);
  await wait(
    `window.viewerHost.resourceGet({}).then(state=>state.global.mcpServers.includes(${JSON.stringify(chip.id)}))`,
  );
  await closeGlobal();
  await wait(
    `document.querySelector(${JSON.stringify(row(chip.id) + ' select')})?.value==='inherit'`,
  );
  assert.ok(
    (
      await evaluate(`window.viewerHost.resourceGet({projectId:'mcp-chip'})`)
    ).effective.mcpServers.includes(chip.id),
  );
  async function mode(value) {
    await wait(
      `document.querySelector(${JSON.stringify(row(chip.id) + ' select')})?.disabled===false`,
    );
    await evaluate(
      `(() => {const select=document.querySelector(${JSON.stringify(row(chip.id) + ' select')});select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(
      `document.querySelector(${JSON.stringify(row(chip.id) + ' select')})?.value===${JSON.stringify(value)} && !document.querySelector(${JSON.stringify(row(chip.id) + ' select')})?.disabled`,
    );
  }
  await mode('enabled');
  assert.ok(
    !(
      await evaluate(`window.viewerHost.resourceGet({projectId:'mcp-chip'})`)
    ).effective.mcpServers.includes(chip.id),
    'project override reaches the shared resource policy',
  );
  await mode('inherit');
  await openGlobal();
  await evaluate(`document.querySelector(${JSON.stringify(row(chip.id) + ' input')}).click()`);
  await wait(
    `window.viewerHost.resourceGet({}).then(state=>!state.global.mcpServers.includes(${JSON.stringify(chip.id)}))`,
  );
  await closeGlobal();
  await setLanguage(window, 'zh-CN');
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(`document.querySelector('.ia-settings-row button') !== null`);
  await evaluate(
    `if(!document.querySelector('.theme-dark'))document.querySelector('.ia-settings-row button').click();document.querySelector('.ia-settings-title button').click()`,
  );
  await wait(`Boolean(document.querySelector('.theme-dark'))`);
  await wait(
    `document.querySelector('[data-resource-kind="mcpServers"] h2')?.textContent==='领域工具与 MCP'`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(row(chip.id) + ' details')}).open=true;document.querySelector(${JSON.stringify(row(chip.id))}).scrollIntoView({block:'center'})`,
  );
  await capture('domain-tools-chip-zh');
  window.setContentSize(640, 480);
  await capture('domain-tools-chip-zh-compact');
  assert.equal(await evaluate(`document.documentElement.scrollWidth > window.innerWidth`), false);
  window.setContentSize(1280, 850);
  await setLanguage(window, 'en');
  fs.writeFileSync(
    path.join(evidence, 'domain-tool-catalog.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      domainToolsUI: true,
      providers: providers.length,
      search: true,
      globalDefaults: true,
      projectOverride: true,
      chinese: true,
      dark: true,
      compact: true,
      evidence,
    }),
  );
}
module.exports = { prepare, run };
