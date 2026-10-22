const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  sourceDeclarations,
  fetchVendorSources,
  verifyVendorArchive,
} = require('../../scripts/fetch-vendor-sources.cjs');

const repository = path.resolve(__dirname, '../..');

test('vendor source declarations pin immutable GitHub release assets for every declared archive', () => {
  const declarations = sourceDeclarations();
  assert.equal(declarations.length, 2, 'both occt-import source archives stay declared');
  for (const archive of declarations) {
    const url = new URL(archive.url);
    assert.equal(url.host, 'github.com');
    assert.match(
      url.pathname,
      /^\/Zhiman-BJ\/industrial-agent-harness\/releases\/download\/[^/]+\/[^/]+$/,
    );
    assert.equal(path.basename(url.pathname), archive.file);
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0);
    assert.ok(
      !fs.existsSync(path.join(repository, path.dirname(archive.manifest), 'source')),
      'the corresponding-source archives must not return to the repository tree',
    );
  }
});

test('downloads stream to disk, verify exactly and leave no partials', async t => {
  const payloads = new Map(
    sourceDeclarations().map(archive => {
      const bytes = crypto.randomBytes(4096);
      return [archive.file, bytes];
    }),
  );
  const shadow = sourceDeclarations().map(archive => {
    const bytes = payloads.get(archive.file);
    return {
      ...archive,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-sources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = url => {
    const bytes = payloads.get(path.basename(new URL(url).pathname));
    return bytes ? Promise.resolve(new Response(bytes)) : Promise.reject(Error('unexpected url'));
  };
  const results = await fetchVendorSources({ directory, fetchImpl, declarations: shadow });
  assert.equal(results.length, 2);
  for (const archive of results) {
    assert.equal(archive.state, 'ready');
    assert.equal(await verifyVendorArchive(archive, path.join(directory, archive.file)), 'ready');
    assert.equal(
      fs.readFileSync(path.join(directory, archive.file)).equals(payloads.get(archive.file)),
      true,
    );
  }
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name.endsWith('.partial')),
    [],
    'no partial downloads remain',
  );
});

test('a corrupted existing archive fails closed instead of re-downloading', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-sources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const [first] = sourceDeclarations();
  fs.writeFileSync(path.join(directory, first.file), 'tampered');
  await assert.rejects(
    fetchVendorSources({
      directory,
      fetchImpl: () => Promise.reject(Error('must not re-download a mismatching file')),
    }),
    /mismatch/,
  );
});
