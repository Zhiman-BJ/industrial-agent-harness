const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { createArchive, digest, signCatalog } = require('@industrial-agent-harness/pack-manager');

async function prepare(manager, root) {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  const apps = [path.join(root, 'Fixture-one.app'), path.join(root, 'Fixture-two.app')];
  for (const app of apps) {
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(
      path.join(app, 'Contents/MacOS/fixture'),
      '#!/bin/sh\nif [ -f "' +
        path.join(root, 'slow') +
        '" ]; then sleep 20; fi\nprintf "fixture-1.0\\n"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(app, 'Contents/Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>example.runtime.fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', app], {
        encoding: 'utf8',
      });
      if (result.status) throw Error(result.stderr);
    }
  }
  const executable = path.join(root, 'fixture-cli');
  const runtime = path.join(root, 'fixture-runtime');
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  for (const file of [executable, path.join(runtime, 'bin/fixture')])
    fs.writeFileSync(file, '#!/bin/sh\nprintf "fixture-native-1.0\\n"\n', { mode: 0o755 });
  const source = path.join(root, 'bundle');
  fs.mkdirSync(source, { recursive: true });
  const asset = {
    id: 'fixture',
    label: 'Fixture application',
    type: 'macos-app-zip',
    platform: `${process.platform}-${process.arch}`,
    version: '1.0.0',
    url: 'https://example.invalid/native.zip',
    sha256: '0'.repeat(64),
    size: 1,
    installedSize: 1024,
    app: 'Fixture.app',
    executable: 'Contents/MacOS/fixture',
    environment: 'INDUSTRIAL_HARNESS_FIXTURE_CMD',
    versionArgs: ['--version'],
    versionText: 'fixture-1.0',
    discoveryPaths: apps,
    installUrl: 'https://example.com/download',
    profileEnvironment: {},
  };
  const bundle = {
    schemaVersion: 1,
    domain: 'environment-fixture',
    label: 'Environment fixture',
    emoji: '',
    version: '1.0.0',
    coreApi: 1,
    capabilities: [],
    skills: [],
    providerPacks: [],
    runtimeAssets: [
      asset,
      {
        id: 'fixture-cli',
        label: 'Fixture command line tool',
        type: 'native-executable',
        platform: `${process.platform}-${process.arch}`,
        version: '1.0.0',
        environment: 'INDUSTRIAL_HARNESS_FIXTURE_CLI',
        probeId: 'version',
        versionText: 'fixture-native-1.0',
        installUrl: 'https://example.com/cli',
      },
      {
        id: 'fixture-runtime',
        label: 'Fixture private runtime',
        type: 'native-runtime-zip',
        platform: `${process.platform}-${process.arch}`,
        version: '1.0.0',
        directory: 'fixture-runtime',
        executable: 'bin/fixture',
        environment: 'INDUSTRIAL_HARNESS_FIXTURE_RUNTIME',
        probeId: 'version',
        versionText: 'fixture-native-1.0',
        url: 'https://example.invalid/runtime.zip',
        sha256: '0'.repeat(64),
        size: 1,
        installedSize: 1024,
      },
    ],
    executionProfiles: [
      {
        id: 'native',
        label: 'Fixture native',
        kind: 'native',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: ['fixture.inspect'],
        assetIds: ['fixture'],
      },
      {
        id: 'cli',
        label: 'Fixture external CLI',
        kind: 'native',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: ['fixture.cli'],
        assetIds: ['fixture-cli'],
      },
      {
        id: 'runtime',
        label: 'Fixture runtime folder',
        kind: 'native',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: ['fixture.runtime'],
        assetIds: ['fixture-runtime'],
      },
      {
        id: 'container',
        label: 'Fixture container',
        kind: 'container',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: [],
        assetIds: [],
      },
      {
        id: 'unsupported',
        label: 'Unqualified profile',
        kind: 'container',
        qualified: false,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: [],
        assetIds: [],
      },
      {
        id: 'service',
        label: 'Paired service',
        kind: 'remote',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: ['fixture.remote'],
        assetIds: [],
        connection: {
          kind: 'runtime-managed',
          verification: 'runtime-handshake',
          environment: [
            { name: 'INDUSTRIAL_HARNESS_FIXTURE_ENDPOINT', type: 'endpoint' },
            { name: 'INDUSTRIAL_HARNESS_FIXTURE_TOKEN', type: 'secret' },
            { name: 'INDUSTRIAL_HARNESS_FIXTURE_SHA', type: 'sha256' },
          ],
        },
      },
      {
        id: 'remote',
        label: 'Fixture remote',
        kind: 'remote',
        qualified: false,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: [],
        assetIds: [],
      },
    ],
  };
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  const bytes = createArchive(source);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = path.join(root, 'keys.json');
  fs.writeFileSync(
    keys,
    JSON.stringify({ fixture: publicKey.export({ type: 'spki', format: 'pem' }) }),
  );
  const entry = {
    domain: bundle.domain,
    label: bundle.label,
    version: bundle.version,
    sha256: digest(bytes),
    size: bytes.length,
    url: 'fixture.hpack',
    platforms: [`${process.platform}-${process.arch}`],
    runtimeAssets: bundle.runtimeAssets,
  };
  const catalog = signCatalog(
    { schemaVersion: 1, channel: 'beta', packs: [entry] },
    'fixture',
    privateKey,
  );
  process.env.INDUSTRIAL_HARNESS_PACK_CATALOG_URL =
    'https://environment-fixture.example/catalog.json';
  process.env.INDUSTRIAL_HARNESS_PACK_KEYS_FILE = keys;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname !== 'environment-fixture.example') return originalFetch(url, options);
    if (parsed.pathname === '/catalog.json') return new Response(JSON.stringify(catalog));
    assert.equal(
      parsed.pathname,
      '/fixture.hpack',
      'Pack installation must not request native software.',
    );
    return new Response(bytes);
  };
  return { apps, executable, runtime, bundle, root };
}
async function run(window, { manager, fixture, environments, dialog }) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw Error(
      `Environment renderer timeout: ${script}\n${await evaluate('document.body.innerText')}`,
    );
  }
  const click = async label => {
    const selector = `Array.from(document.querySelectorAll('.ia-runtime-environments button')).find(item=>item.textContent===${JSON.stringify(label)}&&!item.disabled)`;
    await wait(`Boolean(${selector})`);
    await evaluate(`(${selector}).click()`);
  };
  await require('./selftest-language.cjs').setLanguage(window, 'en');
  await wait(
    `Boolean(document.querySelector('.ia-domain-install-row[data-domain="environment-fixture"] input'))`,
  );
  await evaluate(
    `document.querySelector('.ia-domain-install-row[data-domain="environment-fixture"] input').click()`,
  );
  await wait(`!document.querySelector('.ia-domains-primary')?.disabled`);
  await evaluate(`document.querySelector('.ia-domains-primary').click()`);
  await wait(`Boolean(document.querySelector('.ia-domain-setup [data-action="done"]'))`);
  assert.equal(manager.list().length, 1);
  assert.equal(
    manager.runtimeAssets.status(fixture.bundle.runtimeAssets)[0].ready,
    false,
    'Real renderer installation IPC leaves native software unprepared.',
  );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '00-pack-only.png'),
  });
  await evaluate(`document.querySelector('.ia-domain-setup [data-action="done"]').click()`);
  await wait(`!document.querySelector('.ia-domains-modal')`);
  await wait(`Boolean(document.querySelector('.ia-settings-button'))`);
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(
    `Array.from(document.querySelectorAll('.ia-settings-row')).some(item=>item.innerText.includes('Domains'))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(item=>item.innerText.includes('Domains')).querySelector('button').click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-runtime-environments select'))`);
  await wait(
    `document.querySelector('[data-environment-status]')?.dataset.environmentStatus==='missing'`,
  );
  await click('Detect environment');
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Detection does not select')`,
  );
  assert.equal(
    await evaluate(
      `window.viewerHost.environmentDescribe({domain:'environment-fixture'}).then(value=>value.binding)`,
    ),
    null,
  );
  await wait(`document.querySelectorAll('.ia-runtime-asset select option').length===3`);
  assert.equal(
    await evaluate(`document.querySelector('.ia-runtime-asset select').value`),
    '',
    'Multiple compatible installations require explicit selection.',
  );
  const original = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.apps[1]] });
  try {
    await click('Choose installed application');
    await wait(
      `document.querySelector('.ia-runtime-asset code')?.innerText===${JSON.stringify(fixture.apps[1])}`,
    );
  } finally {
    dialog.showOpenDialog = original;
  }
  await click('Check and save environment');
  await wait(
    `document.querySelector('[data-environment-status]')?.dataset.environmentStatus==='ready'`,
  );
  assert.equal(
    await evaluate(
      `window.viewerHost.environmentDescribe({domain:'environment-fixture'}).then(value=>value.binding.assets.fixture.appPath)`,
    ),
    fixture.apps[1],
  );
  await evaluate(
    `document.querySelector('.ia-runtime-environments').scrollIntoView({block:'start'})`,
  );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '01-associated.png'),
  });
  const readyColor = await evaluate(
    `getComputedStyle(document.querySelector('[data-environment-status]')).color`,
  );
  assert.equal(
    await evaluate(`document.querySelector('[data-environment-status]').classList.contains('ok')`),
    true,
  );
  assert.equal(
    await evaluate(`document.querySelector('[data-asset="fixture"]').dataset.dependencyStatus`),
    'ready',
  );
  await evaluate(
    `(() => { const select=document.querySelector('.ia-runtime-environments select');select.value='unsupported';select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  await wait(
    `document.querySelector('[data-environment-status]')?.dataset.environmentStatus==='unsupported'`,
  );
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-runtime-environments button')).find(item=>item.textContent==='Detect environment').disabled`,
    ),
    true,
  );
  await evaluate(
    `(() => { const select=document.querySelector('.ia-runtime-environments select');select.value='native';select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  fs.writeFileSync(path.join(fixture.root, 'slow'), '');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.apps[0]] });
  try {
    await click('Choose installed application');
    await wait(
      `document.querySelector('.ia-runtime-asset code')?.innerText===${JSON.stringify(fixture.apps[0])}`,
    );
  } finally {
    dialog.showOpenDialog = original;
  }
  await click('Detect environment');
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Detecting environment…')`,
  );
  await click('Cancel');
  await wait(`document.querySelector('.ia-runtime-environments').innerText.includes('Cancelled')`);
  fs.rmSync(path.join(fixture.root, 'slow'));
  // An explicitly selected missing application produces a recoverable failure.
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [path.join(fixture.root, 'missing.app')],
  });
  try {
    await click('Choose installed application');
  } finally {
    dialog.showOpenDialog = original;
  }
  await wait(`document.querySelector('.ia-runtime-asset code')?.innerText.includes('missing.app')`);
  await click('Check and save environment');
  await wait(
    `document.querySelector('[data-environment-status]')?.dataset.environmentStatus!=='ready'`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-environment-status]').classList.contains('warn')`,
    ),
    true,
  );
  assert.notEqual(
    await evaluate(`getComputedStyle(document.querySelector('[data-environment-status]')).color`),
    readyColor,
  );
  assert.equal(
    await evaluate(`document.querySelector('[data-asset="fixture"]').dataset.dependencyStatus`),
    'missing',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Needs attention: Fixture application')`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments select').selectedOptions[0].textContent.includes('Ready')`,
    ),
    false,
    'Failed new choice must override stale saved readiness in the selector.',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Saved choice retained')`,
    ),
    true,
  );
  assert.equal(
    (await environments.describe('environment-fixture')).binding.assets.fixture.appPath,
    fixture.apps[1],
    'Failed new selection retains the prior binding.',
  );
  await evaluate(
    `document.querySelector('.ia-runtime-environments').scrollIntoView({block:'start'})`,
  );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '02-missing.png'),
  });
  const originalDetect = environments.detect;
  try {
    environments.detect = async () => {
      throw Error('Fixture detection unavailable');
    };
    await click('Detect environment');
    await wait(
      `document.querySelector('[data-environment-status]')?.dataset.environmentStatus==='failed'`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-environment-status]').classList.contains('error')`,
      ),
      true,
    );
    assert.notEqual(
      await evaluate(`getComputedStyle(document.querySelector('[data-environment-status]')).color`),
      readyColor,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-runtime-environments select').selectedOptions[0].textContent.includes('Check failed')`,
      ),
      true,
    );
    await evaluate(
      `document.querySelector('.ia-runtime-environments').scrollIntoView({block:'start'})`,
    );
    await require('./selftest-capture.cjs').captureSettled(window, {
      output: path.join(fixture.root, '02b-detection-failed.png'),
    });
  } finally {
    environments.detect = originalDetect;
  }
  // Project binding is saved through the same production IPC and shared API.
  const projectDir = path.join(fixture.root, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  await evaluate(
    `window.viewerHost.createProject({name:'Environment project',directory:${JSON.stringify(projectDir)},domain:'environment-fixture'})`,
  );
  await evaluate(`document.querySelector('.ia-capability-header button').click()`);
  await wait(`!document.querySelector('.ia-capability')`);
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(item=>item.title==='Project details').click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-project-page .ia-runtime-environments select'))`);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.apps[0]] });
  try {
    await click('Choose installed application');
    await wait(
      `document.querySelector('.ia-runtime-asset code')?.innerText===${JSON.stringify(fixture.apps[0])}`,
    );
  } finally {
    dialog.showOpenDialog = original;
  }
  await click('Check and save environment');
  await wait(
    `document.querySelector('.ia-runtime-environments')?.innerText.includes('Execution environment saved.') && !Array.from(document.querySelectorAll('.ia-runtime-environments button')).find(item=>item.textContent==='Check and save environment')?.disabled`,
  );
  const state = await evaluate(`window.viewerHost.projectBindings()`);
  assert.equal(
    await evaluate(
      `window.viewerHost.environmentDescribe({domain:'environment-fixture',projectId:${JSON.stringify(state.activeId)}}).then(value=>value.binding.assets.fixture.appPath)`,
    ),
    fixture.apps[0],
  );
  assert.equal(
    await evaluate(
      `window.viewerHost.environmentDescribe({domain:'environment-fixture'}).then(value=>value.binding.assets.fixture.appPath)`,
    ),
    fixture.apps[1],
    'Project selection does not replace the global default.',
  );
  await evaluate(
    `document.querySelector('.ia-runtime-environments').scrollIntoView({block:'start'})`,
  );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '03-project.png'),
  });
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-execution-options button')).find(item=>item.innerText.includes('Zhiman Remote')).click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-remote-project-body'))`);
  await wait(`document.querySelector('.ia-project-start').disabled`);
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.ia-remote-file-picker'))`),
    false,
    'Selecting remote never uploads files automatically.',
  );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '03b-remote-unconfigured.png'),
  });
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-execution-options button')).find(item=>item.innerText.includes('This computer')).click()`,
  );
  await wait(`Boolean(document.querySelector('.ia-runtime-environments select'))`);
  const metrics = await evaluate(
    `({ font: getComputedStyle(document.querySelector('.ia-runtime-environments')).fontFamily, label: getComputedStyle(document.querySelector('.ia-runtime-environments label')).fontSize })`,
  );
  assert.equal(metrics.label, '12px');
  assert.match(metrics.font, /apple-system|Segoe UI|PingFang|sans-serif/);
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(
    `Array.from(document.querySelectorAll('.ia-settings-row')).some(item=>item.innerText.includes('Appearance'))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(item=>item.innerText.includes('Appearance')).querySelector('button').click()`,
  );
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(`document.querySelector('.ia-app').classList.contains('theme-dark')`);
  window.setSize(760, 640);
  await wait(
    `document.querySelector('.ia-runtime-environments').getBoundingClientRect().width < 760`,
  );
  const overflow = await evaluate(
    `(() => { const node=document.querySelector('.ia-runtime-environments'); return node.scrollWidth>node.clientWidth+1; })()`,
  );
  assert.equal(overflow, false, 'Environment controls and paths fit a narrow window.');
  await evaluate(
    `document.querySelector('.ia-runtime-environments').scrollIntoView({block:'start'})`,
  );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '04-project-dark-narrow.png'),
  });
  // Exercise the real renderer form, production IPC and the OS encrypted store.
  await evaluate(
    `(() => {const select=document.querySelector('.ia-runtime-environments select');select.value='service';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(
    `Boolean(document.querySelector('input[aria-label="INDUSTRIAL_HARNESS_FIXTURE_TOKEN"]'))`,
  );
  const request = { domain: fixture.bundle.domain, profileId: 'service' };
  const before = await evaluate(
    `window.viewerHost.environmentConnectionView(${JSON.stringify(request)})`,
  );
  assert.equal(before.configured, false);
  assert.equal(
    before.canPersist,
    true,
    'Renderer credential gate requires actual OS secure storage.',
  );
  const secret = 'renderer-secret-fixture-2026';
  for (const [name, value] of Object.entries({
    INDUSTRIAL_HARNESS_FIXTURE_ENDPOINT: 'https://fixture.example/api',
    INDUSTRIAL_HARNESS_FIXTURE_TOKEN: secret,
    INDUSTRIAL_HARNESS_FIXTURE_SHA: 'a'.repeat(64),
  })) {
    await evaluate(
      `(() => {const input=document.querySelector('input[aria-label="${name}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  }
  await click('Save connection securely');
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Connection settings saved securely')`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Configure INDUSTRIAL_HARNESS_FIXTURE_ENDPOINT in trusted host settings.')`,
    ),
    false,
    'Old missing-field reasons must disappear after secure save.',
  );
  const saved = await evaluate(
    `window.viewerHost.environmentConnectionView(${JSON.stringify(request)})`,
  );
  assert.equal(saved.configured, true);
  assert.equal(saved.status, 'unchecked');
  assert.equal(saved.executable, true);
  assert.equal(
    JSON.stringify(saved).includes(secret),
    false,
    'Existing secret never returns to renderer.',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('input[aria-label="INDUSTRIAL_HARNESS_FIXTURE_TOKEN"]').value`,
    ),
    '',
  );
  await click('Check and save environment');
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Execution environment saved.')`,
  );
  const persisted = await evaluate(
    `window.viewerHost.environmentDescribe({domain:${JSON.stringify(fixture.bundle.domain)}})`,
  );
  assert.equal(JSON.stringify(persisted).includes(secret), false);
  const secureDirectory = path.join(
    require('electron').app.getPath('userData'),
    'runtime-connections',
  );
  assert.ok(fs.readdirSync(secureDirectory).length);
  for (const file of fs.readdirSync(secureDirectory))
    assert.equal(
      fs.readFileSync(path.join(secureDirectory, file)).includes(Buffer.from(secret)),
      false,
    );
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '05-remote-secure-configuration.png'),
  });
  // Delay a production IPC response after its shared backend work has completed.
  // Switching projects must invalidate every continuation, including second awaits.
  const originalDescribe = environments.describe.bind(environments);
  let releaseDescription,
    descriptionHeld = false;
  environments.describe = (...args) => {
    const value = originalDescribe(...args);
    if (!descriptionHeld) {
      descriptionHeld = true;
      return new Promise(resolve => {
        releaseDescription = () => resolve({ ...value, legacy: true });
      });
    }
    return value;
  };
  await click('Save connection securely');
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Saving connection…')`,
  );
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-runtime-environments button')).some(button=>button.textContent==='Cancel')`,
    ),
    false,
    'Secure save never offers a fake cancellation.',
  );
  const heldDeadline = Date.now() + 5000;
  while (!releaseDescription && Date.now() < heldDeadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(releaseDescription);
  const secondDir = path.join(fixture.root, 'second-project');
  fs.mkdirSync(secondDir, { recursive: true });
  await evaluate(
    `window.viewerHost.createProject({name:'Second environment project',directory:${JSON.stringify(secondDir)},domain:'environment-fixture'})`,
  );
  await wait(
    `document.querySelector('.ia-project-page')?.innerText.includes('Second environment project') && Boolean(document.querySelector('.ia-runtime-environments select'))`,
  );
  releaseDescription();
  environments.describe = originalDescribe;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments').innerText.includes('This pack has no selectable execution profiles.')`,
    ),
    false,
    'Delayed old view cannot replace the new project view.',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Connection settings saved securely')`,
    ),
    false,
    'Delayed old notice cannot replace the new context.',
  );
  await evaluate(
    `(() => {const select=document.querySelector('.ia-runtime-environments select');select.value='service';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(
    `Boolean(document.querySelector('input[aria-label="INDUSTRIAL_HARNESS_FIXTURE_TOKEN"]')) && !Array.from(document.querySelectorAll('.ia-runtime-environments button')).find(button=>button.textContent==='Save connection securely')?.disabled`,
  );
  const originalConnectionView = environments.connectionView.bind(environments);
  let releaseConnection;
  environments.connectionView = (...args) => {
    const value = originalConnectionView(...args);
    if (!releaseConnection)
      return new Promise(resolve => {
        releaseConnection = () =>
          resolve({
            ...value,
            reasons: [{ code: 'OLD_CONTEXT', message: 'Old context response must disappear' }],
          });
      });
    return value;
  };
  await wait(`document.querySelector('.ia-runtime-environments select').value==='service'`);
  await click('Detect connection configuration');
  const connectionDeadline = Date.now() + 5000;
  while (!releaseConnection && Date.now() < connectionDeadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(releaseConnection);
  await evaluate(`window.viewerHost.selectProject(${JSON.stringify(state.activeId)})`);
  await wait(
    `document.querySelector('.ia-project-page')?.innerText.includes('Environment project') && Boolean(document.querySelector('.ia-runtime-environments select'))`,
  );
  releaseConnection();
  environments.connectionView = originalConnectionView;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(
    await evaluate(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Old context response must disappear')`,
    ),
    false,
  );
  for (const file of fs.readdirSync(secureDirectory))
    fs.writeFileSync(path.join(secureDirectory, file), 'damaged-ciphertext');
  await evaluate(
    `(() => {const select=document.querySelector('.ia-runtime-environments select');select.value='native';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(`Boolean(document.querySelector('.ia-runtime-environments [data-profile="native"]'))`);
  await evaluate(
    `(() => {const select=document.querySelector('.ia-runtime-environments select');select.value='service';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Clear damaged saved connection')`,
  );
  await click('Clear damaged saved connection');
  await wait(
    `document.querySelector('.ia-runtime-environments').innerText.includes('Saved connection cleared. Enter the service settings again.')`,
  );
  assert.equal(fs.readdirSync(secureDirectory).length, 0);
  const reset = await evaluate(
    `window.viewerHost.environmentConnectionView(${JSON.stringify(request)})`,
  );
  assert.equal(reset.configured, false);
  assert.equal(reset.executable, false);
  await require('./selftest-capture.cjs').captureSettled(window, {
    output: path.join(fixture.root, '06-damaged-connection-reset.png'),
  });
  // Native file/folder selection uses production IPC and the shared detector.
  for (const [profileId, label, selectedPath, property, assetId] of [
    ['cli', 'Choose executable', fixture.executable, 'openFile', 'fixture-cli'],
    ['runtime', 'Choose runtime folder', fixture.runtime, 'openDirectory', 'fixture-runtime'],
  ]) {
    await evaluate(
      `(() => {const select=document.querySelector('.ia-runtime-environments select');select.value=${JSON.stringify(profileId)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(`Boolean(document.querySelector('[data-profile="${profileId}"]'))`);
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.ia-runtime-environments button')).some(button=>button.textContent==='Prepare managed environment'||button.textContent==='Prepare container image')`,
      ),
      false,
    );
    await assert.rejects(
      evaluate(
        `window.viewerHost.environmentPrepare({domain:'environment-fixture',profileId:${JSON.stringify(profileId)}})`,
      ),
      /official source/,
    );
    if (profileId === 'cli') {
      assert.equal(
        await evaluate(
          `Array.from(document.querySelectorAll('.ia-runtime-environments button')).some(button=>button.textContent==='Prepare managed environment'||button.textContent==='Prepare container image')`,
        ),
        false,
      );
      assert.equal(
        await evaluate(
          `document.querySelector('.ia-runtime-environments').innerText.includes('Fixture command line tool')`,
        ),
        true,
      );
    }
    dialog.showOpenDialog = async options => {
      assert.deepEqual(options.properties, [property]);
      return { canceled: false, filePaths: [selectedPath] };
    };
    try {
      await click(label);
    } finally {
      dialog.showOpenDialog = original;
    }
    await wait(
      `document.querySelector('[data-asset="${assetId}"] code')?.innerText===${JSON.stringify(selectedPath)}`,
    );
    await click('Check and save environment');
    await wait(
      `document.querySelector('[data-environment-status]')?.dataset.environmentStatus==='ready' && !Array.from(document.querySelectorAll('.ia-runtime-environments button')).find(button=>button.textContent==='Check and save environment')?.disabled`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-asset="${assetId}"]').dataset.dependencyStatus`,
      ),
      'ready',
    );
  }
  await evaluate(
    `(() => {const select=document.querySelector('.ia-runtime-environments select');select.value='container';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(`Boolean(document.querySelector('[data-profile="container"]'))`);
  let containerPrepareCalls = 0;
  const originalPrepare = environments.prepare;
  environments.prepare = async () => {
    containerPrepareCalls++;
    throw Error('Install and start Docker before preparing the container image.');
  };
  try {
    await click('Prepare container image');
    await wait(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Install and start Docker before preparing the container image.') && !Array.from(document.querySelectorAll('.ia-runtime-environments button')).find(button=>button.textContent==='Prepare container image')?.disabled`,
    );
    assert.equal(containerPrepareCalls, 1);
    environments.prepare = async domain => {
      containerPrepareCalls++;
      return {
        ...environments.describe(domain),
        binding: { profileId: 'container' },
        lastCheck: { profileId: 'container', status: 'ready', reasons: [], assets: [] },
      };
    };
    await click('Prepare container image');
    await wait(
      `document.querySelector('.ia-runtime-environments').innerText.includes('Execution environment saved.')`,
    );
    assert.equal(containerPrepareCalls, 2);
  } finally {
    environments.prepare = originalPrepare;
  }
  fs.writeFileSync(
    path.join(fixture.root, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'explicit-container-prepare-docker-guidance',
          'pack-only',
          'missing-detection',
          'multiple-installations',
          'explicit-application',
          'association',
          'unsupported',
          'cancellation',
          'failed-association',
          'ready-green-missing-amber-named-dependency',
          'latest-failure-overrides-saved-readiness',
          'detection-exception-red',
          'project-binding-isolation',
          'remote-unconfigured-no-upload',
          'remote-secure-save-no-secret-return',
          'remote-configured-requires-runtime-handshake',
          'delayed-ipc-context-isolation',
          'secure-save-has-no-fake-cancel',
          'damaged-secure-record-explicit-reset',
          'system-font',
          'dark-narrow-layout',
          'native-executable-picker-external-guidance',
          'native-runtime-directory-picker-association',
          'software-download-entrypoints-rejected',
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write('Runtime environment renderer selftest passed.\n');
}
module.exports = { prepare, run };
