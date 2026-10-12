#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const compilerManifest = require.resolve('typescript/package.json', {
  paths: [path.join(root, 'apps/desktop')],
});
const compiler = path.join(path.dirname(compilerManifest), 'bin/tsc');
function check(arguments_) {
  const result = spawnSync(process.execPath, arguments_, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}
if (
  check([
    compiler,
    '--noEmit',
    '--strict',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    'packages/contracts/tests/consumer-types.cts',
  ])
) {
  check([
    '--test',
    'packages/contracts/tests/industrial-contract.test.cjs',
    'packages/domain-skills/src/distribution.test.cjs',
    'packages/domain-skills/src/pack-resources.test.cjs',
    'packages/pack-manager/src/index.test.cjs',
    'tests/integration/platform-probe-distribution.test.cjs',
  ]);
}
