const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PackManager, createArchive, digest, signCatalog } = require('./index.cjs');
const { writeOciFixture, dockerFixture } = require('./container-image-fixture.cjs');

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

module.exports = { fixture };
