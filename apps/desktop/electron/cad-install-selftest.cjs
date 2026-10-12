const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { captureSettled } = require('./selftest-capture.cjs');

async function run(window, { manager, runtime }) {
  const reportDir = process.env.HARNESS_CAD_INSTALL_REPORT_DIR;
  if (!reportDir) throw Error('CAD install selftest requires an evidence directory.');
  fs.mkdirSync(reportDir, { recursive: true });
  const contents = window.webContents;
  const continuation = process.argv.includes('--cad-install-continuation');
  const diagnostics = { phase: 'starting', waitingFor: null, lastObservation: null, events: [] };
  const saveDiagnostics = event => {
    if (event) diagnostics.events.push({ event, at: new Date().toISOString() });
    fs.writeFileSync(
      path.join(reportDir, 'cad-lifecycle.json'),
      JSON.stringify(
        {
          ...diagnostics,
          windowDestroyed: window.isDestroyed(),
          rendererDestroyed: contents.isDestroyed(),
        },
        null,
        2,
      ),
    );
  };
  window.on('close', () => saveDiagnostics('close'));
  window.on('closed', () => saveDiagnostics('closed'));
  contents.on('render-process-gone', (_event, details) =>
    saveDiagnostics(`render-process-gone: ${JSON.stringify(details)}`),
  );
  const evaluate = script => contents.executeJavaScript(script, true);
  let lastObservationAt = 0;
  async function observeRepair() {
    if (diagnostics.phase !== 'repair' || Date.now() - lastObservationAt < 2000) return;
    lastObservationAt = Date.now();
    diagnostics.lastObservation = {
      at: new Date().toISOString(),
      state: await evaluate(
        `({badges:Array.from(document.querySelectorAll('.ia-runtime-environments [data-environment-status]')).map(node=>({domain:node.closest('[data-domain]')?.dataset.domain,text:node.textContent,visible:node.getClientRects().length>0})),progress:Array.from(document.querySelectorAll('.ia-runtime-environments [role="status"]')).map(node=>({text:node.innerText,visible:node.getClientRects().length>0})),body:document.body.innerText.slice(-5000)})`,
      ),
    };
    saveDiagnostics();
  }
  async function wait(script, timeout = 60000) {
    const end = Date.now() + timeout;
    diagnostics.waitingFor = script;
    while (Date.now() < end) {
      if (window.isDestroyed() || contents.isDestroyed()) {
        saveDiagnostics('destroyed-while-waiting');
        throw Error(
          `CAD window was destroyed while waiting for: ${script}. See cad-lifecycle.json.`,
        );
      }
      await observeRepair();
      if (await evaluate(script)) {
        diagnostics.waitingFor = null;
        return;
      }
      const failure = await evaluate(
        `document.querySelector('.ia-domains-modal [role="alert"], .ia-capability-section > .ia-project-error[role="alert"], .ia-runtime-environments [role="alert"]')?.textContent || ''`,
      );
      if (failure) throw Error('CAD preparation failed: ' + failure);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error(
      'CAD installation UI timed out: ' +
        script +
        '\n' +
        (await evaluate('document.body.innerText.slice(-5000)')),
    );
  }
  const before = await evaluate('window.viewerHost.domainStatus()');
  if (process.argv.includes('--cad-install-restart')) {
    assert.equal(before.installed.find(item => item.domain === 'cad')?.runtimeState, 'ready');
    assert.equal(
      await evaluate('window.viewerHost.projectBindings().then(state => state.projects.length)'),
      1,
    );
    assert.equal(runtime().listActions().length, 2);
    assert.equal(runtime().latestCheckpoint()?.state.status, 'verified');
    if (process.argv.includes('--cad-install-upgrade')) {
      const chats = await evaluate('window.viewerHost.chats()');
      assert.equal(chats.chats.length, 1);
      const history = await evaluate(
        `window.viewerHost.chatHistory({id:${JSON.stringify(chats.chats[0].id)}})`,
      );
      assert.equal(history.turns.length, 2);
      assert.ok(history.turns.every(turn => turn.status === 'finished'));
      assert.ok(history.turns[0].task.includes('CAD_INSTALL_BUILD'));
      assert.ok(history.turns[1].task.includes('CAD_INSTALL_EDIT'));
      assert.ok(history.turns.every(turn => turn.events.length > 0));
      const model = await evaluate('window.viewerHost.modelGet()');
      assert.equal(model.provider, 'openai_legacy');
      assert.equal(model.model, 'controlled-cad-install');
      assert.equal(model.hasApiKey, true);
      assert.equal(model.keyPersisted, true);
      const oldBundle = manager.list().find(item => item.domain === 'cad');
      assert.equal(oldBundle.version, continuation ? '1.1.4-pack.6' : '1.1.4-pack.4');
      const oldAsset = oldBundle.runtimeAssets[0];
      const oldLocation = manager.runtimeAssets.location(oldAsset);
      const oldRuntime = manager.runtimeAssets.status([oldAsset])[0];
      assert.equal(oldRuntime.ready, true);
      const receiptPath = path.join(oldLocation, 'receipt.json');
      const digest = file =>
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const receiptSha256 = digest(receiptPath);
      const executableStat = fs.statSync(oldRuntime.executable);
      const bundledCatalog = manager.bundledCatalog(
        path.join(process.resourcesPath, 'bootstrap-packs'),
      );
      const targetVersion = bundledCatalog.packs.find(item => item.domain === 'cad')?.version;
      assert.ok(targetVersion, 'Signed bundled catalog declares the upgrade target.');
      const available = await evaluate('window.viewerHost.domainAvailable()');
      assert.equal(available.find(item => item.domain === 'cad')?.version, targetVersion);
      await evaluate(`window.viewerHost.domainInstall(['cad'])`);
      const updatedBundle = manager.list().find(item => item.domain === 'cad');
      const upgradeEnvironment = await evaluate(
        `window.viewerHost.environmentDescribe({domain:'cad'})`,
      );
      const upgradeNative = upgradeEnvironment.profiles.find(
        item => item.kind === 'native' && item.qualified && item.status !== 'unsupported',
      );
      assert.ok(upgradeNative, 'Upgraded CAD Pack declares a supported native profile.');
      await evaluate(
        `window.viewerHost.environmentAssociate({domain:'cad',profileId:${JSON.stringify(upgradeNative.id)},paths:${JSON.stringify({ [oldAsset.id]: path.join(oldLocation, oldAsset.app) })}})`,
      );
      assert.equal(updatedBundle.version, targetVersion);
      assert.ok(updatedBundle.runtimeAssets[0].installedSize > 0);
      const updatedRuntime = manager.runtimeAssets.status(updatedBundle.runtimeAssets)[0];
      assert.equal(updatedRuntime.ready, true);
      assert.equal(manager.runtimeAssets.location(updatedBundle.runtimeAssets[0]), oldLocation);
      assert.equal(updatedRuntime.executable, oldRuntime.executable);
      assert.equal(updatedRuntime.checkedAt, oldRuntime.checkedAt);
      assert.equal(digest(receiptPath), receiptSha256);
      const updatedStat = fs.statSync(updatedRuntime.executable);
      assert.equal(updatedStat.ino, executableStat.ino);
      assert.equal(updatedStat.dev, executableStat.dev);
      assert.equal(runtime().listActions().length, 2);
      assert.equal(runtime().listVerifications().length, 2);
      assert.ok(
        runtime()
          .listVerifications()
          .every(item => item.status === 'passed'),
      );
      assert.equal(runtime().latestCheckpoint()?.state.status, 'verified');
      const restored = await evaluate(
        `window.viewerHost.chatHistory({id:${JSON.stringify(chats.chats[0].id)}})`,
      );
      assert.deepEqual(restored.turns, history.turns);
      fs.writeFileSync(
        path.join(reportDir, continuation ? 'pack-upgrade-continuation.json' : 'pack-upgrade.json'),
        JSON.stringify(
          {
            fromVersion: oldBundle.version,
            toVersion: updatedBundle.version,
            nativeRuntimeReused: true,
            runtimeDirectory: path.relative(reportDir, oldLocation),
            receiptSha256,
            runtimeCheckedAt: oldRuntime.checkedAt,
            executableInode: executableStat.ino,
            loadedChat: { id: history.chat.id, turns: history.turns.length },
            modelConfigurationLoaded: true,
            verifiedActions: 2,
          },
          null,
          2,
        ),
      );
    }
    fs.writeFileSync(
      path.join(reportDir, continuation ? 'restart-continuation.json' : 'restart.json'),
      JSON.stringify({ ready: true, projectRestored: true, actions: 2 }),
    );
    diagnostics.phase = 'complete';
    saveDiagnostics();
    console.log('Packaged CAD restart: dependency, project and verified actions retained.');
    return;
  }
  assert.equal(before.installed.length, 0);
  // Qualification copies an externally installed app into test-owned space.
  // Harness only associates this application and never downloads native software.
  const sourceApp = fs.realpathSync(
    process.env.HARNESS_CAD_INSTALL_APP_PATH ||
      process.env.HARNESS_FREECAD_APP_PATH ||
      '/Applications/FreeCAD.app',
  );
  const externalApp = path.join(reportDir, 'external-apps', 'FreeCAD.app');
  fs.mkdirSync(path.dirname(externalApp), { recursive: true });
  fs.cpSync(sourceApp, externalApp, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  const runtimeCacheReuse = { mode: 'external-app-fixture', source: sourceApp };
  await evaluate(
    `(()=>{window.__cadInstallProgress=[];window.__cadEnvironmentProgress=[];window.viewerHost.onDomainProgress(progress=>window.__cadInstallProgress.push(progress));window.viewerHost.onEnvironmentProgress(progress=>window.__cadEnvironmentProgress.push(progress));return true;})()`,
  );
  await wait(
    `Boolean(document.querySelector('.ia-domain-install-row[data-domain="cad"]:not([data-unavailable]) input:not(:disabled)'))`,
  );
  await captureSettled(window, {
    output: path.join(reportDir, 'first-run.png'),
    readyScript: `Boolean(document.querySelector('.ia-domain-install-row[data-domain="cad"]:not([data-unavailable]) input:not(:disabled)')) && !document.querySelector('.ia-settings-popover')`,
  });
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-domain-install-row')).find(row=>row.textContent.includes('CAD')).querySelector('input').click()`,
  );
  await wait(`!document.querySelector('.ia-domains-primary').disabled`);
  await evaluate(`document.querySelector('.ia-domains-primary').click()`);
  await wait(
    `window.viewerHost.domainStatus().then(status=>status.installed.some(item=>item.domain==='cad') && Boolean(document.querySelector('.ia-domain-setup [data-action="done"]')))`,
    20 * 60 * 1000,
  );
  const installedEnvironment = await evaluate(
    `window.viewerHost.environmentDescribe({domain:'cad'})`,
  );
  const nativeProfile = installedEnvironment.profiles.find(
    item => item.kind === 'native' && item.qualified && item.status !== 'unsupported',
  );
  assert.ok(
    nativeProfile,
    'The packaged CAD acceptance needs a qualified native execution profile.',
  );
  assert.equal(
    installedEnvironment.binding,
    null,
    'Installing the source Pack does not select a software environment.',
  );
  assert.equal(
    await evaluate(
      `window.__cadInstallProgress.some(item=>item.phase==='mounting') || window.__cadEnvironmentProgress.length>0`,
    ),
    false,
    'Pack installation does not run native software preparation.',
  );
  await captureSettled(window, {
    output: path.join(reportDir, 'pack-installed-before-environment.png'),
  });
  await evaluate(
    `(() => {const select=document.querySelector('.ia-runtime-environments[data-domain="cad"] select');select.value=${JSON.stringify(nativeProfile.id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).some(button=>button.textContent==='Prepare container image')`,
    ),
    false,
  );
  await assert.rejects(
    evaluate(
      `window.viewerHost.environmentPrepare({domain:'cad',profileId:${JSON.stringify(nativeProfile.id)}})`,
    ),
    /official source/,
  );
  const { dialog } = require('electron');
  const originalDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [externalApp] });
  try {
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(button=>button.textContent==='Choose installed application').click()`,
    );
  } finally {
    dialog.showOpenDialog = originalDialog;
  }
  await wait(
    `document.querySelector('.ia-runtime-environments[data-domain="cad"] code')?.innerText===${JSON.stringify(externalApp)}`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(button=>button.textContent==='Check and save environment'&&!button.disabled).click()`,
  );
  await wait(
    `document.querySelector('.ia-runtime-environments[data-domain="cad"] [data-environment-status]')?.dataset.environmentStatus==='ready' && document.querySelector('.ia-runtime-environments[data-domain="cad"]')?.innerText.includes('Execution environment saved.') && !Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(button=>button.textContent==='Check and save environment')?.disabled`,
    20 * 60 * 1000,
  );
  const selectedEnvironment = await evaluate(
    `window.viewerHost.environmentDescribe({domain:'cad'})`,
  );
  assert.equal(selectedEnvironment.binding.profileId, nativeProfile.id);
  assert.equal(selectedEnvironment.status, 'ready');
  await evaluate(`document.querySelector('.ia-domain-setup [data-action="done"]').click()`);
  await wait(`!document.querySelector('.ia-domains-modal')`);
  const bundle = manager.list().find(item => item.domain === 'cad');
  const nativeAsset = bundle.runtimeAssets.find(asset => nativeProfile.assetIds.includes(asset.id));
  const dependency = {
    ready: true,
    source: 'external',
    executable: fs.realpathSync(path.join(externalApp, nativeAsset.executable)),
  };
  assert.equal(dependency.executable.startsWith(manager.directory), false);
  assert.ok(
    dependency.executable.startsWith(fs.realpathSync(externalApp) + path.sep),
    'Damage recovery may only modify the test-owned external app.',
  );
  const executableBackup = fs.readFileSync(dependency.executable);
  const executableMode = fs.statSync(dependency.executable).mode;
  const project = path.join(reportDir, 'project');
  fs.mkdirSync(project);
  await evaluate(
    `window.viewerHost.createProject(${JSON.stringify({ directory: project, domain: 'cad', name: 'CAD install acceptance' })})`,
  );
  const profile = {
    provider: 'openai_legacy',
    endpoint: process.env.HARNESS_CAD_INSTALL_MODEL_ENDPOINT,
    model: 'controlled-cad-install',
    contextSize: 32768,
    thinking: false,
    apiKey: 'local-cad-install-test-key',
  };
  await evaluate(`window.viewerHost.modelSave(${JSON.stringify(profile)})`);
  await window.reload();
  await wait(`Boolean(document.querySelector('.ia-project-row'))`);
  await evaluate(`document.querySelector('.ia-project-row').click()`);
  await wait(`Boolean(document.querySelector('.ia-project-start'))`);
  await evaluate(`document.querySelector('.ia-project-start').click()`);
  async function task(prompt, completed) {
    await wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
    await evaluate(
      `(()=>{const area=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(prompt)});area.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    await evaluate(`document.querySelector('.ia-send').click()`);
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      if (await evaluate(`Boolean(document.querySelector('.ia-approval button'))`))
        await evaluate(`document.querySelector('.ia-approval button').click()`);
      if (
        runtime().listActions().length === completed &&
        (await evaluate(
          `!document.querySelector('button[title="Stop agent"]') && document.querySelector('.ia-agent-flow')?.textContent.includes('CAD_INSTALL_TASK_OK')`,
        ))
      )
        return;
      const error = await evaluate(`document.querySelector('.ia-flow-error')?.textContent || ''`);
      if (error) throw Error(error);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error(
      'Packaged native Kimi CAD task timed out: ' +
        (await evaluate('document.body.innerText.slice(-5000)')),
    );
  }
  await task(
    'CAD_INSTALL_BUILD: FreeCAD 建模一个 40×20×5 mm 底板，在 (10,10) 打半径 2 mm 的贯穿孔。',
    1,
  );
  await task('CAD_INSTALL_EDIT: 把宽度改成30，孔半径改为3；保留旧模型并验证新尺寸。', 2);
  const actions = runtime().listActions(),
    verifications = runtime().listVerifications();
  assert.deepEqual(actions.map(action => action.toolId).sort(), [
    'cad.freecad.build',
    'cad.freecad.edit',
  ]);
  assert.ok(verifications.every(item => item.status === 'passed'));
  const models = runtime()
    .list('artifact')
    .filter(item => item.kind === 'model.cad.fcstd');
  assert.equal(models.length, 2);
  const edited = models.find(
    item => item.actionId === actions.find(action => action.toolId === 'cad.freecad.edit').id,
  );
  const readback = runtime()
    .list('artifact')
    .find(item => item.kind === 'report.cad.readback' && item.actionId === edited.actionId);
  const geometry = JSON.parse(fs.readFileSync(path.join(project, readback.relativePath), 'utf8'));
  // Verification already compares analytic dimensions and independently reopened volume.
  assert.ok(
    Math.abs(
      actions.find(item => item.id === edited.actionId).verification.metrics.volume -
        (6000 - 45 * Math.PI),
    ) < 0.001,
  );
  // Companion hash keys contain original basenames. Open the original artifact
  // from the file tree, preserving its provenance and verification association.
  await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
  await wait(`Boolean(document.querySelector('.ia-file-tree-toggle'))`);
  await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
  const relative = edited.relativePath;
  // The shared artifact opener goes through the same registered Viewer path;
  // use the registered output entry instead of a detached display fixture.
  const segments = relative.split('/');
  for (let index = 0; index < segments.length - 1; index++) {
    const folder = segments.slice(0, index + 1).join('/');
    await wait(
      `Boolean(document.querySelector('.ia-file-list button[title=${JSON.stringify(folder)}]'))`,
    );
    const next = segments.slice(0, index + 2).join('/');
    if (
      !(await evaluate(
        `Boolean(document.querySelector('.ia-file-list button[title=${JSON.stringify(next)}]'))`,
      ))
    )
      await evaluate(
        `document.querySelector('.ia-file-list button[title=${JSON.stringify(folder)}]').click()`,
      );
  }
  await wait(
    `Boolean(document.querySelector('.ia-file-list button[title=${JSON.stringify(relative)}]'))`,
  );
  await evaluate(
    `document.querySelector('.ia-file-list button[title=${JSON.stringify(relative)}]').click()`,
  );
  await wait(
    `Number(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas')?.dataset.renderedTriangles)>20 && document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas')?.dataset.geometry==='brep'`,
  );
  await captureSettled(window, {
    output: path.join(reportDir, 'cad-viewer.png'),
    readyScript: `Number(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-cad canvas')?.dataset.renderedTriangles)>20`,
  });
  // A lost runtime executable must become repairable through the ordinary UI.
  diagnostics.phase = 'repair';
  saveDiagnostics();
  fs.rmSync(dependency.executable);
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(`Boolean(document.querySelector('.ia-settings-row'))`);
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.textContent.includes('Domains')).querySelector('button').click()`,
  );
  await wait(
    `Boolean(document.querySelector('.ia-runtime-environments[data-domain="cad"] [data-environment-status]')) && document.querySelector('.ia-runtime-environments[data-domain="cad"] [data-environment-status]').dataset.environmentStatus !== 'ready'`,
  );
  await assert.rejects(
    evaluate(
      `window.viewerHost.environmentPrepare({domain:'cad',profileId:${JSON.stringify(nativeProfile.id)}})`,
    ),
    /official source/,
  );
  fs.writeFileSync(dependency.executable, executableBackup, { mode: executableMode });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [externalApp] });
  try {
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(node=>node.textContent==='Choose installed application'&&!node.disabled).click()`,
    );
    await wait(
      `document.querySelector('.ia-runtime-environments[data-domain="cad"] code')?.innerText===${JSON.stringify(externalApp)}`,
    );
  } finally {
    dialog.showOpenDialog = originalDialog;
  }
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(node=>node.textContent==='Check and save environment'&&!node.disabled).click()`,
  );
  await wait(
    `document.querySelector('.ia-runtime-environments[data-domain="cad"] [data-environment-status]')?.dataset.environmentStatus==='ready' && document.querySelector('.ia-runtime-environments[data-domain="cad"]')?.innerText.includes('Execution environment saved.') && !Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(button=>button.textContent==='Check and save environment')?.disabled`,
    10 * 60 * 1000,
  );
  await captureSettled(window, {
    output: path.join(reportDir, 'domain-ready.png'),
    readyScript: `document.querySelector('.ia-runtime-environments[data-domain="cad"] [data-environment-status]')?.dataset.environmentStatus==='ready' && document.querySelector('.ia-runtime-environments[data-domain="cad"]')?.innerText.includes('Execution environment saved.') && !Array.from(document.querySelectorAll('.ia-runtime-environments[data-domain="cad"] button')).find(button=>button.textContent==='Check and save environment')?.disabled`,
  });
  assert.equal(
    (await evaluate(`window.viewerHost.environmentDescribe({domain:'cad'})`)).status,
    'ready',
  );
  diagnostics.phase = 'complete';
  saveDiagnostics();
  fs.writeFileSync(
    path.join(reportDir, 'acceptance.json'),
    JSON.stringify(
      {
        platform: `${process.platform}-${process.arch}`,
        packaged: true,
        dependency: { ...dependency, executable: path.relative(reportDir, dependency.executable) },
        actions: actions.map(item => ({ id: item.id, toolId: item.toolId, status: item.status })),
        verifications,
        checkpoint: runtime().latestCheckpoint(),
        readback: geometry,
        viewer: 'OCCT BREP',
        repaired: true,
        packInstalledBeforeEnvironment: true,
        selectedExecutionProfile: nativeProfile.id,
        environmentAssociatedExplicitly: true,
        preparationMode: 'external-app-association',
        runtimeCacheReuse,
      },
      null,
      2,
    ),
  );
  console.log(
    'Packaged CAD installation → native Kimi approvals → FreeCAD build/edit → independent readback → OCCT Viewer → repair passed:',
    reportDir,
  );
}
module.exports = { run };
