const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  PackManager,
  RuntimeEnvironmentManager,
} = require('../../packages/pack-manager/src/index.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Explicit native qualification command; never silently skip a missing platform,
// release catalog, probe, or software download. Portable fixtures live elsewhere.
test(
  'installed native DXF associates external software without Docker, persists evidence and rejects runtime tampering',
  { timeout: 600000 },
  async t => {
    assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64');
    assert.ok(
      process.env.HARNESS_DXF_RELEASE_DIR,
      'Set HARNESS_DXF_RELEASE_DIR to a freshly built production catalog.',
    );
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dxf-installed-native-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const manager = new PackManager({ directory: path.join(root, 'packs') });
    const entry = manager
      .bundledCatalog(process.env.HARNESS_DXF_RELEASE_DIR)
      .packs.find(item => item.domain === 'cad');
    assert.ok(entry);
    const progress = [];
    await manager.install(entry, { onProgress: event => progress.push(event.phase) });
    assert.equal(
      progress.includes('downloading'),
      false,
      'Bundled Pack install must not download software.',
    );
    const installed = manager.list()[0];
    assert.ok(installed.platformProbe, 'Production Go probe must ship in the Pack.');
    const asset = installed.runtimeAssets.find(item => item.id === 'cad-dxf-native');
    const profile = installed.executionProfiles.find(item => item.id === 'dxf-native');
    assert.equal(asset.type, 'native-runtime-zip');
    assert.equal(profile.qualified, true);
    assert.deepEqual(profile.assetIds, [asset.id]);
    const environment = {
      PATH: '/usr/bin:/bin',
      DOCKER_HOST: 'unix:///nonexistent-dxf-qualification.sock',
      INDUSTRIAL_HARNESS_PACK_STORE: manager.directory,
      INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config'),
    };
    const environments = new RuntimeEnvironmentManager({ manager, environment });
    const missing = await environments.detect('cad', { profileId: profile.id });
    assert.equal(missing.status, 'missing');
    const start = Date.now();
    assert.ok(
      process.env.HARNESS_DXF_RUNTIME_DIRECTORY,
      'Externally prepare a DXF runtime directory before running this qualification.',
    );
    const external = path.join(root, 'external-dxf-runtime');
    fs.cpSync(fs.realpathSync(process.env.HARNESS_DXF_RUNTIME_DIRECTORY), external, {
      recursive: true,
    });
    const paths = { [asset.id]: external };
    const refused = await environments.prepare('cad', {
      profileId: profile.id,
      projectDir: project,
    });
    assert.equal(refused.reasons[0].code, 'DEPENDENCY_INSTALLATION_EXTERNAL');
    const ready = await environments.associate('cad', {
      profileId: profile.id,
      projectDir: project,
      paths,
    });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    assert.ok(
      ready.binding.assets[asset.id].probeIdentity,
      'External association uses the shipped Go probe.',
    );
    const status = { executable: path.join(external, asset.executable) };
    const library = path.join(external, 'site/ezdxf/__init__.py');
    const originalLibrary = fs.readFileSync(library);
    const backend = require('../../packages/domain-runtime/src/index.cjs');
    const executeTask = backend.executeTask;
    const executions = [];
    let cancelNext;
    t.mock.method(backend, 'executeTask', async (task, options) => {
      assert.equal(
        task.runtime.kind,
        'local',
        'Every engineering operation must use the protected native backend.',
      );
      assert.equal(task.command[0], status.executable);
      const pending = executeTask(task, options);
      if (cancelNext) {
        setTimeout(cancelNext, 20);
        cancelNext = null;
      }
      const result = await pending;
      executions.push({
        kind: result.runtime.kind,
        command: result.identity.launchPath,
        status: result.status,
      });
      return result;
    });
    delete require.cache[require.resolve('../../packages/harness-core/src/project-runtime.cjs')];
    const { createProjectRuntime } = require('../../packages/harness-core/src/project-runtime.cjs');
    const open = () =>
      createProjectRuntime({
        projectDir: project,
        domain: 'cad',
        directory: path.join(root, 'state'),
        environment,
      });
    let view = open();
    t.after(() => view?.runtime.close());
    const call = async (name, inputs) => {
      const state = await view.runtime.inspect();
      const toolId = 'cad.dxf.' + name;
      return view.runtime.execute(
        { toolId, inputs, expectedStateId: state.id },
        {
          approval: true,
          scope: { domain: 'cad', projectId: state.projectId, stateId: state.id, tools: [toolId] },
        },
      );
    };
    const expect = { units: 'mm', entityCount: 1, circles: [{ center: [10, 20], diameter: 6 }] };
    const created = await call('create', {
      file: 'plate.dxf',
      expectedSha256: null,
      recipe: { units: 'mm', entities: [{ type: 'circle', center: [10, 20], radius: 3 }] },
      expect,
    });
    assert.equal(created.verification.status, 'passed', JSON.stringify(created.action));
    assert.ok(created.artifacts.length);
    assert.equal(
      (await call('inspect', { file: 'plate.dxf', expect })).verification.status,
      'not_run',
    );
    assert.equal(
      (
        await call('verify', {
          file: 'plate.dxf',
          expect: { circles: [{ center: [10, 20], diameter: 7 }] },
        })
      ).verification.status,
      'failed',
    );
    const before = hash(path.join(project, 'plate.dxf'));
    const invalid = await call('create', {
      file: 'plate.dxf',
      expectedSha256: before,
      recipe: { units: 'mm', entities: [{ type: 'circle', center: [0, 0], radius: -1 }] },
      expect,
    });
    assert.equal(invalid.verification.status, 'insufficient_evidence');
    assert.equal(invalid.action.status, 'failed');
    cancelNext = () => view.runtime.cancel();
    const cancelled = await call('verify', { file: 'plate.dxf', expect });
    assert.equal(cancelled.action.status, 'failed');
    assert.equal(executions.at(-1).status, 'CANCELLED');
    assert.notEqual(cancelled.verification.status, 'passed');
    assert.equal(hash(path.join(project, 'plate.dxf')), before);
    const recovered = await call('verify', { file: 'plate.dxf', expect });
    assert.equal(recovered.verification.status, 'passed');
    await view.runtime.close();
    view = open();
    assert.equal(view.runtime.latestCheckpoint().id, recovered.checkpoint.id);
    assert.equal((await view.runtime.inspect()).id, recovered.state.id);
    assert.equal(view.runtime.listVerifications().length, 6);
    fs.appendFileSync(library, '\n# qualification tamper\n');
    assert.notEqual(environments.describe('cad', { projectDir: project }).status, 'ready');
    assert.equal(view.configurationCurrent(), false);
    await view.runtime.close();
    view = null;
    // Repair is external too: restore the original tested bytes, then re-associate.
    fs.writeFileSync(library, originalLibrary);
    const repaired = await environments.associate('cad', {
      profileId: profile.id,
      projectDir: project,
      paths,
    });
    assert.equal(repaired.status, 'ready', JSON.stringify(repaired));
    view = open();
    assert.equal(
      (await call('verify', { file: 'plate.dxf', expect })).verification.status,
      'passed',
    );
    assert.deepEqual(manager.scan().errors, []);
    t.diagnostic(
      JSON.stringify({
        owner: installed.sourceRelease,
        profile: profile.id,
        runtimeSha256: asset.sha256,
        downloadBytes: 0,
        seconds: (Date.now() - start) / 1000,
        executions,
        checkpointRestored: true,
        fullTreeTamperRejected: true,
        externalRepairReassociated: true,
      }),
    );
  },
);
