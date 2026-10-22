#!/usr/bin/env node
// Explicit real-release acceptance, outside the offline portable test suite.
// Usage: node scripts/verify-release-image-installation.cjs <fresh-output> [domain]
// Build the desktop renderer first. Requires a running Linux Docker engine.
// Optional HARNESS_CONTAINER_INSTALL_EXECUTABLE exercises a packaged app.
// Optional HARNESS_CONTAINER_INSTALL_IMAGE_CACHE copies prior verified receipts;
// live Docker identity is still checked and the report labels this as warm reuse.
// Optional HARNESS_CONTAINER_INSTALL_NATIVE_CACHE reuses vendor archive bytes;
// the normal native installer still verifies their full size/hash and installs them.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createLocalhostCertificate } = require('../packages/pack-manager/src/localhost-tls.cjs');
const { PackManager } = require('../packages/pack-manager/src/index.cjs');
const { run } = require('../packages/pack-manager/src/runtime-assets.cjs');
const owner = require('@zhiman-bj/industrial-domain-packs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist/release-image-installation');
const lock = JSON.parse(
  fs.readFileSync(path.join(owner.root, 'provenance/runtime-distribution.json')),
);
const domain = process.argv[3] || lock.images.find(image => image.current)?.pack;
if (fs.existsSync(output)) throw Error('Acceptance output must be a fresh directory.');
fs.mkdirSync(output, { recursive: true });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const keys = path.join(output, 'keys.json'),
  signingKey = path.join(output, 'signing.pem');
fs.writeFileSync(
  keys,
  JSON.stringify({ acceptance: publicKey.export({ type: 'spki', format: 'pem' }) }),
);
fs.writeFileSync(signingKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const tls = createLocalhostCertificate(),
  cert = path.join(output, 'localhost.pem');
fs.writeFileSync(cert, tls.cert);
const store = path.join(output, 'store'),
  feed = path.join(output, 'feed');
const reuse = process.env.HARNESS_CONTAINER_INSTALL_IMAGE_CACHE;
const nativeCache = process.env.HARNESS_CONTAINER_INSTALL_NATIVE_CACHE;
if (nativeCache) {
  const destination = path.join(store, '.runtime-assets', 'cache');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(nativeCache)) {
    if (!/^[a-f0-9]{64}\.(dmg|zip)$/.test(name)) continue;
    const file = path.join(nativeCache, name);
    if (!fs.lstatSync(file).isFile()) throw Error('Only regular native archives may be reused.');
    fs.copyFileSync(
      file,
      path.join(destination, name),
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
  }
}
if (reuse) {
  const destination = path.join(store, '.container-images');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(reuse)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(reuse, name);
    if (!fs.lstatSync(file).isFile()) throw Error('Only regular image receipts may be reused.');
    fs.copyFileSync(file, path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
}
let lastReport = 0;
function child(command, args, environment, log) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fd = fs.openSync(path.join(output, log), 'w');
    let tail = '',
      pending = '';
    process.stdout.on('data', bytes => {
      fs.writeSync(fd, bytes);
      tail = (tail + bytes).slice(-4000);
      pending += bytes;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.phase !== 'downloading' || Date.now() - lastReport > 30000) {
            console.log(line);
            lastReport = Date.now();
          }
        } catch {
          if (line.includes('passed')) console.log(line);
        }
      }
    });
    process.stderr.on('data', bytes => {
      fs.writeSync(fd, bytes);
      tail = (tail + bytes).slice(-4000);
    });
    process.on('error', reject);
    process.on('close', code => {
      fs.closeSync(fd);
      code === 0 ? resolve() : reject(Error(`${log} exited ${code}: ${tail}`));
    });
  });
}
async function main() {
  const started = new Date().toISOString();
  await child(
    process.execPath,
    ['scripts/build-pack-distribution.cjs', feed],
    {
      ...process.env,
      HARNESS_PACK_DOMAINS: domain,
      HARNESS_PACK_CHANNEL: 'stable',
      HARNESS_PACK_SIGNING_KEY_FILE: signingKey,
      HARNESS_PACK_SIGNING_KEY_ID: 'acceptance',
      INDUSTRIAL_HARNESS_PACK_STORE: '',
    },
    'build.log',
  );
  fs.rmSync(signingKey);
  const server = https.createServer(tls, (req, res) => {
    const name = path.basename(new URL(req.url, 'https://localhost').pathname);
    const file = path.join(feed, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const catalog = `https://127.0.0.1:${server.address().port}/catalog.json`;
    const environment = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: cert,
      INDUSTRIAL_HARNESS_PACK_STORE: store,
      INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(output, 'config'),
      INDUSTRIAL_HARNESS_PACK_CATALOG_URL: catalog,
      INDUSTRIAL_HARNESS_PACK_KEYS_FILE: keys,
    };
    const config = path.join(output, 'feed-config.json');
    fs.writeFileSync(config, JSON.stringify({ channel: 'stable' }));
    const packaged = process.env.HARNESS_CONTAINER_INSTALL_EXECUTABLE;
    const electron =
      packaged ||
      require(require.resolve('electron', { paths: [path.join(root, 'apps/desktop')] }));
    await child(
      electron,
      [...(packaged ? [] : ['apps/desktop']), '--container-install-selftest'],
      {
        ...environment,
        INDUSTRIAL_HARNESS_PACK_FEED_FILE: config,
        HARNESS_CONTAINER_INSTALL_DOMAIN: domain,
        HARNESS_CONTAINER_INSTALL_REPORT: output,
      },
      'desktop.log',
    );
    const desktopReport = JSON.parse(fs.readFileSync(path.join(output, 'desktop.json')));
    assert.equal(
      desktopReport.installed.catalog.state,
      'connected',
      'Desktop must verify the signed HTTPS feed; bundled fallback is not this acceptance path.',
    );
    const manager = new PackManager({ directory: store });
    assert.deepEqual(manager.scan().errors, []);
    const bundle = manager.list().find(item => item.domain === domain);
    assert.ok(bundle.containerImages.length > 0);
    assert.ok(manager.runtimeStatus(bundle).every(asset => asset.ready));
    const receipts = fs
      .readdirSync(manager.containerImages.directory)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(manager.containerImages.directory, name))));
    for (const image of receipts) {
      // This proves the imported platform can start; it is not engineering acceptance.
      await run(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--platform',
          image.platform,
          '--entrypoint',
          '/bin/true',
          image.imageRef,
        ],
        { timeout: 120000 },
      );
    }
    manager.remove(domain);
    assert.deepEqual(manager.list(), []);
    const summary = {
      started,
      finished: new Date().toISOString(),
      host: `${process.platform}-${process.arch}`,
      sourceCommit: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim(),
      owner: owner.identity,
      domain,
      images: receipts,
      installation: reuse ? 'verified image reuse' : 'cold Desktop installation',
      removal: 'shared PackManager removal passed',
      nativeArchives: nativeCache
        ? 'existing vendor archives reverified before installation'
        : 'downloaded by native installer',
      desktop:
        'installation and repair buttons through renderer/preload/IPC passed; live Docker image identity and startup verified',
      packaged: Boolean(packaged),
      engine: JSON.parse(await run('docker', ['version', '--format', '{{json .Server}}'])),
      limitation:
        'Image preparation and container startup only; no additional engineering or OS qualification claimed.',
    };
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(signingKey, { force: true }));
