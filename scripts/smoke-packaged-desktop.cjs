#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'desktop-release');
const folders = fs.readdirSync(output);
let executable;
if (process.platform === 'win32') {
  executable = path.join(output, 'win-unpacked', 'Industrial Agent Harness.exe');
} else if (process.platform === 'darwin') {
  if (process.arch !== 'arm64')
    throw Error(
      'Packaged Desktop smoke requires Apple Silicon; Intel Mac is temporarily unsupported.',
    );
  const preferred = ['mac-arm64', 'mac'];
  const mac =
    preferred.find(name =>
      fs.existsSync(path.join(output, name, 'Industrial Agent Harness.app')),
    ) ||
    folders.find(
      name =>
        name.startsWith('mac') &&
        fs.existsSync(path.join(output, name, 'Industrial Agent Harness.app')),
    );
  if (mac)
    executable = path.join(
      output,
      mac,
      'Industrial Agent Harness.app',
      'Contents',
      'MacOS',
      'Industrial Agent Harness',
    );
} else throw Error('Packaged Desktop smoke supports macOS and Windows.');
if (!executable || !fs.existsSync(executable))
  throw Error('Packaged Desktop executable is missing.');
const screenshot = path.join(
  os.tmpdir(),
  `industrial-harness-first-run-${process.platform}-${process.arch}.png`,
);
const environment = { ...process.env, HARNESS_PACKAGED_SMOKE_SCREENSHOT: screenshot };
let fixture;
if (process.argv.includes('--domains')) {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-harness-feed-smoke-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = { smoke: publicKey.export({ type: 'spki', format: 'pem' }) };
  const signingKey = path.join(fixture, 'signing.pem');
  fs.writeFileSync(signingKey, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const feed = path.join(fixture, 'feed');
  const built = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'build-pack-distribution.cjs'), feed],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        INDUSTRIAL_HARNESS_PACK_STORE: '',
        HARNESS_PACK_CHANNEL: 'stable',
        HARNESS_PACK_SIGNING_KEY_FILE: signingKey,
        HARNESS_PACK_SIGNING_KEY_ID: 'smoke',
        HARNESS_PACK_PLATFORMS: `${process.platform}-${process.arch}`,
      },
    },
  );
  if (built.status !== 0) throw Error(built.stderr || 'Could not build signed Domain smoke feed.');
  const platform = `${process.platform}-${process.arch}`;
  const declarations = require('@zhiman-bj/industrial-domain-packs').consumerMetadata().domains;
  const expected = declarations.filter(
    item => !item.qualifiedBundlePlatforms || item.qualifiedBundlePlatforms.includes(platform),
  );
  const catalog = JSON.parse(fs.readFileSync(path.join(feed, 'catalog.json'), 'utf8')).payload;
  require('node:assert/strict').deepEqual(
    catalog.packs.map(item => item.domain).sort(),
    expected.map(item => item.id).sort(),
    'Signed feed must exactly match owner-qualified platform declarations.',
  );
  const planned = expected.filter(item => ['chip', 'pcb', 'godot'].includes(item.id));
  const engine = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  const missingEngine = engine.status !== 0 || engine.stdout.trim() !== 'linux';
  const requiresEngine = new Set(
    catalog.packs.filter(item => item.containerDownloadSize > 0).map(item => item.domain),
  );
  const failures = planned.filter(item => missingEngine && requiresEngine.has(item.id));
  environment.HARNESS_PACKAGED_SMOKE_DOCKER_FAILURES = JSON.stringify(
    failures.map(({ id, label }) => ({ id, label })),
  );
  environment.HARNESS_PACKAGED_SMOKE_DOMAINS = JSON.stringify(
    planned.filter(item => !failures.includes(item)).map(({ id, label }) => ({ id, label })),
  );
  environment.HARNESS_PACKAGED_SMOKE_STORE = path.join(fixture, 'store');
  require('./runtime-archive-cache.cjs').stageRuntimeArchiveCache(
    environment.HARNESS_PACKAGED_SMOKE_STORE,
    catalog.packs.flatMap(item => item.runtimeAssets || []),
  );
  const config = path.join(fixture, 'pack-feed.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      catalogUrl: 'https://updates.example/catalog.json',
      publicKeys: keys,
    }),
  );
  environment.INDUSTRIAL_HARNESS_PACK_FEED_FILE = config;
  environment.HARNESS_PACKAGED_SMOKE_FEED_DIR = feed;
}
const result = spawnSync(executable, ['--packaged-smoke'], {
  encoding: 'utf8',
  timeout: process.argv.includes('--domains') ? 30 * 60 * 1000 : 30000,
  env: environment,
});
if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
if (
  result.error ||
  result.status !== 0 ||
  !fs.statSync(screenshot, { throwIfNoEntry: false })?.isFile()
) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  throw result.error || Error(`Packaged Desktop first-run smoke failed: ${result.status}`);
}
const firstRun = result.stdout.split('\n').flatMap(line => {
  try {
    const value = JSON.parse(line);
    return Array.isArray(value.firstRunDomains) ? [value] : [];
  } catch {
    return [];
  }
})[0];
require('node:assert/strict').deepEqual(
  firstRun?.firstRunDomains,
  require('@zhiman-bj/industrial-domain-packs')
    .consumerMetadata()
    .domains.map(item => item.id)
    .sort(),
  'Every declared domain must be visible, with unavailable domains explained.',
);
const reports = path.join(root, 'dist/ci-reports');
fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(
  path.join(
    reports,
    process.argv.includes('--domains') ? 'desktop-domain-install.json' : 'desktop-first-run.json',
  ),
  JSON.stringify(
    {
      ...firstRun,
      screenshot,
      executable,
      passed: true,
      expectedDockerFailures: JSON.parse(
        environment.HARNESS_PACKAGED_SMOKE_DOCKER_FAILURES || '[]',
      ),
    },
    null,
    2,
  ),
);
process.stdout.write(
  `${process.argv.includes('--domains') ? 'Domain installation and prerequisite checks passed' : 'First-run Domain selection passed'}: ${screenshot}\n`,
);
