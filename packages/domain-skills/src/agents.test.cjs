const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const owner = require('@zhiman-bj/industrial-domain-packs');
const { PackManager, createArchive, digest } = require('../../pack-manager/src/index.cjs');
const { PackCatalog } = require('../../pack-manager/src/catalog.cjs');
const { loadRegistry } = require('./installed.cjs');

function environment(t, store) {
  const previous = process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  if (store === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
  else process.env.INDUSTRIAL_HARNESS_PACK_STORE = store;
  t.after(() => {
    if (previous === undefined) delete process.env.INDUSTRIAL_HARNESS_PACK_STORE;
    else process.env.INDUSTRIAL_HARNESS_PACK_STORE = previous;
  });
}

test('built-in roles come from the pinned owner resources with immutable source identity', t => {
  environment(t);
  const registry = loadRegistry();
  const declarations = owner.consumerMetadata().agents;
  assert.ok(declarations.length);
  assert.equal(registry.agents.length, declarations.length);
  for (const role of registry.agents) {
    const resource = owner.agentResource(role.id);
    assert.equal(role.source, 'pack');
    assert.equal(role.packId, resource.packId);
    assert.equal(role.name, resource.title);
    assert.equal(role.instructions, resource.instructions);
    assert.deepEqual(role.skills, resource.skills);
    assert.equal(
      role.packVersion,
      `${owner.identity.packageVersion}+${owner.identity.contentSha256}`,
    );
    assert.equal(role.file, undefined);
  }
});

test('installed Agent instructions and policy load through PackManager; absent or removed roles do not fall back to built-ins', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-agents-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = path.join(directory, 'store');
  environment(t, store);
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  const instructions = '# Inspector\nRead the provided report.\n';
  const agent = {
    id: 'review.inspector',
    title: 'Inspector',
    description: 'Review evidence.',
    domain: 'review',
    packId: 'review-pack',
    file: 'agents/inspector.md',
    sha256: digest(Buffer.from(instructions)),
    skills: [],
    tools: ['Read'],
    subagents: [],
  };
  const bundle = {
    schemaVersion: 1,
    coreApi: 1,
    domain: 'review',
    version: '1.0.0',
    label: 'Review',
    emoji: '🧪',
    capabilities: [],
    skills: [],
    providerPacks: [],
    agents: [agent],
    sourceRelease: { packageVersion: '1.2.3', contentSha256: 'a'.repeat(64) },
  };
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  fs.writeFileSync(path.join(source, agent.file), instructions);
  const bytes = createArchive(source);
  const manager = new PackManager({ directory: store });
  assert.deepEqual(loadRegistry().agents, []);
  const installed = await manager.install(
    {
      domain: 'review',
      version: bundle.version,
      size: bytes.length,
      sha256: digest(bytes),
    },
    { bytes, allowUnsigned: true },
  );
  const [role] = loadRegistry().agents;
  assert.equal(role.instructions, instructions);
  assert.equal(role.name, 'Inspector');
  assert.equal(role.source, 'pack');
  assert.equal(role.packId, 'review-pack');
  assert.equal(role.packVersion, `1.2.3+${'a'.repeat(64)}`);
  assert.deepEqual(role.skills, []);
  assert.deepEqual(role.tools, ['Read']);
  assert.deepEqual(role.subagents, []);
  fs.writeFileSync(path.join(installed.location, agent.file), '# Modified');
  assert.deepEqual(loadRegistry().agents, []);
  assert.equal(manager.scan().errors.length, 1);
  manager.remove('review');
  assert.deepEqual(loadRegistry().agents, []);

  delete bundle.agents;
  bundle.version = '1.1.0';
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  const legacy = createArchive(source);
  await manager.install(
    { domain: 'review', version: bundle.version, size: legacy.length, sha256: digest(legacy) },
    { bytes: legacy, allowUnsigned: true },
  );
  assert.equal(loadRegistry().domains.length, 1);
  assert.deepEqual(loadRegistry().agents, []);

  bundle.version = '1.2.0';
  bundle.agents = [agent];
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  const upgraded = createArchive(source);
  const available = {
    domain: 'review',
    version: bundle.version,
    size: upgraded.length,
    sha256: digest(upgraded),
  };
  const catalog = new PackCatalog({ directory: store });
  assert.equal(catalog.summaries([available])[0].updateAvailable, true);
  await manager.install(available, { bytes: upgraded, allowUnsigned: true });
  assert.equal(catalog.summaries([available])[0].updateAvailable, false);
  assert.equal(loadRegistry().agents[0].id, agent.id);
  assert.equal(loadRegistry().agents[0].instructions, instructions);
});
