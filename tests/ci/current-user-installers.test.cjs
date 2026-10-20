const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyLauncher } = require('../../scripts/verify-kimi-launcher.cjs');

function fixture(t, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'current-user-installer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectDir = path.join(directory, 'project with spaces');
  const shareDir = path.join(directory, 'session');
  const executable = path.join(directory, 'startup.cjs');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(shareDir);
  fs.writeFileSync(executable, body);
  return {
    projectDir,
    shareDir,
    executable,
    agentEntry: require.resolve('../../packages/agent-kimi/src/index.cjs'),
  };
}

test('installer startup uses the production launcher, current-user project writes and filtered child environment', async t => {
  const options = fixture(
    t,
    `
    const fs = require('node:fs'), path = require('node:path');
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    assert.equal(args[0], '--add-dir');
    assert.equal(args[2], '--version');
    assert.equal(process.env.HARNESS_INSTALLER_HOST_ONLY, undefined);
    assert.equal(process.env.KIMI_CODE_HOME, process.env.KIMI_SHARE_DIR);
    fs.writeFileSync(path.join(args[1], 'current-user.txt'), 'PROJECT_WRITE_OK');
    fs.writeFileSync(path.join(process.env.KIMI_SHARE_DIR, 'observed.json'), JSON.stringify({
      scratch: process.env.TMPDIR, cwd: process.cwd()
    }));
    console.log('2.1.1');
  `,
  );
  const boundary = await verifyLauncher(options);
  assert.equal(boundary.mechanism, 'current-user');
  assert.equal(boundary.osIsolation, false);
  assert.equal(boundary.projectWritable, true);
  assert.equal(
    fs.readFileSync(path.join(options.projectDir, 'current-user.txt'), 'utf8'),
    'PROJECT_WRITE_OK',
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(options.shareDir, 'process-boundary.json'))),
    boundary,
  );
  const observed = JSON.parse(fs.readFileSync(path.join(options.shareDir, 'observed.json')));
  assert.equal(
    fs.realpathSync(observed.cwd),
    fs.realpathSync(path.join(options.shareDir, 'workspace')),
  );
  assert.equal(
    fs.existsSync(observed.scratch),
    false,
    'Startup closes its temporary launcher storage',
  );
});

test('failed installer startup closes its launcher and cannot publish successful boundary evidence', async t => {
  const options = fixture(
    t,
    `
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(path.join(process.env.KIMI_SHARE_DIR, 'scratch.txt'), process.env.TMPDIR);
    console.error('STARTUP_FAILED');
    process.exitCode = 7;
  `,
  );
  fs.writeFileSync(path.join(options.shareDir, 'process-boundary.json'), 'stale successful probe');
  await assert.rejects(verifyLauncher(options), /STARTUP_FAILED/);
  assert.equal(fs.existsSync(path.join(options.shareDir, 'process-boundary.json')), false);
  assert.equal(
    fs.existsSync(fs.readFileSync(path.join(options.shareDir, 'scratch.txt'), 'utf8')),
    false,
  );
});
