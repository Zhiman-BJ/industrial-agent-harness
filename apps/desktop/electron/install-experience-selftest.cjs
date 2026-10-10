const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createArchive, digest, signCatalog } = require('@industrial-agent-harness/pack-manager');

// Real Electron renderer -> preload -> production IPC -> signature/stream/Pack
// installation. Only the HTTPS transport serves local, explicitly fake fixtures.
// Native dependency acceptance for shipping domains remains a separate gate.
async function run(window, { manager }) {
  const root = process.env.HARNESS_INSTALL_EXPERIENCE_REPORT_DIR;
  if (!root || !process.env.INDUSTRIAL_HARNESS_PACK_STORE)
    throw Error('Installation selftest requires isolated report and Pack directories.');
  fs.mkdirSync(root, { recursive: true });
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  const navigationChecks = [];
  async function wait(script, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(
      `Installation UI timed out: ${script}\n${await evaluate('document.body.innerText.slice(-6500)')}\n${JSON.stringify(await evaluate('window.viewerHost.domainStatus()'))}`,
    );
  }
  const screenshot = async name => {
    for (let attempt = 0; ; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const capture = await window.webContents.capturePage();
        fs.writeFileSync(path.join(root, `${name}.png`), capture.toPNG());
        return;
      } catch (error) {
        if (attempt >= 2 || !String(error).includes('UnknownVizError')) throw error;
      }
    }
  };
  async function checkNavigation(name) {
    await wait(`document.querySelectorAll('.ia-capability-nav button').length===4`);
    const geometry = await evaluate(`(() => ({
      locale: document.documentElement.lang,
      theme: document.querySelector('.ia-app').classList.contains('theme-dark') ? 'dark' : 'light',
      width: innerWidth,
      navigationX: document.querySelector('.ia-capability-nav').getBoundingClientRect().x,
      rows: Array.from(document.querySelectorAll('.ia-capability-nav button')).map(button => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector('svg').getBoundingClientRect();
        const label = button.querySelector('span');
        return {name:button.getAttribute('aria-label'),title:button.title,current:button.getAttribute('aria-current'),
          x:rect.x,width:rect.width,height:rect.height,iconX:icon.x,iconWidth:icon.width,
          labelX:label.getBoundingClientRect().x,labelHidden:getComputedStyle(label).display==='none'};
      }),
      overflow: document.querySelector('.ia-capability').scrollWidth > document.querySelector('.ia-capability').clientWidth
    }))()`);
    assert.equal(geometry.rows.filter(row => row.current === 'page').length, 1);
    assert.equal(
      geometry.overflow,
      false,
      'Capability navigation does not cause horizontal overflow.',
    );
    for (const row of geometry.rows) {
      assert.equal(row.name, row.title, 'Compact buttons retain translated accessible names.');
      assert.ok(row.name);
      assert.equal(row.iconWidth, 16);
      assert.ok(row.height >= 32);
      assert.ok(
        Math.abs(row.iconX - geometry.rows[0].iconX) < 0.5,
        'All navigation icons share one column.',
      );
      if (geometry.width <= 1050) {
        assert.equal(row.labelHidden, true);
        assert.equal(row.width, 32);
        assert.ok(Math.abs(row.iconX - row.x - 8) < 0.5);
      } else {
        assert.equal(row.labelHidden, false);
        assert.ok(
          Math.abs(row.labelX - geometry.rows[0].labelX) < 0.5,
          'All navigation labels start at the same position.',
        );
        assert.ok(Math.abs(row.labelX - row.iconX - 24) < 0.5);
      }
    }
    // Move into Skills with a real keyboard event after the native window has
    // focus; programmatic focus alone does not establish keyboard modality.
    window.show();
    window.focus();
    window.webContents.focus();
    await wait('document.hasFocus()');
    await evaluate(
      `(() => {const buttons=document.querySelectorAll('.ia-capability-nav button');buttons[2].click();buttons[1].focus();})()`,
    );
    await wait(
      `document.querySelectorAll('.ia-capability-nav button')[2].getAttribute('aria-current')==='page'`,
    );
    const layout = await evaluate(`(() => {
      const center=document.querySelector('.ia-capability').getBoundingClientRect();
      const header=document.querySelector('.ia-capability-header').getBoundingClientRect();
      const body=document.querySelector('.ia-capability-body').getBoundingClientRect();
      const nav=document.querySelector('.ia-capability-nav').getBoundingClientRect();
      return {centerWidth:center.width,headerWidth:header.width,bodyWidth:body.width,navigationX:nav.x};
    })()`);
    assert.ok(
      Math.abs(layout.headerWidth - layout.centerWidth) < 0.5,
      'Capability header fills the workbench.',
    );
    assert.ok(
      Math.abs(layout.bodyWidth - layout.centerWidth) < 0.5,
      'Capability body fills the workbench.',
    );
    assert.ok(
      Math.abs(layout.navigationX - geometry.navigationX) < 0.5,
      'Navigation stays in place when switching sections.',
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait(
      `document.activeElement === document.querySelectorAll('.ia-capability-nav button')[2] && document.activeElement.matches(':focus-visible')`,
    );
    const focus = await evaluate(
      `(() => {const button=document.querySelectorAll('.ia-capability-nav button')[2];const style=getComputedStyle(button);return {visible:button.matches(':focus-visible'),width:style.outlineWidth,offset:style.outlineOffset};})()`,
    );
    assert.equal(focus.visible, true);
    assert.equal(focus.width, '2px');
    assert.equal(focus.offset, '-2px');
    await require('./selftest-capture.cjs').captureSettled(window, {
      output: path.join(root, `${name}-keyboard.png`),
    });
    const point = await evaluate(`(() => {
      const rect=document.querySelectorAll('.ia-capability-nav button')[2].getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    // The pinned Electron (44.0.0) does not reset :focus-visible for synthetic
    // pointer input after a synthetic Tab established keyboard modality, so the
    // mouse view clears the keyboard focus explicitly to stay free of the
    // keyboard-ring evidence captured above.
    await evaluate(`document.activeElement && document.activeElement.blur()`);
    await wait(
      `!document.querySelectorAll('.ia-capability-nav button')[2].matches(':focus-visible')`,
    );
    // Keep the ordinary mouse view separate from the keyboard-focus evidence.
    // Click the empty content area, as a user would, then clear any incidental
    // text selection left by native input while changing languages.
    const blank = await evaluate(`(() => {
      const rect=document.querySelector('.ia-capability-content').getBoundingClientRect();
      return {x:Math.round(rect.right-24),y:Math.round(rect.bottom-24)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...blank });
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...blank,
    });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...blank });
    await wait(`!document.querySelector('.ia-capability-nav').contains(document.activeElement)`);
    await evaluate('getSelection()?.removeAllRanges()');
    await require('./selftest-capture.cjs').captureSettled(window, {
      output: path.join(root, `${name}.png`),
      readyScript: `!document.querySelector('.ia-capability-nav').contains(document.activeElement) && !getSelection()?.toString()`,
    });
    navigationChecks.push({ ...geometry, focus, layout });
    await evaluate(`document.querySelector('.ia-capability-nav button').click()`);
    await wait(`Boolean(document.querySelector('.ia-packs-section'))`);
  }
  const refresh = async () => {
    await wait(
      `Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Check updates'&&!button.disabled)`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Check updates').click()`,
    );
    await wait(
      `!document.querySelector('.ia-catalog-status')?.textContent.includes('Checking available')`,
    );
  };
  const select = async id => {
    await wait(
      `Boolean(document.querySelector('.ia-domain-install-row[data-domain="${id}"] input:not(:disabled)'))`,
    );
    await evaluate(
      `document.querySelector('.ia-domain-install-row[data-domain="${id}"] input').click()`,
    );
  };
  const packAction = async (id, label) => {
    const selector = `Array.from(document.querySelectorAll('.ia-pack-card[data-domain="${id}"] button')).find(button=>button.textContent===${JSON.stringify(label)}&&!button.disabled)`;
    await wait(`Boolean(${selector})`);
    await evaluate(`(${selector}).click()`);
  };
  const openPacks = async () => {
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await wait(
      `Array.from(document.querySelectorAll('.ia-settings-row')).some(row=>row.textContent.includes('Domains'))`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.textContent.includes('Domains')).querySelector('button').click()`,
    );
    await wait(`Boolean(document.querySelector('.ia-capability-section'))`);
  };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = path.join(root, 'keys.json');
  fs.writeFileSync(
    keys,
    JSON.stringify({ test: publicKey.export({ type: 'spki', format: 'pem' }) }),
  );
  const files = new Map();
  let asset;
  if (process.platform === 'darwin') {
    const app = path.join(root, 'native', 'Fixture.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    // A copied /bin/echo is a dyld-shared-cache platform binary: even after the
    // ad-hoc re-sign below, macOS 15 runners kill the extracted copy on exec
    // (SIGKILL in ~3ms). A shebang script is interpreted and carries no code
    // signature to validate, while matching echo's argument behavior for the
    // version probe.
    const executable = path.join(app, 'Contents', 'MacOS', 'fixture');
    fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(
      path.join(app, 'Contents', 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>example.install.fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
    for (const [command, args] of [
      ['/usr/bin/codesign', ['--force', '--sign', '-', app]],
      ['/usr/bin/ditto', ['-c', '-k', '--keepParent', app, path.join(root, 'native.zip')]],
    ]) {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (result.status !== 0) throw Error(`${command}: ${result.stderr}`);
    }
    const bytes = fs.readFileSync(path.join(root, 'native.zip'));
    files.set('/native.zip', bytes);
    asset = {
      id: 'fixture',
      label: 'Fixture Runtime',
      version: '1.0.0',
      type: 'macos-app-zip',
      platform: `${process.platform}-${process.arch}`,
      url: 'https://install.example/native.zip',
      sha256: digest(bytes),
      size: bytes.length,
      installedSize: 512 * 1024,
      app: 'Fixture.app',
      executable: 'Contents/MacOS/fixture',
      environment: 'INDUSTRIAL_HARNESS_FIXTURE_CMD',
      versionArgs: ['--version'],
      versionText: '--version',
      profileEnvironment: {},
    };
  }
  const entries = ['sample-a', 'sample-b', 'sample-c'].map((domain, index) => {
    const source = path.join(root, domain);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'payload.bin'), crypto.randomBytes(2 * 1024 * 1024));
    const bundle = {
      schemaVersion: 1,
      domain,
      label: `Sample ${index + 1}`,
      emoji: '🧪',
      version: '1.0.0',
      coreApi: 1,
      capabilities: [],
      skills: [],
      providerPacks: [],
      ...(index === 0 && asset ? { runtimeAssets: [asset] } : {}),
      ...(index === 1 ? { prerequisites: ['An external sample tool is required.'] } : {}),
    };
    fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
    const bytes = createArchive(source);
    files.set(`/${domain}.hpack`, bytes);
    return {
      domain,
      label: bundle.label,
      version: bundle.version,
      sha256: digest(bytes),
      size: bytes.length,
      url: `${domain}.hpack`,
      platforms: [`${process.platform}-${process.arch}`],
      ...(bundle.prerequisites ? { prerequisites: bundle.prerequisites } : {}),
      ...(index === 0 && asset
        ? {
            runtimeAssets: [asset],
            runtimeDownloadSize: asset.size,
            runtimeInstalledSize: asset.installedSize,
          }
        : {}),
    };
  });
  let envelope = signCatalog(
    { schemaVersion: 1, channel: 'beta', packs: entries },
    'test',
    privateKey,
  );
  let offline = false,
    corrupt = false,
    delay = 100;
  const quitMode = process.env.HARNESS_INSTALL_EXPERIENCE_QUIT_TEST === 'true';
  const originalFetch = global.fetch;
  let externalProcess;
  async function startExternalPreparation() {
    externalProcess = spawn(
      process.execPath,
      [
        '-e',
        `
      const { PackManager } = require(${JSON.stringify(require.resolve('@industrial-agent-harness/pack-manager'))});
      const { InstallationJournal } = require(${JSON.stringify(require.resolve('@industrial-agent-harness/pack-manager/src/catalog.cjs'))});
      const journal = new InstallationJournal(new PackManager({ directory: ${JSON.stringify(manager.directory)} }));
      journal.begin(['sample-c']);
      journal.progress({label:'External preparation',phase:'verifying'});
      process.stdin.on('end', () => journal.finish('completed'));
      process.stdin.resume();
      process.stdout.write('ready');
    `,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] },
    );
    await new Promise((resolve, reject) => {
      externalProcess.once('error', reject);
      externalProcess.once('exit', code =>
        reject(Error(`External preparation exited early: ${code}`)),
      );
      externalProcess.stdout.once('data', resolve);
    });
  }
  async function finishExternalPreparation() {
    const child = externalProcess;
    await new Promise((resolve, reject) => {
      child.once('exit', code =>
        code === 0 ? resolve() : reject(Error(`External preparation failed: ${code}`)),
      );
      child.stdin.end();
    });
    externalProcess = undefined;
  }
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'install.example');
    if (offline) throw Error('Fixture network unavailable');
    if (parsed.pathname === '/catalog.json') return new Response(JSON.stringify(envelope));
    const bytes = files.get(parsed.pathname);
    assert.ok(bytes, parsed.pathname);
    let offset = 0;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise(resolve =>
            setTimeout(resolve, quitMode && parsed.pathname === '/native.zip' ? 1500 : delay),
          );
          if (options.signal?.aborted) {
            controller.error(options.signal.reason);
            return;
          }
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const chunk = Buffer.from(bytes.subarray(offset, offset + 64 * 1024));
          if (corrupt && parsed.pathname === '/sample-c.hpack' && offset === 0) chunk[0] ^= 255;
          offset += chunk.length;
          controller.enqueue(chunk);
        },
      }),
      { headers: { 'content-length': String(bytes.length) } },
    );
  };
  try {
    for (const locale of ['zh-CN', 'en']) {
      await require('./selftest-language.cjs').setLanguage(window, locale);
      assert.equal(await evaluate('document.documentElement.lang'), locale);
      assert.equal(
        await evaluate(`Boolean(document.querySelector('.ia-settings-popover'))`),
        false,
      );
      assert.equal(
        await evaluate(`document.querySelector('.ia-settings-button').textContent.trim()`),
        locale === 'en' ? 'Settings' : '设置',
      );
    }
    await wait(`Boolean(document.querySelector('.ia-domains-modal'))`);
    await wait(
      `document.querySelector('[data-catalog-state="unconfigured"]')?.textContent.includes('not configured')`,
    );
    assert.equal(
      await evaluate(`document.body.innerText.includes('All available domains are installed')`),
      false,
    );
    await screenshot('01-unconfigured');
    process.env.INDUSTRIAL_HARNESS_PACK_CATALOG_URL = 'https://install.example/catalog.json';
    process.env.INDUSTRIAL_HARNESS_PACK_KEYS_FILE = keys;
    offline = true;
    await refresh();
    await wait(`Boolean(document.querySelector('[data-catalog-state="unavailable"]'))`);
    await screenshot('02-unavailable');
    offline = false;
    await refresh();
    await wait(
      `document.querySelectorAll('.ia-domain-install-row:not([data-unavailable])').length===3 && Boolean(document.querySelector('[data-catalog-state="connected"]'))`,
    );
    const unavailable = (await evaluate('window.viewerHost.domainStatus()')).catalog
      .unavailableDomains;
    assert.ok(
      unavailable.length,
      'Known domains remain visible even without a qualified local bundle.',
    );
    for (const item of unavailable) {
      assert.equal(
        await evaluate(
          `document.querySelector('.ia-domain-install-row[data-domain=${JSON.stringify(item.domain)}][data-unavailable="true"] input')?.disabled`,
        ),
        true,
      );
    }
    if (quitMode) {
      assert.ok(asset, 'Native runtime quit regression requires macOS.');
      delay = 3;
      await select('sample-a');
      await evaluate(`document.querySelector('.ia-domains-primary').click()`);
      await wait(
        `document.querySelector('.ia-domain-progress')?.textContent.includes('Fixture Runtime') && document.querySelector('.ia-domain-progress')?.dataset.phase==='downloading'`,
      );
      const beforeQuit = await evaluate('window.viewerHost.domainStatus()');
      assert.equal(beforeQuit.operation.active, true);
      assert.equal(fs.existsSync(path.join(manager.runtimeAssets.directory, 'prepare.lock')), true);
      const { app } = require('electron');
      app.once('will-quit', () => {
        try {
          const last = JSON.parse(
            fs.readFileSync(path.join(manager.directory, '.installation-operation.json'), 'utf8'),
          );
          assert.equal(last.active, false);
          assert.equal(last.outcome, 'cancelled');
          assert.equal(
            fs.existsSync(path.join(manager.runtimeAssets.directory, 'prepare.lock')),
            false,
          );
          assert.equal(fs.existsSync(path.join(manager.directory, 'install.lock')), false);
          const cache = path.join(manager.runtimeAssets.directory, 'cache');
          assert.equal(
            fs.readdirSync(cache).some(name => name.includes('.partial')),
            false,
          );
          assert.equal(manager.list().length, 0);
          fs.writeFileSync(
            path.join(root, 'result.json'),
            JSON.stringify(
              {
                passed: true,
                check: 'normal-quit-awaits-active-native-runtime-download-cleanup',
                outcome: last.outcome,
                phaseAtQuit: beforeQuit.operation.progress.phase,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          console.error(error);
          app.exit(1);
        }
      });
      app.quit();
      // Keep the fixture transport alive while production before-quit awaits cleanup.
      await new Promise(() => {});
    }
    await startExternalPreparation();
    await refresh();
    await wait(
      `document.querySelector('.ia-domain-progress')?.textContent.includes('Another process')`,
    );
    assert.equal(
      await evaluate(`Boolean(document.querySelector('.ia-domain-progress button'))`),
      false,
    );
    assert.equal((await evaluate('window.viewerHost.domainStatus()')).operation.source, 'external');
    assert.equal((await evaluate('window.viewerHost.domainCancel()')).cancelled, false);
    await evaluate(
      `document.querySelector('.ia-domains-modal [aria-label="Close domain manager"]').click()`,
    );
    await wait(`!document.querySelector('.ia-domains-modal')`);
    assert.equal((await evaluate('window.viewerHost.domainStatus()')).operation.active, true);
    await evaluate(`localStorage.removeItem('ia-domain-onboarding-skipped')`);
    await window.reload();
    await wait(
      `document.querySelector('.ia-domain-progress')?.textContent.includes('Another process')`,
    );
    await finishExternalPreparation();
    await wait(
      `!document.querySelector('.ia-domain-progress') && document.querySelector('.ia-install-outcome')?.textContent.includes('Installation finished')`,
    );
    fs.rmSync(path.join(manager.directory, '.installation-operation.json'));
    await refresh();
    await select('sample-a');
    await select('sample-b');
    await wait(
      `document.querySelector('.ia-install-selection')?.textContent.includes('2 domains selected') && document.querySelector('.ia-install-selection')?.textContent.includes('free space needed')`,
    );
    await screenshot('03-multi-select');
    const originalSize = window.getSize();
    async function themeSnapshot(theme, name, compact) {
      await evaluate(`localStorage.setItem('ia-theme', '${theme}')`);
      await window.reload();
      await select('sample-a');
      await select('sample-b');
      window.setSize(...(compact ? [640, 480] : originalSize));
      await wait(
        `document.querySelector('.ia-install-selection')?.textContent.includes('2 domains selected')`,
      );
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(
        await evaluate(`(() => {
        const modal=document.querySelector('.ia-domains-modal'), footer=modal.querySelector('footer'), content=modal.querySelector('.ia-domains-content');
        const bounds=modal.getBoundingClientRect(), actions=footer.getBoundingClientRect();
        return bounds.top>=0 && bounds.left>=0 && bounds.right<=innerWidth+1 && bounds.bottom<=innerHeight+1 && actions.bottom<=innerHeight+1 && content.scrollWidth<=content.clientWidth+1;
      })()`),
        true,
        `Installation modal fits ${name}`,
      );
      await screenshot(name);
    }
    await themeSnapshot('dark', '03b-multi-select-dark', false);
    await themeSnapshot('dark', '03c-multi-select-dark-narrow', true);
    await themeSnapshot('light', '03d-multi-select-light-narrow', true);
    window.setSize(...originalSize);

    await evaluate(
      `window.__installEvents=[];window.viewerHost.onDomainProgress(value=>window.__installEvents.push(value));document.querySelector('.ia-domains-primary').click()`,
    );
    await wait(
      `document.querySelector('.ia-install-transfer')?.textContent.includes('/s') && document.querySelector('.ia-install-transfer')?.textContent.includes('remaining')`,
    );
    await screenshot('04-download-eta');
    await evaluate(`document.querySelector('.ia-domain-progress button').click()`);
    await wait(
      `window.viewerHost.domainStatus().then(status=>!status.operation?.active && status.lastOperation?.outcome==='cancelled') && document.querySelector('.ia-install-outcome')?.textContent.includes('Installation cancelled')`,
    );
    assert.equal(manager.list().length, 0);
    delay = 3;
    await wait(`!document.querySelector('.ia-domains-primary').disabled`);
    await evaluate(`document.querySelector('.ia-domains-primary').click()`);
    await wait(`Boolean(document.querySelector('.ia-domain-setup [data-action="done"]'))`);
    const status = await evaluate('window.viewerHost.domainStatus()');
    assert.equal(status.installed.length, 2);
    assert.equal(
      status.installed.find(item => item.domain === 'sample-b').runtimeState,
      'external-dependencies',
    );
    if (asset)
      assert.equal(status.installed.find(item => item.domain === 'sample-a').runtimeState, 'ready');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-domains-installed')?.textContent.includes('External tools need setup')`,
      ),
    );
    await screenshot('05-installed-next-steps');
    const phases = await evaluate(
      `Array.from(new Set(window.__installEvents.map(item=>item.phase)))`,
    );
    for (const phase of ['checking-space', 'downloading', 'verifying', 'activating'])
      assert.ok(phases.includes(phase), phase);
    if (asset)
      for (const phase of ['extracting', 'checking', 'ready'])
        assert.ok(phases.includes(phase), phase);
    await evaluate(`document.querySelector('.ia-domain-setup [data-action="model"]').click()`);
    await wait(
      `!document.querySelector('.ia-domains-modal') && Boolean(document.querySelector('.ia-model-modal'))`,
    );
    await screenshot('05b-model-settings-reference');
    await evaluate(
      `document.querySelector('.ia-model-modal [aria-label="Close settings"]').click()`,
    );
    await openPacks();
    await checkNavigation('navigation-en-light');
    corrupt = true;
    await packAction('sample-c', 'Install');
    await wait(
      `document.querySelector('.ia-install-outcome')?.textContent.includes('could not finish') && !document.querySelector('.ia-domain-progress')`,
    );
    assert.equal(manager.list().length, 2);
    await screenshot('06-failed-keeps-installed');
    corrupt = false;
    await packAction('sample-c', 'Install');
    await wait(
      `window.viewerHost.domainStatus().then(status=>status.installed.length===3 && !status.operation?.active) && !document.querySelector('.ia-domain-progress')`,
    );
    await wait(
      `document.querySelector('.ia-pack-card[data-domain="sample-c"] .ia-pack-badge')?.textContent==='Pack installed'`,
    );
    const updatedSource = path.join(root, 'sample-c');
    const updatedBundle = JSON.parse(
      fs.readFileSync(path.join(updatedSource, 'bundle.json'), 'utf8'),
    );
    updatedBundle.version = '1.1.0';
    fs.writeFileSync(path.join(updatedSource, 'bundle.json'), JSON.stringify(updatedBundle));
    const updatedBytes = createArchive(updatedSource);
    files.set('/sample-c.hpack', updatedBytes);
    entries[2] = {
      ...entries[2],
      version: '1.1.0',
      size: updatedBytes.length,
      sha256: digest(updatedBytes),
    };
    envelope = signCatalog(
      { schemaVersion: 1, channel: 'beta', packs: entries },
      'test',
      privateKey,
    );
    await refresh();
    await wait(
      `document.querySelector('.ia-pack-card[data-domain="sample-c"]')?.textContent.includes('Version 1.0.0 → 1.1.0')`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-capability-section')?.textContent.includes('installed and up to date')`,
      ),
      false,
    );
    corrupt = true;
    await packAction('sample-c', 'Update');
    await wait(
      `document.querySelector('.ia-install-outcome')?.textContent.includes('could not finish') && !document.querySelector('.ia-domain-progress')`,
    );
    assert.equal(manager.list().find(item => item.domain === 'sample-c').version, '1.0.0');
    corrupt = false;
    await packAction('sample-c', 'Update');
    await wait(
      `window.viewerHost.domainStatus().then(status=>status.installed.find(item=>item.domain==='sample-c')?.version==='1.1.0'&&!status.operation?.active)`,
    );
    await wait(`!document.querySelector('.ia-domain-progress')`);
    if (asset) {
      const bundle = manager.list().find(item => item.domain === 'sample-a');
      fs.writeFileSync(manager.runtimeAssets.status(bundle.runtimeAssets)[0].executable, 'broken');
      await refresh();
      await wait(
        `document.querySelector('.ia-pack-card[data-domain="sample-a"]')?.textContent.includes('Needs preparation')`,
      );
      await packAction('sample-a', 'Prepare / retry');
      await wait(
        `window.viewerHost.domainStatus().then(status=>status.installed.find(item=>item.domain==='sample-a')?.runtimeState==='ready'&&!status.operation?.active)`,
      );
      await wait(`!document.querySelector('.ia-domain-progress')`);
    }
    await packAction('sample-c', 'Remove');
    await wait(
      `Array.from(document.querySelectorAll('.ia-pack-card[data-domain="sample-c"] button')).some(button=>button.textContent==='Install'&&!button.disabled)`,
    );
    await wait(
      `document.querySelector('.ia-install-outcome')?.textContent.includes('Domain removed.')`,
    );
    delay = 150;
    await packAction('sample-c', 'Install');
    await wait(`Boolean(document.querySelector('.ia-domain-progress'))`);
    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    await wait(`!document.querySelector('.ia-capability')`);
    await openPacks();
    await wait(
      `document.querySelector('.ia-domain-progress')?.textContent.includes('Installation continues')`,
    );
    const removalError = await evaluate(
      `window.viewerHost.domainRemove('sample-a').then(()=>null,error=>String(error))`,
    );
    assert.match(removalError, /already in progress/);
    assert.equal(
      manager.list().some(item => item.domain === 'sample-a'),
      true,
    );
    const cancelled = await evaluate(
      `window.viewerHost.domainCancel().then(async result=>({result,status:await window.viewerHost.domainStatus()}))`,
    );
    assert.equal(cancelled.result.cancelled, true);
    assert.equal(
      Boolean(cancelled.status.operation?.active),
      false,
      'cancel IPC awaits terminal cleanup',
    );
    assert.equal(cancelled.status.lastOperation.outcome, 'cancelled');
    await wait(
      `document.querySelector('.ia-install-outcome')?.textContent.includes('Installation cancelled') && !document.querySelector('.ia-domain-progress')`,
    );
    await startExternalPreparation();
    await refresh();
    await wait(
      `document.querySelector('.ia-domain-progress')?.textContent.includes('Another process')`,
    );
    assert.equal(
      await evaluate(`Boolean(document.querySelector('.ia-domain-progress button'))`),
      false,
    );
    await finishExternalPreparation();
    await wait(
      `!document.querySelector('.ia-domain-progress') && document.querySelector('.ia-install-outcome')?.textContent.includes('Installation finished')`,
    );
    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    await require('./selftest-language.cjs').setLanguage(window, 'zh-CN');
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await wait(
      `Array.from(document.querySelectorAll('.ia-settings-row')).some(row=>row.textContent.includes('领域'))`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.textContent.includes('领域')).querySelector('button').click()`,
    );
    await wait(
      `document.querySelector('.ia-capability')?.textContent.includes('安装已完成') && document.querySelector('.ia-capability')?.textContent.includes('外部工具尚需配置')`,
    );
    await screenshot('07-chinese');
    await checkNavigation('navigation-zh-light');
    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await wait(`Boolean(document.querySelector('.ia-settings-row button'))`);
    await evaluate(`document.querySelector('.ia-settings-row button').click()`);
    await evaluate(`document.querySelector('.ia-settings-title button').click()`);
    await wait(`Boolean(document.querySelector('.theme-dark'))`);
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await wait(
      `Array.from(document.querySelectorAll('.ia-settings-row')).some(row=>row.textContent.includes('领域'))`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.textContent.includes('领域')).querySelector('button').click()`,
    );
    await wait(
      `document.querySelector('.ia-capability')?.textContent.includes('外部工具尚需配置')`,
    );
    await screenshot('07b-chinese-dark');
    await checkNavigation('navigation-zh-dark');
    window.setSize(640, 480);
    await checkNavigation('navigation-zh-dark-narrow');
    await screenshot('07c-chinese-dark-narrow');
    window.setSize(...originalSize);

    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    await require('./selftest-language.cjs').setLanguage(window, 'en');
    await openPacks();
    window.setSize(640, 480);
    await checkNavigation('navigation-en-dark-narrow');
    window.setSize(...originalSize);
    await evaluate(`document.querySelector('.ia-capability-header button').click()`);
    for (const item of manager.list()) manager.remove(item.domain);
    await evaluate(`localStorage.removeItem('ia-domain-onboarding-skipped')`);
    await window.reload();
    await select('sample-c');
    await evaluate(`document.querySelector('.ia-domains-primary').click()`);
    await wait(`Boolean(document.querySelector('.ia-domain-progress'))`);
    await evaluate(
      `document.querySelector('.ia-domains-modal [aria-label="Cancel installation and close"]').click()`,
    );
    await wait(
      `!document.querySelector('.ia-domains-modal') && window.viewerHost.domainStatus().then(status=>!status.operation?.active && status.lastOperation?.outcome==='cancelled')`,
    );
    assert.equal(manager.list().length, 0);
    await evaluate(`localStorage.removeItem('ia-domain-onboarding-skipped')`);
    await window.reload();
    delay = 3;
    await select('sample-c');
    await evaluate(`document.querySelector('.ia-domains-primary').click()`);
    await wait(`Boolean(document.querySelector('.ia-domain-setup [data-action="project"]'))`);
    await evaluate(`document.querySelector('.ia-domain-setup [data-action="project"]').click()`);
    await wait(
      `Boolean(document.querySelector('.ia-create-project')) && !document.querySelector('.ia-domains-modal')`,
    );
    await screenshot('08-create-project');
    fs.writeFileSync(
      path.join(root, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          transport: 'signed local fixture HTTPS responses',
          nativeFixture: Boolean(asset),
          phases,
          navigationChecks,
          checks: [
            'language-switch-awaits-render-and-settings-close',
            'external-process-progress-close-and-terminal-refresh',
            'catalog-unconfigured-unavailable-connected',
            'all-declared-domains-visible-with-unavailable-reasons',
            'multi-select-space',
            'download-speed-eta',
            'cancel-retry',
            'native-fixture-check-repair',
            'failure-preserves-installed',
            'failed-update-preserves-version-and-retries',
            'background-reopen-cancel',
            'cancel-ipc-awaits-terminal',
            'concurrent-remove-rejected-and-installed-domain-preserved',
            'remove-outcome',
            'close-cancels-and-waits',
            'model-next-step',
            'project-next-step',
            'chinese',
            'light-dark-640x480-layout',
            'capability-navigation-alignment-and-keyboard-focus',
          ],
        },
        null,
        2,
      ),
    );
    console.log(`Installation experience selftest passed: ${root}`);
  } finally {
    externalProcess?.kill();
    global.fetch = originalFetch;
  }
}
module.exports = { run };
