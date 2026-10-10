const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resourceDirectory } = require('./pack-resources.cjs');
const { domainPacks } = require('./index.cjs');

test('public PCB Runtime declarations replace private actor writes with hash-pinned native resources', () => {
  const pack = domainPacks.find(pack => pack.domain === 'pcb');
  assert.equal(pack.provider.transport, 'runtime');
  const ids = pack.provider.tools.map(tool => tool.id);
  // The bounded native profile stays first; the declared PCB-bench surface
  // (vendored actor + container gateway dispatch) follows.
  assert.deepEqual(ids.slice(0, 2), ['pcb.kicad.edit', 'pcb.kicad.verify']);
  assert.equal(ids.length, 91);
  assert.ok(ids.slice(2).every(id => id.startsWith('pcb.bench.')));
  assert.equal(pack.runtime.entry, 'runtime/index.cjs');
  assert.ok(pack.provider.sourceFiles['runtime/verifier.cjs']);
  assert.ok(pack.provider.sourceFiles['runtime/native.py']);
  assert.ok(pack.provider.sourceFiles['runtime/bench-upstream.json']);
  assert.ok(pack.provider.sourceFiles['runtime/bench-gateway.cjs']);
  // The vendored actor is pinned by the bench snapshot, not by the runtime
  // inventory; the manifest keeps its own resource roots.
  assert.ok(!Object.keys(pack.provider.sourceFiles).some(name => name.startsWith('pcb-agent/')));
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
