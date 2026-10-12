const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const owner = require('@zhiman-bj/industrial-domain-packs');
const {
  PackManager,
  RuntimeEnvironmentManager,
  createArchive,
  digest,
} = require('../../pack-manager/src/index.cjs');
const { createProjectRuntime } = require('../src/project-runtime.cjs');
const { loadRegistry } = require('../../domain-skills/src/installed.cjs');

test(
  'real managed Godot existing application association executes through the shared project Runtime',
  {
    skip: process.env.HARNESS_TEST_NATIVE_ENVIRONMENTS !== '1',
    timeout: 180000,
  },
  async t => {
    assert.equal(process.platform + '-' + process.arch, 'darwin-arm64');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-native-env-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = owner.sourceDirectory('godot-pack'),
      pack = structuredClone(owner.hostPacks().find(item => item.id === 'godot-pack'));
    const stage = path.join(root, 'stage'),
      store = path.join(root, 'store'),
      project = path.join(root, 'project');
    fs.cpSync(source, path.join(stage, 'domain-packs', 'godot'), { recursive: true });
    fs.cpSync(path.join(source, 'examples', 'structural'), project, { recursive: true });
    const skillNames = [
      ...new Set(pack.capabilities.flatMap(capability => capability.skills.map(skill => skill.id))),
    ];
    const skills = skillNames.map(id => {
      const target = path.join(stage, 'skills', id);
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(
        path.join(source, 'skills', id.replaceAll('.', '-'), 'SKILL.md'),
        path.join(target, 'SKILL.md'),
      );
      return { id, domain: pack.domain, title: id, file: `skills/${id}/SKILL.md` };
    });
    pack.runtimeAssets[0].discoveryPaths = ['/Applications/Godot.app'];
    const profile = {
      id: 'godot-native',
      label: 'Godot native',
      kind: 'native',
      qualified: true,
      platforms: ['darwin-arm64'],
      toolIds: pack.provider.tools.map(tool => tool.id),
      assetIds: ['godot'],
    };
    const bundle = {
      schemaVersion: 1,
      coreApi: 1,
      domain: pack.domain,
      version: pack.version,
      label: 'Godot',
      emoji: 'G',
      capabilities: pack.capabilities,
      skills,
      providerPacks: [pack],
      runtimeAssets: pack.runtimeAssets,
      executionProfiles: [profile],
    };
    if (process.env.HARNESS_TEST_PLATFORM_PROBE) {
      const file = `components/${process.platform}-${process.arch}/industrial-environment-probe`;
      const content = fs.readFileSync(process.env.HARNESS_TEST_PLATFORM_PROBE);
      fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
      fs.writeFileSync(path.join(stage, file), content, { mode: 0o755 });
      bundle.platformProbe = {
        schemaVersion: 1,
        platform: process.platform + '-' + process.arch,
        file,
        sha256: digest(content),
        sizeBytes: content.length,
      };
    }
    fs.writeFileSync(path.join(stage, 'bundle.json'), JSON.stringify(bundle));
    const bytes = createArchive(stage),
      manager = new PackManager({ directory: store });
    await manager.install(
      { domain: bundle.domain, version: bundle.version, sha256: digest(bytes), size: bytes.length },
      { bytes, allowUnsigned: true },
    );
    const environments = new RuntimeEnvironmentManager({ manager });
    const environment = {
      ...process.env,
      INDUSTRIAL_HARNESS_PACK_STORE: store,
      INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config'),
      INDUSTRIAL_HARNESS_GODOT_CMD: '/untrusted/override',
    };
    assert.equal(environments.describe('godot', { projectDir: project }).status, 'unchecked');
    let registry = loadRegistry(environment, { projectDir: project });
    assert.equal(
      registry.capabilities.some(capability =>
        capability.tools.some(tool => tool.id === 'godot.scene.verify'),
      ),
      false,
    );
    const associated = await environments.associate('godot', {
      profileId: profile.id,
      projectDir: project,
    });
    assert.equal(associated.status, 'ready', JSON.stringify(associated));
    if (bundle.platformProbe)
      assert.ok(
        associated.binding.assets.godot.probeIdentity,
        'declared Go probe must leave its identity in the external receipt',
      );
    registry = loadRegistry(environment, { projectDir: project });
    const view = createProjectRuntime({
      projectDir: project,
      domain: 'godot',
      directory: path.join(root, 'state'),
      environment,
      registry,
    });
    t.after(() => view.runtime.close());
    const state = await view.runtime.inspect();
    const result = await view.runtime.execute(
      {
        toolId: 'godot.scene.verify',
        inputs: {
          file: 'main.tscn',
          frames: 12,
          expect: [
            { node: 'Box', property: 'mesh_size', value: [2, 3, 4] },
            { node: 'Box', property: 'position', value: [1, 2, 3] },
          ],
        },
        expectedStateId: state.id,
      },
      {
        approval: true,
        scope: {
          domain: 'godot',
          projectId: state.projectId,
          stateId: state.id,
          tools: ['godot.scene.verify'],
        },
      },
    );
    assert.equal(result.verification.status, 'passed', JSON.stringify(result.action));
    assert.equal(view.configurationCurrent(), true);
    environments.clear('godot', { projectDir: project });
    assert.equal(view.configurationCurrent(), false);
    await view.runtime.close();
    const reopened = createProjectRuntime({
      projectDir: project,
      domain: 'godot',
      directory: path.join(root, 'state'),
      environment,
    });
    t.after(() => reopened.runtime.close());
    assert.equal(
      reopened.capabilities.some(capability =>
        capability.tools.some(tool => tool.id === 'godot.scene.verify'),
      ),
      false,
    );
  },
);
