#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const owner = require('@zhiman-bj/industrial-domain-packs');
const sourceCommit =
  require('../package.json').dependencies['@zhiman-bj/industrial-domain-packs'].match(
    /\/([a-f0-9]{40})$/,
  )?.[1];
if (!sourceCommit) throw Error('Platform builds require an immutable owner commit.');
owner.verifyIntegrity();
const output = path.resolve(process.argv[2] || 'dist/platform-probe');
if (fs.existsSync(output)) throw Error(`Output already exists: ${output}`);
const platforms = (process.env.HARNESS_PROBE_PLATFORMS || 'darwin-arm64,linux-x64').split(',');
if (
  new Set(platforms).size !== platforms.length ||
  platforms.some(platform => !['darwin-arm64', 'linux-x64'].includes(platform))
)
  throw Error('Unsupported platform probe build target.');
const sourceFiles = Object.fromEntries(
  Object.entries(require(path.join(owner.root, 'content-lock.json')).files).filter(([file]) =>
    file.startsWith('mcp/environment-probe/'),
  ),
);
const components = [];
for (const platform of platforms) {
  const [GOOS, arch] = platform.split('-');
  const file = `${platform}/industrial-environment-probe`;
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = spawnSync(
    'go',
    ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', target, '.'],
    {
      cwd: path.join(owner.root, 'mcp/environment-probe'),
      env: { ...process.env, GOOS, GOARCH: arch === 'x64' ? 'amd64' : arch, CGO_ENABLED: '0' },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Platform probe build failed: ${platform}`);
  fs.chmodSync(target, 0o755);
  const bytes = fs.readFileSync(target);
  components.push({
    id: 'environment-probe',
    platform,
    file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
}
const indexFile = path.join(output, 'platform-probe-index.json');
fs.writeFileSync(
  indexFile,
  JSON.stringify(
    {
      schemaVersion: 2,
      kind: 'platform-components',
      sourceCommit,
      sourceState: 'committed',
      sourceFiles,
      components,
    },
    null,
    2,
  ) + '\n',
);
require('./platform-probe-input.cjs').inspectPlatformProbe(indexFile, { owner, sourceCommit });
process.stdout.write(indexFile + '\n');
