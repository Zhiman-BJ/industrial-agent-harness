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
        `({badges:Array.from(document.querySelectorAll('.ia-pack-badge')).map(node=>({domain:node.closest('[data-domain]')?.dataset.domain,text:node.textContent,visible:node.getClientRects().length>0})),progress:Array.from(document.querySelectorAll('.ia-domain-progress')).map(node=>({text:node.innerText,visible:node.getClientRects().length>0})),body:document.body.innerText.slice(-5000)})`,
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
        `document.querySelector('.ia-domains-modal [role="alert"], .ia-capability-section > .ia-project-error[role="alert"]')?.textContent || ''`,
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
      assert.equal(targetVersion, '1.1.4-pack.8');
      const available = await evaluate('window.viewerHost.domainAvailable()');
      assert.equal(available.find(item => item.domain === 'cad')?.version, targetVersion);
      await evaluate(`window.viewerHost.domainInstall(['cad'])`);
      const updatedBundle = manager.list().find(item => item.domain === 'cad');
      assert.equal(updatedBundle.version, targetVersion);
      assert.ok(updatedBundle.agents?.some(agent => agent.domain === updatedBundle.domain));
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
  // Optional CI/local cache is the exact official DMG, checked again by the
  // production manager. Neither app mounting nor native verification is mocked.
  const cacheFile = process.env.HARNESS_CAD_INSTALL_ARCHIVE;
  const preparedRuntime = process.env.HARNESS_CAD_INSTALL_RUNTIME_CACHE;
  let runtimeCacheReuse = null;
  if (cacheFile || preparedRuntime) {
    const bundled = new (require('@industrial-agent-harness/pack-manager').PackManager)();
    const catalog = bundled.bundledCatalog(path.join(process.resourcesPath, 'bootstrap-packs'));
    const archive = fs.readFileSync(
      path.join(
        process.resourcesPath,
        'bootstrap-packs',
        catalog.packs.find(item => item.domain === 'cad').url,
      ),
    );
    const { bundle } = require('@industrial-agent-harness/pack-manager').decodeArchive(archive);
    const asset = bundle.runtimeAssets[0];
    if (preparedRuntime) {
      const source = fs.realpathSync(preparedRuntime);
      const destination = manager.runtimeAssets.directory;
      fs.mkdirSync(destination, { recursive: true });
      assert.notEqual(source, fs.realpathSync(destination));
      assert.equal(
        fs.readdirSync(destination).length,
        0,
        'Warm qualification still requires an empty isolated runtime store.',
      );
      fs.rmdirSync(destination); // Empty isolated destination; cp creates it exclusively.
      fs.cpSync(source, destination, {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        force: false,
        errorOnExist: true,
      });
      const status = manager.runtimeAssets.status([asset])[0];
      assert.equal(
        status.ready,
        true,
        'Production readiness must validate the copied receipt and executable.',
      );
      const originalExecutable = path.join(source, path.relative(destination, status.executable));
      const originalStat = fs.statSync(originalExecutable),
        clonedStat = fs.statSync(status.executable);
      assert.ok(
        originalStat.dev !== clonedStat.dev || originalStat.ino !== clonedStat.ino,
        'Repair must not modify the source runtime inode.',
      );
      runtimeCacheReuse = {
        mode: 'independent-clone',
        source,
        ready: true,
        checkedAt: status.checkedAt,
      };
      assert.equal(
        manager.list().length,
        0,
        'No installed Pack may be seeded by warm qualification.',
      );
    }
    if (cacheFile) {
      const cache = path.join(manager.runtimeAssets.directory, 'cache');
      fs.mkdirSync(cache, { recursive: true });
      const destination = path.join(cache, asset.sha256 + '.dmg');
      if (!fs.existsSync(destination)) fs.copyFileSync(cacheFile, destination);
    }
  }
  await evaluate(
    `(()=>{window.__cadInstallProgress=[]; window.viewerHost.onDomainProgress(progress=>window.__cadInstallProgress.push(progress));return true;})()`,
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
    `window.viewerHost.domainStatus().then(status=>status.installed.some(item=>item.domain==='cad' && item.runtimeState==='ready') && Boolean(document.querySelector('.ia-domain-setup [data-action="done"]')))`,
    20 * 60 * 1000,
  );
  await evaluate(`document.querySelector('.ia-domain-setup [data-action="done"]').click()`);
  await wait(`!document.querySelector('.ia-domains-modal')`);
  const bundle = manager.list().find(item => item.domain === 'cad');
  const dependency = manager.runtimeAssets.status(bundle.runtimeAssets)[0];
  assert.equal(dependency.ready, true);
  assert.ok(dependency.executable.startsWith(manager.directory));
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
    `document.querySelector('.ia-pack-card[data-domain="cad"] .ia-pack-badge')?.textContent.includes('Needs preparation')`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-pack-actions button')).find(node=>node.textContent.includes('Prepare / retry')).click()`,
  );
  await wait(
    `document.querySelector('.ia-pack-card[data-domain="cad"] .ia-pack-badge')?.textContent.includes('Ready to use') && !document.querySelector('.ia-domain-progress')`,
    10 * 60 * 1000,
  );
  await captureSettled(window, {
    output: path.join(reportDir, 'domain-ready.png'),
    readyScript: `document.querySelector('.ia-pack-card[data-domain="cad"] .ia-pack-badge')?.textContent.includes('Ready to use') && !document.querySelector('.ia-domain-progress')`,
  });
  assert.equal(manager.runtimeAssets.status(bundle.runtimeAssets)[0].ready, true);
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
        preparationMode: runtimeCacheReuse ? 'warm-runtime-reuse' : 'cold-native-preparation',
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
