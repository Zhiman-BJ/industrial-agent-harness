const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectPlatformProbe } = require('../../scripts/platform-probe-input.cjs');

test('publisher accepts only the exact committed owner sources and intact platform bytes', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-publisher-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceCommit = 'a'.repeat(40);
  const sourceFiles = { 'mcp/environment-probe/main.go': 'b'.repeat(64) };
  const bytes = Buffer.from('test platform component');
  const component = {
    id: 'environment-probe',
    platform: 'darwin-arm64',
    file: 'darwin-arm64/industrial-environment-probe',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  fs.mkdirSync(path.join(base, 'darwin-arm64'));
  fs.writeFileSync(path.join(base, component.file), bytes);
  fs.writeFileSync(path.join(base, 'content-lock.json'), JSON.stringify({ files: sourceFiles }));
  const owner = { root: base, verifyIntegrity() {} };
  const indexFile = path.join(base, 'index.json');
  const index = {
    schemaVersion: 2,
    kind: 'platform-components',
    sourceCommit,
    sourceState: 'committed',
    sourceFiles,
    components: [component],
  };
  const check = value => {
    fs.writeFileSync(indexFile, JSON.stringify(value));
    return inspectPlatformProbe(indexFile, { owner, sourceCommit });
  };
  assert.equal(check(index).get('darwin-arm64').sha256, component.sha256);
  assert.throws(() => check({ ...index, sourceState: 'working-tree' }), /pinned committed/);
  assert.throws(() => check({ ...index, sourceCommit: 'c'.repeat(40) }), /pinned committed/);
  assert.throws(() => check({ ...index, sourceFiles: {} }), /sources do not match/);
  assert.throws(
    () => check({ ...index, components: [{ ...component, file: '../escape' }] }),
    /Invalid platform/,
  );
  fs.writeFileSync(path.join(base, component.file), 'tampered');
  assert.throws(() => check(index), /bytes differ/);
  fs.rmSync(path.join(base, component.file));
  fs.symlinkSync('../content-lock.json', path.join(base, component.file));
  assert.throws(() => check(index), /symlinks/);
});
