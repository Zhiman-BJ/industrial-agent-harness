const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PackManager } = require('@industrial-agent-harness/pack-manager');
const { dockerFixture } = require('../../../packages/pack-manager/src/container-image-fixture.cjs');
const { fixture } = require('../../../packages/pack-manager/src/container-install-fixture.cjs');
const { runDomains } = require('../src/domains.cjs');

test('CLI install and repair both execute shared image preparation, and errors reach the installation journal', async t => {
  const f = await fixture(t);
  // Inject only the external Docker command boundary. Feed verification, archive
  // bytes, OCI validation, image preparation, activation and repair are real code.
  const original = PackManager.prototype.prepareRuntime;
  PackManager.prototype.prepareRuntime = function (...args) {
    this.containerImages.command = f.manager.containerImages.command;
    return original.apply(this, args);
  };
  t.after(() => {
    PackManager.prototype.prepareRuntime = original;
  });
  let text = '';
  const output = {
    write: value => {
      text += value;
    },
  };
  await runDomains(
    [
      'install',
      'review',
      '--catalog',
      'https://feed.example/catalog.json',
      '--keys-file',
      f.keyFile,
      '--store',
      f.store,
    ],
    output,
  );
  await runDomains(['repair', 'review', '--store', f.store], output);
  assert.ok(text.includes('"repaired":"review"'));
  assert.equal(f.docker.calls.filter(args => args[0] === 'load').length, 1);
  f.manager.containerImages.command = dockerFixture(f, { failAt: 'load' }).command;
  await assert.rejects(
    runDomains(['repair', 'review', '--store', f.store], output),
    /Docker failure/,
  );
  const journal = JSON.parse(fs.readFileSync(path.join(f.store, '.installation-operation.json')));
  assert.equal(journal.outcome, 'failed');
  assert.equal(journal.active, false);
  assert.equal(f.manager.list()[0].version, '1.0.0');
});
