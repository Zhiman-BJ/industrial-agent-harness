const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { publishFeed } = require('../../scripts/publish-desktop-feed.cjs');
const { createArchive, digest, signCatalog } = require('../../packages/pack-manager/src/index.cjs');
const { PackCatalog } = require('../../packages/pack-manager/src/catalog.cjs');
const { CoreUpdater } = require('../../apps/desktop/electron/updater.cjs');

const root = path.resolve(__dirname, '../..');
function fixture(t, channel = 'beta') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-feed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = { release: publicKey.export({ type: 'spki', format: 'pem' }) };
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const options = { directory, channel, keys, sha: '1234567' };
  function build(version) {
    fs.writeFileSync(
      path.join(source, 'bundle.json'),
      JSON.stringify({
        schemaVersion: 1,
        domain: 'review',
        version,
        coreApi: 1,
        label: 'Review',
        emoji: 'R',
        capabilities: [],
        skills: [],
        providerPacks: [],
      }),
    );
    const bytes = createArchive(source);
    const url = `review-${version}.hpack`;
    fs.writeFileSync(path.join(directory, url), bytes);
    const envelope = signCatalog(
      {
        schemaVersion: 1,
        channel,
        packs: [
          {
            domain: 'review',
            version,
            size: bytes.length,
            sha256: digest(bytes),
            url,
            platforms: [`${process.platform}-${process.arch}`],
          },
        ],
      },
      'release',
      privateKey,
    );
    fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(envelope));
    return envelope;
  }
  build('1.0.0');
  for (const name of [
    'app.exe',
    'app.dmg',
    'app.zip',
    'app.exe.blockmap',
    'beta.yml',
    'beta-mac.yml',
    'latest.yml',
    'latest-mac.yml',
    'builder-debug.yml',
  ])
    fs.writeFileSync(path.join(directory, name), `new ${name}`);
  const assets = new Map();
  const calls = [];
  let exists = false;
  function gh(args) {
    calls.push(args);
    if (args[1] === 'view') return exists;
    if (args[1] === 'create') exists = true;
    if (args[1] === 'upload') {
      assert.ok(exists);
      assets.set(path.basename(args[3]), fs.readFileSync(args[3]));
    }
    return true;
  }
  return { directory, options, keys, build, gh, assets, calls };
}

for (const channel of ['beta', 'stable']) {
  for (const [macSigning, winSigning] of [
    ['unsigned', 'unsigned'],
    ['signed', 'unsigned'],
    ['unsigned', 'signed'],
    [undefined, undefined],
    ['signed', 'signed'],
  ]) {
    test(`${channel} feed: mac=${macSigning}, win=${winSigning} publishes Packs independently`, t => {
      const setup = fixture(t, channel);
      const oldCore = Buffer.from('previous signed Core');
      setup.assets.set('beta.yml', oldCore);
      const result = publishFeed({ ...setup.options, macSigning, winSigning }, setup.gh);
      assert.equal(result.tag, `desktop-${channel}-feed`);
      assert.ok(setup.assets.has('catalog.json'));
      assert.ok(setup.assets.has('review-1.0.0.hpack'));
      const uploaded = setup.calls
        .filter(args => args[1] === 'upload')
        .map(args => path.basename(args[3]));
      assert.deepEqual(uploaded.slice(0, 2), ['review-1.0.0.hpack', 'catalog.json']);
      if (macSigning === 'signed' && winSigning === 'signed') {
        assert.equal(result.corePublished, true);
        assert.ok(uploaded.includes('app.exe'));
        assert.ok(uploaded.includes('app.dmg'));
        const manifest = channel === 'beta' ? 'beta' : 'latest';
        const other = channel === 'beta' ? 'latest' : 'beta';
        assert.ok(uploaded.indexOf('app.zip') < uploaded.indexOf(`${manifest}.yml`));
        assert.ok(uploaded.includes(`${manifest}-mac.yml`));
        assert.ok(!uploaded.includes(`${other}.yml`));
        assert.ok(!uploaded.includes('builder-debug.yml'));
      } else {
        assert.equal(result.corePublished, false);
        assert.deepEqual(uploaded, ['review-1.0.0.hpack', 'catalog.json']);
        assert.deepEqual(setup.assets.get('beta.yml'), oldCore);
      }
    });
  }
}

test('invalid signatures, channels, missing archives and corrupt bytes fail before publishing', t => {
  for (const change of ['signature', 'channel', 'missing', 'corrupt']) {
    const setup = fixture(t);
    const file = path.join(setup.directory, 'catalog.json');
    if (change === 'signature') {
      const envelope = JSON.parse(fs.readFileSync(file));
      envelope.signature = 'invalid';
      fs.writeFileSync(file, JSON.stringify(envelope));
    } else if (change === 'channel') setup.options.channel = 'stable';
    else if (change === 'missing') fs.rmSync(path.join(setup.directory, 'review-1.0.0.hpack'));
    else fs.appendFileSync(path.join(setup.directory, 'review-1.0.0.hpack'), 'corrupt');
    assert.throws(() => publishFeed(setup.options, setup.gh));
    assert.deepEqual(setup.calls, []);
  }
});

test('a failed archive upload cannot replace the existing catalog', t => {
  const setup = fixture(t);
  publishFeed(setup.options, setup.gh);
  const previous = setup.assets.get('catalog.json');
  setup.build('1.1.0');
  assert.throws(
    () =>
      publishFeed(setup.options, args => {
        if (args[1] === 'upload' && args[3].endsWith('.hpack')) throw Error('upload interrupted');
        return setup.gh(args);
      }),
    /upload interrupted/,
  );
  assert.deepEqual(setup.assets.get('catalog.json'), previous);
});

test('unsigned beta installs and updates published signed Packs while Core OTA stays disabled', async t => {
  const setup = fixture(t);
  publishFeed(setup.options, setup.gh);
  const base = 'https://updates.example/desktop-beta-feed/';
  t.mock.method(global, 'fetch', async url => {
    assert.ok(String(url).startsWith(base));
    const bytes = setup.assets.get(String(url).slice(base.length));
    return new Response(bytes || 'missing', { status: bytes ? 200 : 404 });
  });
  const catalog = new PackCatalog({
    directory: path.join(setup.directory, 'store'),
    keys: setup.keys,
    channel: 'beta',
    url: `${base}catalog.json`,
  });
  const updater = new CoreUpdater({ packaged: true, configured: false, updater: null });
  let entries = await catalog.available();
  assert.equal(catalog.snapshot().state, 'connected');
  assert.equal(catalog.snapshot().bundledDomains, 0);
  await catalog.manager.install(entries[0]);
  assert.equal(catalog.manager.list()[0].version, '1.0.0');
  setup.build('1.1.0');
  publishFeed(setup.options, setup.gh);
  entries = await catalog.available();
  assert.equal(catalog.summaries(entries)[0].updateAvailable, true);
  await catalog.manager.install(entries[0]);
  assert.equal(catalog.manager.list()[0].version, '1.1.0');
  assert.equal((await updater.check()).status, 'unconfigured');

  // Authentication and integrity remain enforced on the consumer path.
  setup.build('1.2.0');
  publishFeed(setup.options, setup.gh);
  setup.assets.set('review-1.2.0.hpack', Buffer.from('corrupt archive'));
  entries = await catalog.available();
  await assert.rejects(catalog.manager.install(entries[0]), /size|hash|length/i);
  assert.equal(catalog.manager.list()[0].version, '1.1.0');
  const bad = JSON.parse(setup.assets.get('catalog.json'));
  bad.signature = 'invalid';
  setup.assets.set('catalog.json', Buffer.from(JSON.stringify(bad)));
  assert.deepEqual(await catalog.available(), []);
  assert.equal(catalog.snapshot().state, 'unavailable');
  assert.equal(catalog.manager.list()[0].version, '1.1.0');
});

test('release preparation enables Pack feeds without enabling unsigned Core OTA on both platforms', t => {
  const setup = fixture(t);
  const script = path.join(root, 'scripts/desktop-release-env.cjs');
  const source = fs.readFileSync(script, 'utf8');
  for (const version of ['1.0.1-beta.6', '1.0.1']) {
    const channel = version.includes('beta') ? 'beta' : 'stable';
    for (const platform of ['darwin', 'win32']) {
      for (const signed of [false, true]) {
        const output = path.join(setup.directory, 'env');
        fs.writeFileSync(output, '');
        const env = {
          GITHUB_REF_NAME: `desktop-v${version}`,
          GITHUB_REPOSITORY: 'owner/harness',
          RUNNER_TEMP: setup.directory,
          GITHUB_ENV: output,
          HARNESS_PACK_PUBLIC_KEYS_JSON_B64: Buffer.from(JSON.stringify(setup.keys)).toString(
            'base64',
          ),
          ...(signed
            ? {
                CSC_LINK: 'certificate',
                CSC_KEY_PASSWORD: 'password',
                APPLE_API_KEY_ID: 'key',
                APPLE_API_ISSUER: 'issuer',
                APPLE_API_KEY_P8_B64: Buffer.from('key').toString('base64'),
                WIN_CSC_LINK: 'certificate',
                WIN_CSC_KEY_PASSWORD: 'password',
              }
            : {}),
        };
        const requireFromScript = createRequire(script);
        vm.runInNewContext(source, {
          Buffer,
          require: name =>
            name === '../apps/desktop/package.json' ? { version } : requireFromScript(name),
          process: { env, platform, stdout: { write() {} } },
        });
        const result = Object.fromEntries(
          fs
            .readFileSync(output, 'utf8')
            .trimEnd()
            .split('\n')
            .map(line => {
              const equals = line.indexOf('=');
              return [line.slice(0, equals), line.slice(equals + 1)];
            }),
        );
        const feed = `https://github.com/owner/harness/releases/download/desktop-${channel}-feed`;
        assert.equal(result.HARNESS_PACK_CATALOG_URL, `${feed}/catalog.json`);
        assert.equal(result.HARNESS_CORE_UPDATE_URL, signed ? feed : '');
        assert.equal(result.HARNESS_DESKTOP_SIGNING, signed ? 'signed' : 'unsigned');
      }
    }
  }
});

test('release workflow injects signing credentials before detection and invokes the tested publisher', () => {
  const source = fs.readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8');
  const prepare = source
    .split('      - name: Prepare release identity and Pack public keys\n')[1]
    .split(/\n {6}- /)[0];
  for (const name of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY_P8_B64',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
  ])
    assert.match(prepare, new RegExp(`${name}: \\$\\{\\{ secrets\\.`));
  assert.match(source, /run: node scripts\/publish-desktop-feed\.cjs release-assets/);
  const publisher = source.split('  publish-feed:\n')[1];
  assert.match(publisher, /uses: pnpm\/action-setup@v4/);
  assert.ok(
    publisher.indexOf('install --frozen-lockfile --ignore-scripts') <
      publisher.indexOf('run: node scripts/publish-desktop-feed.cjs'),
  );
  assert.match(publisher, /pnpm --filter @industrial-agent-harness\/pack-manager\.\.\. install/);
  assert.doesNotMatch(source, /Skipping the update feed for an unsigned build/);
  assert.ok(
    require('../../scripts/ci-tests.cjs')
      .portableFiles()
      .includes('tests/ci/release-desktop.test.cjs'),
  );
});
