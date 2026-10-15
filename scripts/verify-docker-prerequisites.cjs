#!/usr/bin/env node
// Real CLI and packaged Desktop failure acceptance; never stops the host engine.
// Usage: node scripts/verify-docker-prerequisites.cjs <fresh-output> <release-acceptance-directory> <packaged-executable>
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createLocalhostCertificate } = require('../packages/pack-manager/src/localhost-tls.cjs');
const { PackManager, verifyCatalog } = require('../packages/pack-manager/src/index.cjs');
const root = path.resolve(__dirname, '..');
const [target, prior, app] = process.argv.slice(2);
if (!target || !prior || !app)
  throw Error('Provide output, release acceptance directory and packaged executable.');
const output = path.resolve(target),
  source = path.resolve(prior),
  executable = path.resolve(app);
if (fs.existsSync(output)) throw Error('Use a fresh output directory.');
fs.mkdirSync(output, { recursive: true });
const emptyPath = path.join(output, 'empty-bin');
fs.mkdirSync(emptyPath);
const keys = path.join(source, 'keys.json'),
  feed = path.join(source, 'feed');
const catalog = verifyCatalog(
  JSON.parse(fs.readFileSync(path.join(feed, 'catalog.json'))),
  JSON.parse(fs.readFileSync(keys)),
);
const selected = catalog.packs.find(pack => pack.containerDownloadSize > 0);
assert.ok(selected, 'The supplied signed feed must contain released images.');
const tls = createLocalhostCertificate(),
  cert = path.join(output, 'localhost.pem');
fs.writeFileSync(cert, tls.cert);
const server = https.createServer(tls, (req, res) => {
  const file = path.join(feed, path.basename(new URL(req.url, 'https://localhost').pathname));
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    res.statusCode = 404;
    res.end();
  } else fs.createReadStream(file).pipe(res);
});
function child(command, args, env, log) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const fd = fs.openSync(log, 'w');
    const timer = setTimeout(() => process.kill('SIGTERM'), 120000);
    process.stdout.on('data', bytes => fs.writeSync(fd, bytes));
    process.stderr.on('data', bytes => fs.writeSync(fd, bytes));
    process.on('error', reject);
    process.on('close', code => {
      clearTimeout(timer);
      fs.closeSync(fd);
      resolve(code);
    });
  });
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const catalogUrl = `https://127.0.0.1:${server.address().port}/catalog.json`;
  const feedConfig = path.join(output, 'feed.json');
  fs.writeFileSync(
    feedConfig,
    JSON.stringify({
      channel: 'stable',
      catalogUrl,
      publicKeys: JSON.parse(fs.readFileSync(keys)),
    }),
  );
  const results = [];
  try {
    for (const [mode, expected] of [
      ['missing', 'Docker was not found. Install Docker Desktop'],
      ['unreachable', 'Docker could not be reached. Start Docker Desktop'],
    ]) {
      const environment = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
      delete environment.DOCKER_CONTEXT;
      if (mode === 'missing') environment.PATH = emptyPath;
      else {
        // A nonexistent local socket tests a real CLI with an unavailable engine.
        // The user's selected context and running engine remain untouched.
        assert.notEqual(process.platform, 'win32', 'This socket acceptance runs on macOS/Linux.');
        const socket = `/tmp/industrial-harness-no-engine-${process.pid}.sock`;
        assert.equal(fs.existsSync(socket), false);
        environment.DOCKER_HOST = 'unix://' + socket;
      }
      for (const adapter of ['cli', 'desktop']) {
        const directory = path.join(output, `${mode}-${adapter}`),
          store = path.join(directory, 'store');
        fs.mkdirSync(directory);
        const env = {
          ...environment,
          INDUSTRIAL_HARNESS_PACK_STORE: store,
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
        };
        const log = path.join(directory, 'output.log');
        const code =
          adapter === 'cli'
            ? await child(
                process.execPath,
                [
                  'apps/cli/src/main.cjs',
                  'domains',
                  'install',
                  selected.domain,
                  '--catalog',
                  catalogUrl,
                  '--keys-file',
                  keys,
                  '--store',
                  store,
                ],
                env,
                log,
              )
            : await child(
                executable,
                ['--packaged-smoke'],
                {
                  ...env,
                  HARNESS_PACKAGED_SMOKE_FEED_DIR: feed,
                  HARNESS_PACKAGED_SMOKE_STORE: store,
                  HARNESS_PACKAGED_SMOKE_DOMAINS: '[]',
                  HARNESS_PACKAGED_SMOKE_DOCKER_FAILURES: JSON.stringify([
                    { id: selected.domain, label: selected.label },
                  ]),
                  HARNESS_PACKAGED_SMOKE_SCREENSHOT: path.join(directory, 'desktop.png'),
                  INDUSTRIAL_HARNESS_PACK_FEED_FILE: feedConfig,
                },
                log,
              );
        assert.equal(code, adapter === 'cli' ? 1 : 0, fs.readFileSync(log, 'utf8').slice(-3000));
        const journal = JSON.parse(
          fs.readFileSync(path.join(store, '.installation-operation.json')),
        );
        assert.equal(journal.outcome, 'failed');
        assert.equal(journal.active, false);
        assert.ok(journal.error.startsWith(expected), journal.error);
        const manager = new PackManager({ directory: store });
        assert.deepEqual(manager.list(), []);
        assert.equal(fs.existsSync(manager.containerImages.directory), false);
        assert.equal(fs.existsSync(manager.runtimeAssets.directory), false);
        results.push({
          mode,
          adapter,
          passed: true,
          outcome: journal.outcome,
          message: journal.error.split('\n')[0],
          activatedPacks: 0,
          imageDownloads: 0,
          nativeDownloads: 0,
        });
      }
    }
    fs.writeFileSync(
      path.join(output, 'summary.json'),
      JSON.stringify(
        {
          finished: new Date().toISOString(),
          host: `${process.platform}-${process.arch}`,
          results,
          isolation:
            'Child environment only; host Docker installation, engine and context unchanged',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Missing Docker and unreachable-engine acceptance passed for CLI and packaged Desktop.',
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
