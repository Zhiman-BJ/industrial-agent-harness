const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const {
  PackManager,
  createArchive,
  decodeArchive,
  digest,
  signCatalog,
} = require('../../packages/pack-manager/src/index.cjs');
const { TaskService } = require('../../packages/harness-application/src/index.cjs');
const { createProjectRuntime } = require('../../packages/harness-core/src/index.cjs');
const { configToml, sessionEnv } = require('../../packages/agent-kimi/src/model-config.cjs');
const { bundledExecutable } = require('../../packages/agent-kimi/src/code-session.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const { stageRuntimeArchiveCache } = require('../../scripts/runtime-archive-cache.cjs');
const execute = promisify(execFile),
  repo = path.resolve(__dirname, '../..');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('Installed native profiles require macOS Apple Silicon; cannot skip.');
function payload(name, modules) {
  const entry = process.env[name];
  assert.ok(
    entry,
    name +
      ' must point to a separately staged production payload; source adapters are not qualification.',
  );
  const root = name.endsWith('DESKTOP_ENTRY') ? path.resolve(entry, '../..') : path.dirname(entry);
  assert.ok(!fs.realpathSync(entry).startsWith(path.join(repo, 'apps') + path.sep));
  const requirePayload = createRequire(entry);
  for (const module of modules)
    assert.ok(
      fs.realpathSync(requirePayload.resolve(module)).startsWith(fs.realpathSync(root) + path.sep),
      'Payload must not fall through to development modules: ' + module,
    );
  return entry;
}
function plan(domain, step, project) {
  const file = domain === 'pcb' ? 'board.kicad_pcb' : 'main.tscn';
  const toolId =
    domain === 'pcb'
      ? `pcb.kicad.${step === 1 ? 'edit' : 'verify'}`
      : `godot.scene.${step === 1 ? 'edit' : 'verify'}`;
  const sha = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(project, file)))
    .digest('hex');
  const inputs =
    step === 1
      ? domain === 'pcb'
        ? {
            file,
            expectedSha256: sha,
            rectangle: { origin: [0, 0], size: [50, 35] },
            moves: [{ reference: 'H1', position: [12, 12] }],
          }
        : {
            file,
            expectedSha256: sha,
            changes: [
              {
                section: 'resource:Box_1',
                property: 'size',
                value: { type: 'Vector3', value: [4, 5, 6] },
              },
            ],
          }
      : domain === 'pcb'
        ? {
            file,
            expect: {
              bounds: [0, 0, ...(step === 0 ? [40, 30] : [50, 35])],
              footprints: [{ reference: 'H1', position: step === 0 ? [10, 10] : [12, 12] }],
              maxWarnings: 2,
            },
          }
        : {
            file,
            frames: 12,
            expect: [
              { node: 'Box', property: 'mesh_size', value: step === 0 ? [2, 3, 4] : [4, 5, 6] },
            ],
          };
  return { toolId, inputs };
}
function model(project, domain) {
  return startModel({
    resultIndex: body =>
      body.messages
        .slice(
          body.messages.findLastIndex(
            m => m.role === 'user' && /NATIVE_STEP_/.test(JSON.stringify(m)),
          ) + 1,
        )
        .filter(m => m.role === 'tool').length,
    success: 'NATIVE_EVIDENCE_RECORDED',
    calls: body => {
      const text = JSON.stringify(body.messages),
        task = body.messages.findLast(
          m => m.role === 'user' && /NATIVE_STEP_/.test(JSON.stringify(m)),
        );
      const step = Number(JSON.stringify(task).match(/NATIVE_STEP_(\d)/)?.[1]);
      assert.ok(Number.isInteger(step), JSON.stringify(task));
      const id = text
        .match(/expectedStateId=([a-f0-9-]{36})/g)
        ?.at(-1)
        ?.split('=')[1];
      assert.ok(id);
      const p = plan(domain, step, project);
      return [
        { name: 'industrial_tool_describe', arguments: { toolId: p.toolId } },
        { name: 'industrial_action_call', arguments: { ...p, expectedStateId: id } },
      ];
    },
  });
}
async function install(t, root) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const key = path.join(root, 'qualification.pem');
  fs.writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  t.after(() => fs.rmSync(key, { force: true }));
  const release = path.join(root, 'release');
  await execute(
    process.execPath,
    [path.join(repo, 'scripts/build-pack-distribution.cjs'), release],
    {
      cwd: repo,
      env: {
        ...process.env,
        HARNESS_PACK_DOMAINS: 'pcb,godot',
        HARNESS_PACK_SIGNING_KEY_FILE: key,
        HARNESS_PACK_SIGNING_KEY_ID: 'qualification',
        HARNESS_PACK_CHANNEL: 'beta',
        // GitHub-hosted macOS runners cannot run Docker. This lane proves the
        // native KiCad/Godot path; container image preparation is qualified by
        // the Linux image lanes against the same owner lock.
        HARNESS_PACK_OMIT_CONTAINER_IMAGES: '1',
      },
    },
  );
  const manager = new PackManager({
    directory: path.join(root, 'installed'),
    keys: { qualification: publicKey.export({ type: 'spki', format: 'pem' }) },
    channel: 'beta',
  });
  const originalFetch = global.fetch;
  let catalog;
  global.fetch = async () => new Response(fs.readFileSync(path.join(release, 'catalog.json')));
  try {
    catalog = await manager.catalog('https://qualification.example/catalog.json');
  } finally {
    global.fetch = originalFetch;
  }
  const progress = [],
    cachedArchives = [];
  for (const p of catalog.packs) {
    const bytes = fs.readFileSync(path.join(release, path.basename(p.url)));
    const { bundle } = decodeArchive(bytes);
    const assets = bundle.runtimeAssets || [];
    assert.ok(assets.length, 'Installed native profiles must declare managed dependencies.');
    assert.deepEqual(
      bundle.containerImages,
      [],
      'Hosted macOS qualification bundles must not advertise container images.',
    );
    cachedArchives.push(...stageRuntimeArchiveCache(manager.directory, assets));
    await manager.install(p, {
      bytes,
      prepareRuntime: true,
      onProgress: event => progress.push(event),
    });
    assert.ok(manager.runtimeAssets.status(assets).every(asset => asset.ready));
    for (const executable of Object.values(manager.runtimeAssets.environment(assets)))
      assert.ok(
        fs.realpathSync(executable).startsWith(fs.realpathSync(manager.directory) + path.sep),
      );
  }
  fs.writeFileSync(
    path.join(root, 'managed-installation.json'),
    JSON.stringify(
      {
        cachedArchives,
        progress,
        runtimes: manager.list().flatMap(pack => manager.runtimeAssets.status(pack.runtimeAssets)),
      },
      null,
      2,
    ),
  );
  // Prove that TaskService and Desktop discover managed executables from the shared store.
  const variables = manager
    .list()
    .flatMap(bundle =>
      (bundle.runtimeAssets || []).flatMap(asset => [
        asset.environment,
        ...Object.keys(asset.environmentExecutables || {}),
      ]),
    );
  const previousOverrides = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(previousOverrides)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const old = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = manager.directory;
  t.after(() => {
    if (old === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = old;
  });
  assert.deepEqual(manager.scan().errors, []);
  assert.equal(manager.scan().installed.length, 2);
  manager.qualification = {
    privateKey,
    release,
    payload: JSON.parse(fs.readFileSync(path.join(release, 'catalog.json'))).payload,
  };
  return manager;
}
test(
  'signed PCB/Godot Packs outside repositories perform continuous native tasks through real Kimi and shared TaskService, then restore durable acceptance',
  { timeout: 20 * 60 * 1000 },
  async t => {
    const evidence = process.env.HARNESS_PROFESSIONAL_EVIDENCE;
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(evidence || os.tmpdir(), 'installed-professional-')),
    );
    t.after(() => {
      if (!evidence) fs.rmSync(root, { recursive: true, force: true });
    });
    const manager = await install(t, root);
    for (const installed of manager.scan().installed) {
      assert.ok(!fs.existsSync(path.join(installed.location, 'node_modules')));
      assert.ok(!installed.location.startsWith(repo));
    }
    for (const domain of ['pcb', 'godot']) {
      const directory = path.join(root, domain + '-task-api'),
        projectDir = path.join(directory, 'project');
      const installed = manager.scan().installed.find(p => p.domain === domain);
      fs.cpSync(
        path.join(
          installed.location,
          'domain-packs',
          domain,
          'examples',
          domain === 'pcb' ? 'mounting-board' : 'structural',
        ),
        projectDir,
        { recursive: true },
      );
      const fixture = await model(projectDir, domain);
      t.after(fixture.close);
      const environment = {
        ...process.env,
        INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
      };
      const records = [];
      let chatId, tasks, entry;
      const stateDir = path.join(directory, 'state');
      const share = path.join(directory, 'share');
      fs.mkdirSync(share, { recursive: true });
      const profile = {
        provider: 'openai_legacy',
        endpoint: fixture.endpoint,
        model: 'controlled-native-professional',
        contextSize: 32768,
        thinking: false,
      };
      fs.writeFileSync(path.join(share, 'config.toml'), configToml(profile));
      tasks = new TaskService({
        environment,
        packManager: manager,
        chatDirectory: path.join(directory, 'chats'),
        runtimeOptions: { directory: stateDir },
        contextOptions: { directory: stateDir },
        logDirectory: path.join(directory, 'logs'),
        getConfig: () => ({
          profile,
          apiKey: 'local-native-key',
          shareDir: share,
          env: sessionEnv(profile, 'local-native-key'),
          environment,
          executable: bundledExecutable(),
          approvalMode: 'ask',
          disabledMcpServers: [],
        }),
      });
      t.after(() => tasks.close());
      const project = { id: domain, path: projectDir, domain };
      chatId = tasks.chats.create(projectDir, domain).id;
      entry = tasks.resume(project, chatId);
      for (let step = 0; step < 3; step++) {
        const task = `NATIVE_STEP_${step}: ${domain} native scene board edit and independent verification`;
        await tasks.prepare(entry, { task });
        const started = await tasks.start(entry, task, {
          onEvent: event => {
            if (event.type === 'approval')
              tasks.approve(entry, event.id, 'approve').catch(() => {});
            if (event.type === 'industrial-result') records.push(event);
          },
        });
        const result = await started.completion;
        assert.equal(
          result.status,
          'finished',
          JSON.stringify(tasks.history(entry.project, chatId)),
        );
        assert.equal(records.length, step + 1);
        assert.equal(
          records.at(-1).verification.status,
          step === 1 ? 'not_run' : 'passed',
          JSON.stringify(records.at(-1)),
        );
        assert.equal(records.at(-1).state.status, step === 1 ? 'stale' : 'verified');
      }
      await tasks.close();
      const restored = createProjectRuntime({
        projectDir,
        domain,
        directory: stateDir,
        environment,
      });
      try {
        assert.equal((await restored.runtime.inspect()).id, records.at(-1).state.id);
        assert.equal(restored.runtime.latestCheckpoint().id, records.at(-1).checkpoint.id);
        assert.equal(restored.runtime.listActions().length, 3);
        for (const a of records[0].artifacts)
          assert.equal(
            crypto
              .createHash('sha256')
              .update(restored.runtime.readArtifact(a.id).content)
              .digest('hex'),
            a.sha256,
          );
      } finally {
        await restored.runtime.close();
      }
      assert.deepEqual(
        manager.scan().errors,
        [],
        'Native execution must not alter installed verified Pack bytes.',
      );
      fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(records, null, 2));
      assert.ok(
        fixture.requests.length >= 9,
        'Real pinned Kimi tool loop must execute every turn.',
      );
      {
        const { privateKey, release, payload } = manager.qualification;
        const source = path.join(release, domain),
          runtimeDir = path.join(source, 'domain-packs', domain, 'runtime');
        fs.appendFileSync(
          path.join(runtimeDir, 'verifier.cjs'),
          '\n// signed qualification repair changes Verifier byte identity\n',
        );
        const declared = JSON.parse(
          fs.readFileSync(path.join(source, 'domain-packs', domain, 'harness-pack.json')),
        );
        declared.provider.sourceFiles['runtime/verifier.cjs'] = digest(
          fs.readFileSync(path.join(runtimeDir, 'verifier.cjs')),
        );
        declared.provider.sourceSha256 = digest(
          Buffer.from(JSON.stringify(declared.provider.sourceFiles)),
        );
        fs.writeFileSync(
          path.join(source, 'domain-packs', domain, 'harness-pack.json'),
          JSON.stringify(declared, null, 2),
        );
        const manifestPath = path.join(source, 'bundle.json'),
          manifest = JSON.parse(fs.readFileSync(manifestPath));
        manifest.providerPacks = manifest.providerPacks.map(p =>
          p.domain === domain ? declared : p,
        );
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const bytes = createArchive(source),
          catalog = signCatalog(
            {
              ...payload,
              packs: payload.packs
                .filter(p => p.domain === domain)
                .map(p => ({ ...p, sha256: digest(bytes), size: bytes.length })),
            },
            'qualification',
            privateKey,
          );
        const originalFetch = global.fetch;
        global.fetch = async () => new Response(JSON.stringify(catalog));
        try {
          const repair = (await manager.catalog('https://qualification.example/catalog.json'))
            .packs[0];
          await manager.install(repair, { bytes });
        } finally {
          global.fetch = originalFetch;
        }
        assert.deepEqual(manager.scan().errors, []);
        const repaired = createProjectRuntime({
          projectDir,
          domain,
          directory: stateDir,
          environment,
        });
        try {
          const current = await repaired.runtime.inspect();
          assert.equal(current.status, 'stale');
          assert.equal(
            repaired.runtime.listVerifications().find(v => v.id === records[0].verification.id)
              .status,
            'passed',
            'Historical Verification keeps its original identity.',
          );
          const p = plan(domain, 2, projectDir),
            out = await repaired.runtime.execute(
              { ...p, expectedStateId: current.id },
              {
                approval: true,
                scope: {
                  domain,
                  projectId: current.projectId,
                  stateId: current.id,
                  tools: [p.toolId],
                },
              },
            );
          assert.equal(out.verification.status, 'passed', JSON.stringify(out));
          assert.equal(out.state.status, 'verified');
          fs.writeFileSync(
            path.join(directory, 'verifier-repair.json'),
            JSON.stringify({ before: records.at(-1).state, stale: current, after: out }, null, 2),
          );
        } finally {
          await repaired.runtime.close();
        }
      }
    }
  },
);

test(
  'installed PCB/Godot tasks run through the real Desktop composer, approvals and chat history with independent native evidence',
  { timeout: 20 * 60 * 1000 },
  async t => {
    const evidence = process.env.HARNESS_PROFESSIONAL_EVIDENCE;
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(evidence || os.tmpdir(), 'desktop-professional-')),
    );
    t.after(() => {
      if (!evidence) fs.rmSync(root, { recursive: true, force: true });
    });
    const manager = await install(t, root);
    const { startDesktop } = require('./fixtures/desktop-cdp.cjs');
    const desktop = await startDesktop({
      root,
      entry: payload('HARNESS_PROFESSIONAL_DESKTOP_ENTRY', [
        '@industrial-agent-harness/harness-application',
        '@industrial-agent-harness/harness-core',
      ]),
      environment: { ...process.env, KIMI_EXECUTABLE: bundledExecutable() },
    });
    t.after(desktop.close);
    for (const domain of ['pcb', 'godot']) {
      const directory = path.join(root, domain),
        project = path.join(directory, 'project');
      const installed = manager.scan().installed.find(p => p.domain === domain);
      fs.cpSync(
        path.join(
          installed.location,
          'domain-packs',
          domain,
          'examples',
          domain === 'pcb' ? 'mounting-board' : 'structural',
        ),
        project,
        { recursive: true },
      );
      const fixture = await model(project, domain);
      t.after(fixture.close);
      await desktop.evaluate(
        `window.viewerHost.createProject(${JSON.stringify({ directory: project, domain, name: 'Native ' + domain })})`,
      );
      await desktop.evaluate(
        `window.viewerHost.modelSave(${JSON.stringify({ provider: 'openai_legacy', endpoint: fixture.endpoint, model: 'controlled-native-desktop', contextSize: 32768, thinking: false, apiKey: 'local-native-test-key' })})`,
      );
      await desktop.send('Page.reload');
      await desktop.wait(
        `Array.from(document.querySelectorAll('.ia-project-row')).some(r=>r.textContent.includes('Native '+${JSON.stringify(domain)}))`,
      );
      await desktop.evaluate(
        `Array.from(document.querySelectorAll('.ia-project-row')).find(r=>r.textContent.includes('Native '+${JSON.stringify(domain)})).click()`,
      );
      await desktop.wait(`Boolean(document.querySelector('.ia-project-start'))`);
      await desktop.evaluate(`document.querySelector('.ia-project-start').click()`);
      let history;
      for (let step = 0; step < 3; step++) {
        const task = `NATIVE_STEP_${step}: ${domain} native scene board edit and independent verification`;
        await desktop.wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
        await desktop.evaluate(
          `(()=>{const a=document.querySelector('.ia-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(a,${JSON.stringify(task)});a.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await desktop.wait(`!document.querySelector('.ia-send').disabled`);
        await desktop.evaluate(`document.querySelector('.ia-send').click()`);
        const end = Date.now() + 90000;
        while (Date.now() < end) {
          if (await desktop.evaluate(`Boolean(document.querySelector('.ia-approval button'))`))
            await desktop.evaluate(`document.querySelector('.ia-approval button').click()`);
          history = await desktop.evaluate(
            `window.viewerHost.chats().then(c=>c.activeId?window.viewerHost.chatHistory({id:c.activeId}):null)`,
          );
          const facts =
            history?.turns.flatMap(turn =>
              turn.events.filter(e => e.type === 'industrial-result'),
            ) || [];
          if (
            facts.length === step + 1 &&
            !history.executing &&
            history.turns.at(-1).status === 'finished'
          )
            break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        const facts =
          history?.turns.flatMap(turn => turn.events.filter(e => e.type === 'industrial-result')) ||
          [];
        assert.equal(facts.length, step + 1, JSON.stringify(history));
        assert.equal(history.turns.at(-1).status, 'finished', JSON.stringify(history));
        assert.equal(
          facts.at(-1).verification.status,
          step === 1 ? 'not_run' : 'passed',
          JSON.stringify(facts.at(-1)),
        );
        assert.equal(facts.at(-1).state.status, step === 1 ? 'stale' : 'verified');
      }
      await desktop.screenshot(path.join(root, domain + '-verified.png'));
      fs.writeFileSync(path.join(directory, 'chat-history.json'), JSON.stringify(history, null, 2));
      assert.deepEqual(manager.scan().errors, []);
    }
    await desktop.close();
  },
);
