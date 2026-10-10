const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resourceDirectory } = require('./pack-resources.cjs');
const { domainPacks } = require('./index.cjs');

test('public PCB Runtime declarations vendor the bench actor and bench tools with hash-pinned resources', () => {
  const pack = domainPacks.find(pack => pack.domain === 'pcb');
  assert.equal(pack.provider.transport, 'runtime');
  const tools = pack.provider.tools.map(tool => tool.id);
  assert.ok(tools.includes('pcb.kicad.edit'));
  assert.ok(tools.includes('pcb.kicad.verify'));
  // The 89 pcb.bench.* tools from the aligned bench surface ship in-pack.
  assert.equal(tools.filter(id => id.startsWith('pcb.bench.')).length, 89);
  assert.equal(pack.runtime.entry, 'runtime/index.cjs');
  assert.ok(pack.provider.sourceFiles['runtime/verifier.cjs']);
  assert.ok(pack.provider.sourceFiles['runtime/native.py']);
  // The gateway and its upstream snapshot declare the vendored bench actor
  // (101 sources, per-file hashes) that the gateway verifies at load time.
  assert.ok(pack.provider.sourceFiles['runtime/bench-gateway.cjs']);
  assert.ok(pack.provider.sourceFiles['runtime/bench-upstream.json']);
});

test('external resources reject changed, missing, extra or symlinked files before a session can load them', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-resources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contents = {
    'pcb-agent/tools/runtime.py': 'fixture source',
    'skills/pcb-design-e2e/SKILL.md': 'fixture skill',
    'skills/pcb-design-e2e/references/tools.md': 'fixture reference',
  };
  const sourceFiles = {};
  for (const [file, content] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
    sourceFiles[file] = crypto.createHash('sha256').update(content).digest('hex');
  }
  const provider = {
    title: 'Fixture',
    directoryEnv: 'FIXTURE_ROOT',
    resourceRoots: ['pcb-agent', 'skills/pcb-design-e2e'],
    sourceFiles,
    sourceSha256: crypto.createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
  };
  assert.equal(
    resourceDirectory(provider, { FIXTURE_ROOT: directory }),
    fs.realpathSync(directory),
  );
  assert.throws(() => resourceDirectory(provider, {}), /absolute directory/);
  const target = path.join(directory, 'skills/pcb-design-e2e/references/tools.md');
  fs.writeFileSync(target, 'changed');
  assert.throws(() => resourceDirectory(provider, { FIXTURE_ROOT: directory }), /differs/);
  fs.writeFileSync(target, contents['skills/pcb-design-e2e/references/tools.md']);
  const extra = path.join(directory, 'pcb-agent/tools/extra.py');
  fs.writeFileSync(extra, 'unexpected imported module');
  assert.throws(() => resourceDirectory(provider, { FIXTURE_ROOT: directory }), /inventory/);
  fs.unlinkSync(extra);
  fs.unlinkSync(target);
  assert.throws(() => resourceDirectory(provider, { FIXTURE_ROOT: directory }), /inventory/);
  fs.symlinkSync(path.join(directory, 'pcb-agent/tools/runtime.py'), target);
  assert.throws(() => resourceDirectory(provider, { FIXTURE_ROOT: directory }), /symlinks/);
});
