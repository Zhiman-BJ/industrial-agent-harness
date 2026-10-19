#!/usr/bin/env node
// Resolve local acceptance inputs without embedding a developer's workspace.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../../..');
const resolveFromRepository = value => path.resolve(repositoryRoot, value);

function sha256(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, count));
    return digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifySources(fixtures) {
  for (const fixture of fixtures) {
    const stat = fs.statSync(fixture.path);
    assert.ok(stat.isFile(), `${fixture.name}: expected a regular layout file`);
    assert.equal(
      stat.size,
      fixture.bytes,
      `${fixture.name}: source byte count differs from manifest`,
    );
    assert.equal(
      sha256(fixture.path),
      fixture.sha256,
      `${fixture.name}: source SHA-256 differs from manifest`,
    );
  }
}

function loadLayoutInputs({ env = process.env, manifestPath } = {}) {
  const manifestFile = resolveFromRepository(
    manifestPath ||
      env.LAYOUT_ACCEPTANCE_MANIFEST ||
      'doc/evidence/layout-p0-20261019/real-layouts.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.ok(
    Array.isArray(manifest.fixtures) && manifest.fixtures.length,
    'Manifest needs fixtures',
  );
  const fixtures = manifest.fixtures.map(fixture => {
    assert.ok(typeof fixture.name === 'string' && fixture.name, 'Fixture needs a name');
    assert.ok(
      typeof fixture.path === 'string' && fixture.path,
      `${fixture.name}: fixture needs a path`,
    );
    assert.ok(/^[a-f0-9]{64}$/.test(fixture.sha256), `${fixture.name}: expected a SHA-256`);
    assert.ok(
      Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0,
      `${fixture.name}: expected source bytes`,
    );
    assert.ok(
      !fixture.pathEnv || fixture.pathEnv === 'LAYOUT_FIFO_FILE',
      `${fixture.name}: unsupported pathEnv`,
    );
    const fifo = fixture.name === 'sync-fifo-real' || fixture.pathEnv === 'LAYOUT_FIFO_FILE';
    const file = resolveFromRepository(
      fifo && env.LAYOUT_FIFO_FILE ? env.LAYOUT_FIFO_FILE : fixture.path,
    );
    if (!fs.existsSync(file)) {
      throw Error(
        fifo
          ? 'FIFO fixture is not bundled. Set LAYOUT_FIFO_FILE to the file matching the manifest SHA-256.'
          : `${fixture.name}: source file is unavailable; supply LAYOUT_ACCEPTANCE_MANIFEST with matching input paths.`,
      );
    }
    const relative = path.relative(repositoryRoot, file);
    const withinRepository =
      relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const sourceRef = fifo
      ? 'external-fixtures/sync_fifo.gds'
      : withinRepository
        ? relative.split(path.sep).join('/')
        : `external-fixtures/${path.basename(file)}`;
    return { ...fixture, path: file, sourceRef };
  });
  verifySources(fixtures);
  return { ...manifest, fixtures };
}

module.exports = { loadLayoutInputs, verifySources, repositoryRoot };

if (require.main === module) {
  try {
    const manifest = loadLayoutInputs();
    const output = process.argv.includes('--json')
      ? manifest
      : {
          status: 'source-hashes-verified',
          fixtures: manifest.fixtures.map(({ name, sourceRef, bytes, sha256 }) => ({
            name,
            sourceRef,
            bytes,
            sha256,
          })),
        };
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
