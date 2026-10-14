const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PackManager, createArchive, digest, signCatalog } = require('./index.cjs');
const { writeOciFixture, dockerFixture } = require('./container-image-fixture.cjs');
const { runDomains } = require('../../../apps/cli/src/domains.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-container-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = await writeOciFixture(path.join(root, 'image.tar'));
  const docker = dockerFixture(image);
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'provenance'), { recursive: true });
  const bundle = {
    schemaVersion: 1,
    domain: 'review',
    version: '1.0.0',
    coreApi: 1,
    label: 'Review',
    emoji: '',
    capabilities: [],
    skills: [],
    providerPacks: [],
    containerImages: ['review-image'],
  };
  const build = version => {
    bundle.version = version;
    fs.writeFileSync(path.join(source, 'bundle.json'), JSON.stringify(bundle));
    fs.writeFileSync(
      path.join(source, 'provenance/runtime-distribution.json'),
      JSON.stringify(image.lock),
    );
    return createArchive(source);
  };
  let archive = build('1.0.0');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = { release: publicKey.export({ type: 'spki', format: 'pem' }) };
  const keyFile = path.join(root, 'keys.json');
  fs.writeFileSync(keyFile, JSON.stringify(keys));
  const store = path.join(root, 'store');
  const manager = new PackManager({
    directory: store,
    keys,
    containerOptions: { command: docker.command },
  });
  const previous = {
    fetch: global.fetch,
    store: process.env.INDUSTRIAL_HARNESS_PACK_STORE,
    override: process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION,
  };
  global.fetch = async url => {
    if (url.endsWith('/catalog.json')) {
      const entry = {
        domain: bundle.domain,
        version: bundle.version,
        label: bundle.label,
        sha256: digest(archive),
        size: archive.length,
        containerDownloadSize: image.bytes,
        url: 'review.hpack',
        platforms: [`${process.platform}-${process.arch}`],
      };
      return new Response(
        JSON.stringify(
          signCatalog(
            { schemaVersion: 1, channel: 'stable', packs: [entry] },
            'release',
            privateKey,
          ),
        ),
      );
    }
    if (url.endsWith('.hpack')) return new Response(archive);
    return { ok: true, status: 200, body: fs.createReadStream(image.file) };
  };
  t.after(() => {
    global.fetch = previous.fetch;
    for (const [key, value] of [
      ['INDUSTRIAL_HARNESS_PACK_STORE', previous.store],
      ['INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION', previous.override],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const selected = async () =>
    (await manager.catalog('https://feed.example/catalog.json')).packs[0];
  return {
    ...image,
    root,
    source,
    manager,
    docker,
    store,
    keyFile,
    selected,
    bundle,
    update(version) {
      archive = build(version);
    },
  };
}

test('signed Pack installation prepares the authenticated images before activation; repair ignores discovery overrides', async t => {
  const f = await fixture(t);
  process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION = path.join(f.root, 'untrusted-lock.json');
  fs.writeFileSync(process.env.INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION, '{}');
  const installed = await f.manager.install(await f.selected(), { prepareRuntime: true });
  assert.equal(installed.domain, 'review');
  assert.deepEqual(f.manager.scan().errors, []);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(installed.location, 'provenance/runtime-distribution.json')),
    ).images[0].current.configDigest,
    f.configDigest,
  );
  await f.manager.prepareRuntime(installed, { recheck: true });
  assert.equal(f.docker.calls.filter(args => args[0] === 'load').length, 1);
  fs.writeFileSync(path.join(installed.location, 'provenance/runtime-distribution.json'), '{}');
  await assert.rejects(f.manager.prepareRuntime(installed), /resource changed/);
});

test('image failure and cancellation preserve the installed Pack version and leave no staging', async t => {
  const f = await fixture(t);
  await f.manager.install(await f.selected(), { prepareRuntime: true });
  f.update('1.1.0');
  f.manager.containerImages.command = dockerFixture(f, { failAt: 'load' }).command;
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker failure/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
  assert.ok(
    fs.readdirSync(f.manager.containerImages.directory).every(name => name.endsWith('.json')),
  );
  const abort = new AbortController();
  f.manager.containerImages.command = dockerFixture(f).command;
  await assert.rejects(
    f.manager.install(await f.selected(), {
      prepareRuntime: true,
      signal: abort.signal,
      onProgress: p => {
        if (p.phase === 'downloading' && p.received === p.total) abort.abort(Error('cancelled'));
      },
    }),
    /cancelled/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
});

test('image declarations without their signed lock or from another domain cannot be bundled', async t => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.source, 'provenance/runtime-distribution.json'));
  assert.throws(() => createArchive(f.source), /distribution lock inside/);
  f.lock.images[0].pack = 'another';
  fs.writeFileSync(
    path.join(f.source, 'provenance/runtime-distribution.json'),
    JSON.stringify(f.lock),
  );
  assert.throws(() => createArchive(f.source), /another Domain/);
});

test('missing Docker prevents first activation and preserves the installed version during update', async t => {
  const f = await fixture(t);
  const available = f.manager.containerImages.command;
  f.manager.containerImages.command = require('./runtime-assets.cjs').run;
  f.manager.containerImages.docker = path.join(f.root, 'missing-docker');
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker was not found/,
  );
  assert.deepEqual(f.manager.list(), []);
  assert.equal(fs.existsSync(f.manager.containerImages.directory), false);
  f.manager.containerImages.command = available;
  await f.manager.install(await f.selected(), { prepareRuntime: true });
  f.update('1.1.0');
  f.manager.containerImages.command = require('./runtime-assets.cjs').run;
  await assert.rejects(
    f.manager.install(await f.selected(), { prepareRuntime: true }),
    /Docker was not found/,
  );
  assert.equal(f.manager.list()[0].version, '1.0.0');
  assert.ok(
    fs.readdirSync(f.manager.containerImages.directory).every(name => name.endsWith('.json')),
  );
});

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
