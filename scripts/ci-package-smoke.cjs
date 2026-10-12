#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist/ci-headless');
// This script owns only this disposable CI output, never release output directories.
fs.rmSync(output, { recursive: true, force: true });
function execute(script, arguments_) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...arguments_], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${script} failed (${result.status}).`);
}
const owner = require('@zhiman-bj/industrial-domain-packs');
const platform = `${process.platform}-${process.arch}`;
const declared = owner.consumerMetadata().domains;
const qualified = declared.filter(domain => domain.qualifiedBundlePlatforms.includes(platform));
// Platforms without an installable profile still exercise portable source
// discovery/isolation for every domain, without claiming native qualification.
const domains = (qualified.length ? qualified : declared).map(domain => domain.id);
if (!domains.length) throw Error('No declared Domain package profiles.');
console.log(JSON.stringify({ platform, mode: 'source-package-smoke',
  installableDomains: qualified.map(domain => domain.id), domains }));
for (const domain of domains) {
  execute('package-headless.cjs', [path.join(output, `headless-${domain}`), '--domain', domain]);
}
execute('smoke-domain-cli.cjs', [output]);
