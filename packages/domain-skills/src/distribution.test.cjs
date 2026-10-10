const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  PackManager,
  createArchive,
  decodeArchive,
  digest,
} = require('../../pack-manager/src/index.cjs');
const { loadRegistry, materializeInstalledSkills } = require('./installed.cjs');
const { resolve } = require('../../capability-broker/src/index.cjs');
const { copySkillResources } = require('./skill-resources.cjs');
const root = path.resolve(__dirname, '../../..');
const example = path.join(root, 'packages/pack-manager/examples/review-pack');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-release-'));
  const store = path.join(directory, 'store');
  const old = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  process.env.INDUSTRIAL_HARNESS_PACK_STORE = store;
  t.after(() => {
    if (old === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = old;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, manager: new PackManager({ directory: store }) };
}
function entry(bytes) {
  const archive = JSON.parse(zlib.gunzipSync(bytes));
  return {
    domain: archive.domain,
    version: archive.version,
    sha256: digest(bytes),
    size: bytes.length,
    platforms: [`${process.platform}-${process.arch}`],
  };
}
function mutateArchive(bytes, operation) {
  const archive = JSON.parse(zlib.gunzipSync(bytes));
  operation(archive);
  return zlib.gzipSync(JSON.stringify(archive));
}

// The archive is created by the public author command, then decoded/installed
// by PackManager and disclosed through the actual Broker/session integration.
test('external author Pack survives build, installation, Broker disclosure and scope replacement', async t => {
  const { directory, manager } = setup(t);
  const output = path.join(directory, 'review.hpack');
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/build-external-domain-pack.cjs'), example, output],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.readFileSync(output);
  assert.ok(decodeArchive(bytes).files.some(file => file.path === 'LICENSE'));
  await manager.install(entry(bytes), { bytes, allowUnsigned: true });
  const registry = loadRegistry();
  assert.deepEqual(
    registry.domains.map(domain => domain.id),
    ['review-fixture'],
  );
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const cli = spawnSync(
    process.execPath,
    [
      path.join(root, 'apps/cli/src/main.cjs'),
      'run',
      '--project-dir',
      project,
      '--domain',
      'review-fixture',
      '--task',
      'inspect report',
      '--state-dir',
      path.join(directory, 'state'),
      '--scope-only',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config') },
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const events = cli.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(events.find(event => event.type === 'scope').scope.skills, [
    'review-fixture.inspect',
  ]);
  const { scope } = resolve(
    { domain: 'review-fixture', stage: 'review', task: 'inspect report' },
    registry.capabilities,
  );
  assert.deepEqual(scope.skills, ['review-fixture.inspect']);
  const session = path.join(directory, 'session');
  const skills = materializeInstalledSkills(scope, session);
  for (const relative of ['SKILL.md', 'references/criteria.md', 'assets/report-template.md'])
    assert.equal(
      fs.readFileSync(path.join(skills, 'review-fixture.inspect', relative), 'utf8'),
      fs.readFileSync(path.join(example, 'skills/review-fixture.inspect', relative), 'utf8'),
    );
  assert.throws(
    () => materializeInstalledSkills({ skills: ['review-fixture.unknown'] }, session),
    /Unknown installed Skill/,
  );
  assert.ok(
    fs.existsSync(path.join(skills, 'review-fixture.inspect/references/criteria.md')),
    'failed disclosure preserves the last complete scope',
  );
  materializeInstalledSkills({ skills: [] }, session);
  assert.deepEqual(fs.readdirSync(skills), []);
});

test('compatible updates replace resources while corrupt and unsupported updates preserve the active release', async t => {
  const { directory, manager } = setup(t);
  const first = createArchive(example);
  await manager.install(entry(first), { bytes: first, allowUnsigned: true });
  const source = path.join(directory, 'next');
  fs.cpSync(example, source, { recursive: true });
  const manifestFile = path.join(source, 'bundle.json');
  const bundle = JSON.parse(fs.readFileSync(manifestFile));
  bundle.version = '1.1.0';
  fs.writeFileSync(manifestFile, JSON.stringify(bundle));
  fs.writeFileSync(
    path.join(source, 'skills/review-fixture.inspect/references/criteria.md'),
    'Updated criteria.\n',
  );
  const second = createArchive(source);
  const corrupt = mutateArchive(second, archive => {
    archive.files.find(file => file.path.endsWith('criteria.md')).data =
      Buffer.from('corrupt').toString('base64');
  });
  await assert.rejects(
    manager.install(entry(corrupt), { bytes: corrupt, allowUnsigned: true }),
    /file verification failed/,
  );
  assert.equal(manager.list()[0].version, '1.0.0');
  const future = mutateArchive(second, archive => {
    const file = archive.files.find(file => file.path === 'bundle.json');
    const manifest = JSON.parse(Buffer.from(file.data, 'base64'));
    manifest.coreApi = 2;
    const content = Buffer.from(JSON.stringify(manifest));
    file.data = content.toString('base64');
    file.sha256 = digest(content);
  });
  await assert.rejects(
    manager.install(entry(future), { bytes: future, allowUnsigned: true }),
    /Invalid Domain Pack manifest/,
  );
  assert.equal(manager.list()[0].version, '1.0.0');
  const release = manager.acquireUse('review-fixture');
  await assert.rejects(
    manager.install(entry(second), { bytes: second, allowUnsigned: true }),
    /in use/,
  );
  release();
  await manager.install(entry(second), { bytes: second, allowUnsigned: true });
  const skills = materializeInstalledSkills(
    { skills: ['review-fixture.inspect'] },
    path.join(directory, 'session'),
  );
  assert.equal(
    fs.readFileSync(path.join(skills, 'review-fixture.inspect/references/criteria.md'), 'utf8'),
    'Updated criteria.\n',
  );
});

test('resource tampering and symlinks are isolated before installed session disclosure', async t => {
  const { directory, manager } = setup(t);
  const bytes = createArchive(example);
  await manager.install(entry(bytes), { bytes, allowUnsigned: true });
  const file = path.join(
    manager.list()[0].location,
    'skills/review-fixture.inspect/assets/report-template.md',
  );
  fs.writeFileSync(file, 'unregistered template');
  assert.equal(manager.scan().installed.length, 0);
  assert.match(manager.scan().errors[0].message, /resource changed/);
  await manager.install(entry(bytes), { bytes, allowUnsigned: true });
  fs.unlinkSync(file);
  fs.symlinkSync(
    path.join(example, 'skills/review-fixture.inspect/assets/report-template.md'),
    file,
  );
  assert.match(manager.scan().errors[0].message, /symlinks/);
  assert.throws(
    () =>
      materializeInstalledSkills(
        { skills: ['review-fixture.inspect'] },
        path.join(directory, 'session'),
      ),
    /Unknown installed Skill/,
  );
});

test('archives reject traversal, missing entrypoints, source links and oversized Skill resources', t => {
  const { directory } = setup(t);
  const bytes = createArchive(example);
  const escaping = mutateArchive(bytes, archive => {
    archive.files[0].path = '../escaped';
  });
  assert.throws(() => decodeArchive(escaping), /Unsafe Pack path/);
  const missing = mutateArchive(bytes, archive => {
    archive.files = archive.files.filter(file => !file.path.endsWith('/SKILL.md'));
  });
  assert.throws(() => decodeArchive(missing), /Missing Domain Skill/);
  const source = path.join(directory, 'source');
  fs.cpSync(path.join(example, 'skills/review-fixture.inspect'), source, { recursive: true });
  fs.symlinkSync(path.join(example, 'LICENSE'), path.join(source, 'outside'));
  assert.throws(() => copySkillResources(source, path.join(directory, 'copy')), /symlinks/);
  fs.unlinkSync(path.join(source, 'outside'));
  fs.writeFileSync(path.join(source, 'oversized'), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => copySkillResources(source, path.join(directory, 'copy')), /size limit/);
});

test('external Skill resources stay outside public archives and load only from a matching owned checkout', async t => {
  const { directory, manager } = setup(t);
  const external = path.join(directory, 'external');
  fs.cpSync(
    path.join(example, 'skills/review-fixture.inspect'),
    path.join(external, 'skills/private-method'),
    { recursive: true },
  );
  const names = ['SKILL.md', 'assets/report-template.md', 'references/criteria.md'].sort();
  const sourceFiles = Object.fromEntries(
    names.map(name => [
      `skills/private-method/${name}`,
      digest(fs.readFileSync(path.join(external, 'skills/private-method', name))),
    ]),
  );
  const source = path.join(directory, 'bridge');
  fs.cpSync(example, source, { recursive: true });
  const bundle = JSON.parse(fs.readFileSync(path.join(source, 'bundle.json')));
  bundle.skills[0].external = {
    providerPackId: 'review-fixture-provider',
    resourcePath: 'skills/private-method',
    nativeToolPrefix: 'review-fixture.native.',
  };
  bundle.providerPacks = [
    {
      id: 'review-fixture-provider',
      domain: bundle.domain,
      version: bundle.version,
      provider: {
        domain: bundle.domain,
        packDirectory: 'review',
        title: 'Owned external source fixture',
        directoryEnv: 'REVIEW_FIXTURE_SOURCE',
        sourceCommit: '1'.repeat(40),
        resourceRoots: ['skills/private-method'],
        sourceFiles,
        sourceSha256: digest(Buffer.from(JSON.stringify(sourceFiles))),
        tools: [],
      },
    },
  ];
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  fs.mkdirSync(path.join(source, 'domain-packs/review'), { recursive: true });
  fs.writeFileSync(path.join(source, 'domain-packs/review/README.md'), 'Public bridge only.');
  const bytes = createArchive(source);
  assert.equal(
    decodeArchive(bytes).files.some(file => file.path.includes('private-method')),
    false,
  );
  await manager.install(entry(bytes), { bytes, allowUnsigned: true });
  const session = path.join(directory, 'session');
  assert.throws(
    () => materializeInstalledSkills({ skills: ['review-fixture.inspect'] }, session, {}),
    /absolute directory/,
  );
  const skills = materializeInstalledSkills({ skills: ['review-fixture.inspect'] }, session, {
    REVIEW_FIXTURE_SOURCE: external,
  });
  assert.equal(
    fs.readFileSync(path.join(skills, 'review-fixture.inspect/assets/report-template.md'), 'utf8'),
    fs.readFileSync(path.join(external, 'skills/private-method/assets/report-template.md'), 'utf8'),
  );
  assert.match(
    fs.readFileSync(path.join(skills, 'review-fixture.inspect/SKILL.md'), 'utf8'),
    /Industrial Harness integration/,
  );
  fs.writeFileSync(path.join(external, 'skills/private-method/references/criteria.md'), 'changed');
  assert.throws(
    () =>
      materializeInstalledSkills({ skills: ['review-fixture.inspect'] }, session, {
        REVIEW_FIXTURE_SOURCE: external,
      }),
    /differs/,
  );
  assert.ok(fs.existsSync(path.join(skills, 'review-fixture.inspect/assets/report-template.md')));
});

test('legacy coreApi 1 installations stay readable and receive integrity receipts on reinstall', async t => {
  const { manager } = setup(t);
  const bytes = createArchive(example);
  await manager.install(entry(bytes), { bytes, allowUnsigned: true });
  const location = manager.list()[0].location;
  fs.unlinkSync(path.join(location, '.hpack-integrity.json'));
  assert.equal(manager.list()[0].version, '1.0.0');
  await manager.install(entry(bytes), { bytes, allowUnsigned: true });
  assert.ok(fs.existsSync(path.join(location, '.hpack-integrity.json')));
});

test('public built-in Pack releases retain owned resources and keep the public PCB Runtime independent of private resources', t => {
  const { directory } = setup(t);
  const output = path.join(directory, 'built-in');
  const environment = {
    ...process.env,
    HARNESS_PACK_PLATFORMS: `${process.platform}-${process.arch},darwin-arm64`,
  };
  delete environment.HARNESS_PACK_DOMAINS;
  delete environment.HARNESS_PACK_SIGNING_KEY_FILE;
  delete environment.HARNESS_PACK_SIGNING_KEY_ID;
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/build-pack-distribution.cjs'), output],
    { encoding: 'utf8', env: environment, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(fs.readFileSync(path.join(output, 'catalog.unsigned.json')));
  assert.deepEqual(catalog.packs.map(pack => pack.domain).sort(), ['cad', 'chip', 'godot', 'pcb']);
  for (const item of catalog.packs) {
    const bytes = fs.readFileSync(path.join(output, item.url));
    assert.equal(digest(bytes), item.sha256);
    const { bundle, files } = decodeArchive(bytes);
    assert.ok(files.some(file => file.path === 'LICENSE'));
    assert.ok(files.some(file => file.path === 'THIRD_PARTY_NOTICES.md'));
    if (item.domain === 'cad')
      assert.ok(files.some(file => file.path === 'skills/cad.ezdxf.author/scripts/dxf_diff.py'));
    if (item.domain === 'pcb') {
      const skill = bundle.skills.find(skill => skill.id === 'pcb.design.e2e');
      assert.equal(skill.external, undefined);
      assert.ok(files.some(file => file.path === 'domain-packs/pcb/runtime/index.cjs'));
      assert.ok(files.some(file => file.path === 'domain-packs/pcb/runtime/verifier.cjs'));
      // The vendored PCB-bench surface ships with the pack: skill references
      // and assets, the actor sources, the pinned snapshot and the gateway.
      assert.ok(
        files.some(file => file.path === 'skills/pcb.design.e2e/references/tools.md') ||
          files.some(file => file.path === 'skills/pcb-design-e2e/references/tools.md'),
      );
      assert.ok(
        files.some(
          file =>
            file.path === 'skills/pcb.design.e2e/assets/constraints.example.yaml' ||
            file.path === 'skills/pcb-design-e2e/assets/constraints.example.yaml',
        ),
      );
      assert.ok(
        files.some(file => file.path.startsWith('domain-packs/pcb/pcb-agent/tools/')),
      );
      assert.ok(
        files.some(file => file.path === 'domain-packs/pcb/pcb-agent/tools/workspace.py'),
      );
      assert.ok(
        files.some(file => file.path === 'domain-packs/pcb/runtime/bench-upstream.json'),
      );
      assert.ok(
        files.some(file => file.path === 'domain-packs/pcb/runtime/bench-gateway.cjs'),
      );
      assert.ok(
        files.some(file => file.path === 'skills/pcb.kicad.native/SKILL.md') ||
          files.some(
            file => file.path === 'skills/pcb-kicad-native/SKILL.md',
          ),
      );
    }
    if (item.domain === 'chip')
      assert.ok(files.some(file => file.path === 'domain-packs/chip/runtime/index.cjs'));
  }
});
