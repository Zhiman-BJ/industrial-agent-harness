const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Desktop packaging retains the pinned manager when workspace discovery cannot read its manifest', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pm-fallback-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '../../..');
  const script = `
    const {createRequire}=require('node:module');
    const path=require('node:path');
    const desktopRequire=createRequire(path.resolve('apps/desktop/package.json'));
    const builderRequire=createRequire(desktopRequire.resolve('electron-builder'));
    const {detectPackageManager}=builderRequire('app-builder-lib/out/node-module-collector/packageManager');
    (async()=>{
      const before=await detectPackageManager([process.argv[1]]);
      require('./electron-builder.config.cjs');
      const after=await detectPackageManager([process.argv[1]]);
      console.log(JSON.stringify({before:before.pm,after:after.pm}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const output = execFileSync(process.execPath, ['-e', script, workspace], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_user_agent: 'npm/11.19.0' },
    timeout: 15000,
  });
  const managers = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(managers.before, 'npm');
  assert.equal(managers.after, require('../../../package.json').packageManager.split('@')[0]);
});
