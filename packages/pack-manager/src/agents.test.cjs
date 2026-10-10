const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  PackManager,
  createArchive,
  decodeArchive,
  digest,
  validateBundle,
  readAgentInstructions,
} = require('./index.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-agent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(source, 'skills/review.inspect'), { recursive: true });
  const instructions = '# Review Agent\nInspect the supplied evidence.\n';
  const agent = {
    id: 'review.inspector',
    title: 'Review inspector',
    description: 'Review supplied evidence.',
    domain: 'review',
    packId: 'review-pack',
    file: 'agents/review.inspector.md',
    sha256: digest(Buffer.from(instructions)),
    skills: ['review.inspect'],
    tools: ['Read'],
    disallowedTools: ['Bash'],
    subagents: ['builtin:explore'],
  };
  const bundle = {
    schemaVersion: 1,
    coreApi: 1,
    domain: 'review',
    version: '1.0.0',
    label: 'Review',
    emoji: '🧪',
    capabilities: [],
    providerPacks: [],
    agents: [agent],
    skills: [
      {
        id: 'review.inspect',
        domain: 'review',
        title: 'Inspect',
        file: 'skills/review.inspect/SKILL.md',
      },
    ],
  };
  fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
  fs.writeFileSync(path.join(source, agent.file), instructions);
  fs.writeFileSync(path.join(source, bundle.skills[0].file), '# Inspect\n');
  return { directory, source, instructions, agent, bundle };
}

test('optional Agent declarations remain compatible with legacy bundles and preserve role configuration', t => {
  const { source, instructions, bundle } = fixture(t);
  const { agents, ...legacy } = bundle;
  assert.equal(validateBundle(legacy), legacy);
  const decoded = decodeArchive(createArchive(source));
  assert.deepEqual(decoded.bundle.agents, agents);
  assert.equal(readAgentInstructions(source, agents[0]), instructions);
  for (const change of [
    value => {
      value.agents = {};
    },
    value => {
      value.agents.push(value.agents[0]);
    },
    value => {
      value.agents[0].domain = 'another';
    },
    value => {
      value.agents[0].id = 'builtin:explore';
    },
    value => {
      value.agents[0].file = '../outside.md';
    },
    value => {
      value.agents[0].file = 'skills/review.inspect/SKILL.md';
    },
    value => {
      value.agents[0].sha256 = 'bad';
    },
    value => {
      value.agents[0].skills = ['missing.skill'];
    },
    value => {
      value.agents[0].tools = ['Read', 'Read'];
    },
    value => {
      value.agents[0].model = 'undeclared';
    },
  ]) {
    const invalid = structuredClone(bundle);
    change(invalid);
    assert.throws(() => validateBundle(invalid));
  }
});

test('Agent archives reject missing files, hash substitution, oversized and empty instructions', t => {
  const { source, agent } = fixture(t);
  const archive = JSON.parse(zlib.gunzipSync(createArchive(source)));
  const missing = structuredClone(archive);
  missing.files = missing.files.filter(file => file.path !== agent.file);
  assert.throws(
    () => decodeArchive(zlib.gzipSync(JSON.stringify(missing))),
    /Missing Domain Agent/,
  );
  for (const replacement of [Buffer.from('# Changed'), Buffer.alloc(128 * 1024 + 1, 'a')]) {
    const modified = structuredClone(archive);
    const resource = modified.files.find(file => file.path === agent.file);
    resource.data = replacement.toString('base64');
    resource.sha256 = digest(replacement);
    assert.throws(
      () => decodeArchive(zlib.gzipSync(JSON.stringify(modified))),
      /integrity verification/,
    );
  }
  for (const replacement of [Buffer.from(' \n'), Buffer.from([0xff]), Buffer.alloc(32769, 'a')]) {
    const modified = structuredClone(archive);
    const resource = modified.files.find(file => file.path === agent.file);
    resource.data = replacement.toString('base64');
    resource.sha256 = digest(replacement);
    const manifest = modified.files.find(file => file.path === 'bundle.json');
    const bundle = JSON.parse(Buffer.from(manifest.data, 'base64'));
    bundle.agents[0].sha256 = resource.sha256;
    const bytes = Buffer.from(JSON.stringify(bundle));
    manifest.data = bytes.toString('base64');
    manifest.sha256 = digest(bytes);
    assert.throws(() => decodeArchive(zlib.gzipSync(JSON.stringify(modified))));
  }
});

test('installed Agent resource corruption and symlinks cannot be disclosed, including legacy receipts', async t => {
  const { source, directory, agent, instructions } = fixture(t);
  const bytes = createArchive(source);
  const manager = new PackManager({ directory: path.join(directory, 'store') });
  const entry = { domain: 'review', version: '1.0.0', size: bytes.length, sha256: digest(bytes) };
  const installed = await manager.install(entry, { bytes, allowUnsigned: true });
  assert.equal(readAgentInstructions(installed.location, agent), instructions);
  fs.unlinkSync(path.join(installed.location, '.hpack-integrity.json'));
  const file = path.join(installed.location, agent.file);
  fs.writeFileSync(file, '# Changed');
  assert.equal(manager.list().length, 0);
  assert.match(manager.scan().errors[0].message, /integrity verification/);
  await manager.install(entry, { bytes, allowUnsigned: true });
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(source, agent.file), file);
  assert.equal(manager.list().length, 0);
  assert.match(manager.scan().errors[0].message, /symlinks/);
  assert.throws(() => readAgentInstructions(installed.location, agent), /symlinks/);
});
