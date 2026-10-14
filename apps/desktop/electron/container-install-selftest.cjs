const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Real renderer -> preload -> production IPC -> shared PackManager. The driver
// supplies a signed feed built from the pinned owner, and an actual Docker engine.
async function run(window, { manager }) {
  const domain = process.env.HARNESS_CONTAINER_INSTALL_DOMAIN;
  const output = process.env.HARNESS_CONTAINER_INSTALL_REPORT;
  if (!domain || !output)
    throw Error('Container installation selftest needs a domain and report directory.');
  fs.mkdirSync(output, { recursive: true });
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(
      `Release image UI timed out: ${script}\n${await evaluate('document.body.innerText')}`,
    );
  }
  await require('./selftest-language.cjs').setLanguage(window, 'en');
  assert.equal((await evaluate('window.viewerHost.domainStatus()')).installed.length, 0);
  const row = JSON.stringify(`.ia-domain-install-row[data-domain="${domain}"]`);
  const card = JSON.stringify(`.ia-pack-card[data-domain="${domain}"]`);
  await wait(`Boolean(document.querySelector(${row})?.querySelector('input:not(:disabled)'))`);
  await evaluate(`window.__releaseImageProgress = [];
    window.__releaseImageUnsubscribe = window.viewerHost.onDomainProgress(p => {
      if (p.phase !== 'downloading' || p.received === p.total) window.__releaseImageProgress.push(p);
    })`);
  try {
    await evaluate(`(() => {
      const input = document.querySelector(${row}).querySelector('input');
      if (!input.checked) input.click();
    })()`);
    await wait(`Boolean(document.querySelector('.ia-domains-primary:not(:disabled)'))`);
    await evaluate(`document.querySelector('.ia-domains-primary').click()`);
    await wait(`Boolean(document.querySelector('.ia-domain-setup [data-action="done"]'))`, 120000);
    const installed = await evaluate('window.viewerHost.domainStatus()');
    await evaluate(`document.querySelector('.ia-domain-setup [data-action="done"]').click()`);
    await wait(`!document.querySelector('.ia-domains-modal')`);
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await wait(`Boolean(document.querySelector('.ia-settings-row'))`);
    await evaluate(`Array.from(document.querySelectorAll('.ia-settings-row'))
      .find(row => row.textContent.includes('Domains')).querySelector('button').click()`);
    await wait(
      `document.querySelector(${card})?.querySelector('.ia-pack-badge')?.textContent.includes('Ready to use')`,
    );
    await evaluate(`Array.from(document.querySelector(${card}).querySelectorAll('button'))
      .find(button => button.textContent.includes('Check / repair')).click()`);
    await wait(`window.viewerHost.domainStatus().then(status =>
      status.lastOperation?.operation === 'repair' && status.lastOperation?.outcome === 'completed'
      && !document.querySelector('.ia-domain-progress'))`);
    const result = {
      installed,
      repaired: await evaluate('window.viewerHost.domainStatus()'),
      progress: await evaluate('window.__releaseImageProgress'),
    };
    for (const status of [result.installed, result.repaired]) {
      assert.deepEqual(status.errors, []);
      assert.equal(status.lastOperation.outcome, 'completed');
      assert.equal(status.installed.find(item => item.domain === domain)?.runtimeState, 'ready');
    }
    assert.ok(result.progress.some(p => p.phase === 'ready'));
    assert.deepEqual(manager.scan().errors, []);
    fs.writeFileSync(path.join(output, 'desktop.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(
      path.join(output, 'desktop.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    console.log('Real release-image Desktop installation and repair passed.');
  } finally {
    await evaluate('window.__releaseImageUnsubscribe()');
  }
}

module.exports = { run };
