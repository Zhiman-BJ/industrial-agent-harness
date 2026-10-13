const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run(window, { manager, directory }) {
  const root = process.env.HARNESS_RELEASE_CATALOG_REPORT_DIR;
  if (!root || !directory || !process.env.INDUSTRIAL_HARNESS_PACK_STORE)
    throw Error('Release catalog QA requires an actual bootstrap directory and isolated stores.');
  fs.mkdirSync(root, { recursive: true });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') process.stderr.write(String(details.message) + '\n');
  });
  const evaluate = async script => {
    const result = await window.webContents.executeJavaScript(
      `(async()=>{try{return {value:await (${script})}}catch(error){return {error:String(error.stack)}}})()`,
      true,
    );
    if (result.error) throw Error(result.error + '\nScript: ' + script);
    return result.value;
  };
  const wait = async script => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw Error(
      `Release catalog UI timed out: ${script}\n${await evaluate('document.body.innerText')}`,
    );
  };
  await require('./selftest-language.cjs').setLanguage(window, 'en');
  const domains = ['chip', 'pcb', 'godot', 'cad'];
  const available = await evaluate('window.viewerHost.domainAvailable()');
  assert.deepEqual(available.map(item => item.domain).sort(), [...domains].sort());
  for (const domain of domains)
    assert.ok(
      available.some(item => item.domain === domain),
      `Actual release catalog must distribute ${domain}.`,
    );
  await wait(
    `document.querySelectorAll('.ia-domain-install-row:not([data-unavailable]').length>=4`,
  );
  for (const domain of domains) {
    assert.equal(
      await evaluate(
        `Boolean(document.querySelector('.ia-domain-install-row[data-domain="${domain}"]:not([data-unavailable]) input:not(:disabled)'))`,
      ),
      true,
    );
    assert.equal(
      await evaluate(
        `Boolean(document.querySelector('.ia-domain-install-row[data-domain="${domain}"][data-unavailable]'))`,
      ),
      false,
    );
  }
  const screenshot = name =>
    require('./selftest-capture.cjs').captureSettled(window, {
      output: path.join(root, name + '.png'),
    });
  assert.equal(
    await evaluate(`document.querySelectorAll('.ia-domain-requirements[open]').length`),
    0,
    'Execution requirements are collapsed initially.',
  );
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-domain="cuda"]'))`), false);
  const rowBorder = await evaluate(
    `getComputedStyle(document.querySelector('.ia-domain-install-row')).borderBottomWidth`,
  );
  assert.notEqual(rowBorder, '0px', 'Domain rows have a visible divider.');
  await require('./selftest-language.cjs').setLanguage(window, 'zh-CN');
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-domain-install-row[data-domain="chip"]').innerText.includes('设计并验证 RTL 与 EDA 项目')`,
    ),
    true,
  );
  await screenshot('00-four-domain-catalog-zh');
  await require('./selftest-language.cjs').setLanguage(window, 'en');
  await screenshot('01-actual-four-domain-catalog');
  for (const domain of domains)
    await evaluate(
      `document.querySelector('.ia-domain-install-row[data-domain="${domain}"] input').click()`,
    );
  await evaluate(
    `(window.__releaseEnvironmentEvents=[],void window.viewerHost.onEnvironmentProgress(value=>window.__releaseEnvironmentEvents.push(value)))`,
  );
  await wait(`!document.querySelector('.ia-domains-primary').disabled`);
  await screenshot('02-four-domain-pack-selection');
  await evaluate(`document.querySelector('.ia-domains-primary').click()`);
  await wait(`Boolean(document.querySelector('.ia-domain-setup [data-action="done"]'))`);
  const installed = manager.list();
  for (const domain of domains) {
    const bundle = installed.find(item => item.domain === domain);
    assert.ok(bundle, `${domain} source Pack installed.`);
    assert.equal(bundle.version, available.find(item => item.domain === domain).version);
    await wait(
      `Boolean(document.querySelector('.ia-runtime-environments[data-domain="${domain}"] select'))`,
    );
  }
  assert.equal(
    await evaluate('window.__releaseEnvironmentEvents.length'),
    0,
    'Source Pack installation must not prepare software implicitly.',
  );
  await screenshot('03-four-source-packs-installed');
  await evaluate(`document.querySelector('.ia-domain-setup [data-action="done"]').click()`);
  await wait(`!document.querySelector('.ia-domains-modal')`);
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(
    `Array.from(document.querySelectorAll('.ia-settings-row')).some(row=>row.innerText.includes('Domains'))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.innerText.includes('Domains')).querySelector('button').click()`,
  );
  await wait(`document.querySelectorAll('.ia-pack-card .ia-runtime-environments').length>=4`);
  await screenshot('04-four-domain-capability-center');
  await require('./selftest-language.cjs').setLanguage(window, 'zh-CN');
  await screenshot('05-capability-center-zh');
  const environmentViews = {};
  for (const domain of domains)
    environmentViews[domain] = await evaluate(
      `window.viewerHost.environmentDescribe({domain:'${domain}'})`,
    );
  fs.writeFileSync(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        source: 'actual release bootstrap catalog; no fixture transport',
        directory: fs.realpathSync(directory),
        platform: `${process.platform}-${process.arch}`,
        available: available.map(({ domain, version }) => ({ domain, version })),
        installed: installed.map(({ domain, version }) => ({ domain, version })),
        environments: Object.fromEntries(
          Object.entries(environmentViews).map(([domain, view]) => [
            domain,
            {
              status: view.status,
              profiles: view.profiles.map(
                ({ id, kind, qualified, status, configured, executable }) => ({
                  id,
                  kind,
                  qualified,
                  status,
                  configured,
                  executable,
                }),
              ),
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
  process.stdout.write('Actual four-domain catalog renderer selftest passed.\n');
}
module.exports = { run };
