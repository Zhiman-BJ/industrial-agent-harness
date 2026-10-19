const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createArchive, digest, signCatalog } = require('@industrial-agent-harness/pack-manager');

async function run(window, dialog, { manager }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-onboarding-'));
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw new Error(`Project onboarding renderer failed: ${script}`, { cause: error });
    }
  };
  async function wait(script) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(
      `Project onboarding timed out: ${script}\n${await evaluate('document.body.innerText')}`,
    );
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = value =>
    evaluate(`(() => {
    const node = document.querySelector('.ia-create-project input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  async function capture(name) {
    const directory = process.env.INDUSTRIAL_UI_SCREENSHOTS;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    await require('./selftest-capture.cjs').captureSettled(window, {
      output: path.join(directory, `${name}.png`),
    });
  }
  async function setTheme(theme) {
    await click('.ia-settings-button');
    await wait(`Boolean(document.querySelector('.ia-settings-row button'))`);
    if (
      !(await evaluate(
        `document.querySelector('.ia-app').classList.contains('theme-' + ${JSON.stringify(theme)})`,
      ))
    )
      await click('.ia-settings-row button');
    await click('.ia-settings-title button');
    await wait(
      `document.querySelector('.ia-app').classList.contains('theme-' + ${JSON.stringify(theme)})`,
    );
  }
  const originalDialog = dialog.showOpenDialog;
  const originalFetch = global.fetch;
  let folder = path.join(root, 'general-project');
  fs.mkdirSync(folder);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  try {
    await require('./selftest-language.cjs').setLanguage(window, 'en');
    await wait(`Boolean(document.querySelector('.ia-domains-modal'))`);
    assert.equal((await evaluate('window.viewerHost.domainStatus()')).installed.length, 0);
    // First run can proceed without a Pack; no invisible default install.
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-domains-actions button')).find(node=>node.textContent.includes('Continue with General')).click()`,
    );
    await wait(
      `document.querySelector('.ia-domain-choice[data-domain="general"]')?.getAttribute('aria-pressed') === 'true'`,
    );
    await require('./modal-focus-selftest.cjs').check(window, '.ia-create-project');
    await click('.ia-folder-picker');
    await wait(
      `document.querySelector('.ia-folder-picker').textContent.includes('general-project')`,
    );
    await input('My general project');
    await capture('project-general-light');
    await setTheme('dark');
    window.setContentSize(640, 480);
    await wait(`innerWidth === 640`);
    await capture('project-general-dark-compact');
    assert.ok(
      await evaluate(
        `(() => { const box=document.querySelector('.ia-create-project').getBoundingClientRect(); const footer=document.querySelector('.ia-create-project footer').getBoundingClientRect(); return box.left>=0 && box.right<=innerWidth && footer.bottom<=innerHeight; })()`,
      ),
    );
    await click('.ia-create-install');
    await wait(`Boolean(document.querySelector('.ia-domains-modal'))`);
    assert.equal(await evaluate(`Boolean(document.querySelector('.ia-create-project'))`), false);
    await click('.ia-domains-modal header button');
    await wait(
      `document.querySelector('.ia-create-project input')?.value === 'My general project'`,
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-folder-picker').textContent.includes('general-project')`,
      ),
    );
    await click('.ia-create-project .primary');
    await wait(
      `window.viewerHost.projectBindings().then(state=>state.projects.some(project=>project.name==='My general project' && project.domain==='general'))`,
    );
    assert.deepEqual(manager.list(), []);
    // Compact layout unmounts the sidebar; restore it before querying its + button.
    window.setSize(1100, 760);
    await wait(
      `!document.querySelector('.ia-create-project') && document.querySelector('.ia-projects-heading button')?.disabled === false`,
    );
    await setTheme('light');
    // Sidebar + uses the same flow, including a failed install and retry.
    folder = path.join(root, 'specialized-project');
    fs.mkdirSync(folder);
    await click('.ia-projects-heading button');
    await wait(`Boolean(document.querySelector('.ia-create-project'))`);
    await click('.ia-folder-picker');
    await wait(
      `document.querySelector('.ia-folder-picker').textContent.includes('specialized-project')`,
    );
    await input('Preserved draft');
    const source = path.join(root, 'pack');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, 'bundle.json'),
      JSON.stringify({
        schemaVersion: 1,
        domain: 'onboarding-sample',
        label: 'Sample domain',
        emoji: '🧪',
        version: '1.0.0',
        coreApi: 1,
        capabilities: [],
        skills: [],
        providerPacks: [],
      }),
    );
    const bytes = createArchive(source);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keys = path.join(root, 'keys.json');
    fs.writeFileSync(
      keys,
      JSON.stringify({ test: publicKey.export({ type: 'spki', format: 'pem' }) }),
    );
    const catalog = signCatalog(
      {
        schemaVersion: 1,
        channel: 'beta',
        packs: [
          {
            domain: 'onboarding-sample',
            label: 'Sample domain',
            version: '1.0.0',
            sha256: digest(bytes),
            size: bytes.length,
            url: 'sample.hpack',
            platforms: [`${process.platform}-${process.arch}`],
          },
        ],
      },
      'test',
      privateKey,
    );
    process.env.INDUSTRIAL_HARNESS_PACK_CATALOG_URL = 'https://onboarding.example/catalog.json';
    process.env.INDUSTRIAL_HARNESS_PACK_KEYS_FILE = keys;
    let fail = true;
    global.fetch = async url => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'onboarding.example')
        throw Error('Unexpected selftest network request');
      if (parsed.pathname === '/catalog.json') return new Response(JSON.stringify(catalog));
      if (fail) throw Error('Controlled download failure');
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    };
    await click('.ia-create-install');
    await wait(
      `document.querySelector('[data-domain="onboarding-sample"] input')?.disabled === false`,
    );
    await click('[data-domain="onboarding-sample"] input');
    await wait(`document.querySelector('.ia-domains-primary')?.disabled === false`);
    await click('.ia-domains-primary');
    await wait(
      `!document.querySelector('.ia-domains-primary')?.disabled && document.querySelector('.ia-domains-content').textContent.includes('Controlled download failure')`,
    );
    await click('.ia-domains-modal header button');
    await wait(`document.querySelector('.ia-create-project input')?.value === 'Preserved draft'`);
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-domain-choice[aria-pressed="true"]').dataset.domain`,
      ),
      'general',
    );
    await click('.ia-create-install');
    await wait(
      `document.querySelector('[data-domain="onboarding-sample"] input')?.disabled === false`,
    );
    fail = false;
    await click('[data-domain="onboarding-sample"] input');
    await wait(`document.querySelector('.ia-domains-primary')?.disabled === false`);
    await click('.ia-domains-primary');
    await wait(
      `document.querySelector('.ia-domain-choice[data-domain="onboarding-sample"]')?.getAttribute('aria-pressed') === 'true'`,
    );
    assert.equal(
      await evaluate(`document.querySelector('.ia-create-project input').value`),
      'Preserved draft',
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-folder-picker').textContent.includes('specialized-project')`,
      ),
    );
    await capture('project-installed-selection');
    await click('.ia-create-project .primary');
    await wait(
      `window.viewerHost.projectBindings().then(state=>state.projects.some(project=>project.name==='Preserved draft' && project.domain==='onboarding-sample'))`,
    );
    console.log(
      'Project onboarding selftest passed: empty store, General creation, draft retention, failed install, retry and installed selection.',
    );
  } finally {
    dialog.showOpenDialog = originalDialog;
    global.fetch = originalFetch;
  }
}
module.exports = { run };
