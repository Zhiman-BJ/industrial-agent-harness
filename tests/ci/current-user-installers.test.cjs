const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyLauncher } = require('../../scripts/verify-kimi-launcher.cjs');
const { assertAgentBoundary } = require('../../scripts/assert-agent-boundary.cjs');
const { isRejectedToolResult } = require('../integration/fixtures/domain-mcp-model.cjs');

test('release fixture distinguishes a policy diagnostic from actual denied or rejected tools', () => {
  assert.equal(
    isRejectedToolResult({
      content: JSON.stringify({
        actionStatus: 'completed',
        diagnostics: ['agent_docker_access: intentionally_denied'],
      }),
    }),
    false,
  );
  assert.equal(
    isRejectedToolResult({
      content: JSON.stringify({
        actionStatus: 'completed',
        diagnostics: [JSON.stringify({ agent_docker_access: 'intentionally_denied' })],
      }),
    }),
    false,
  );
  for (const content of [
    'The tool call is rejected by the user',
    'Permission denied',
    'Tool execution rejected',
    { error: 'Access denied' },
    { error: 'permission_denied' },
    { error: 'scope_denied' },
    { error: 'intentionally_denied' },
    { permission_denied: true },
    { denied: true },
  ])
    assert.equal(isRejectedToolResult({ content }), true);
});

test('release boundary checks require truthful isolation and platform/socket semantics', () => {
  const plain = {
    mechanism: 'current-user',
    osIsolation: false,
    projectWritable: true,
    unixSocketsFiltered: false,
  };
  const seatbelt = { ...plain, mechanism: 'seatbelt', osIsolation: true };
  const bwrap = { ...plain, mechanism: 'bubblewrap', osIsolation: true, unixSocketsFiltered: true };
  assertAgentBoundary(plain, { platform: 'win32' });
  assertAgentBoundary(
    { mechanism: 'current-user', osIsolation: false, projectWritable: true },
    { platform: 'win32' },
  );
  assertAgentBoundary(plain, { platform: 'linux' });
  assertAgentBoundary(seatbelt, { platform: 'darwin' });
  assertAgentBoundary(bwrap, { platform: 'linux', arch: 'x64' });
  assert.throws(() => assertAgentBoundary({ ...plain, osIsolation: true }, { platform: 'win32' }));
  assert.throws(() => assertAgentBoundary(bwrap, { platform: 'win32' }));
  assert.throws(() =>
    assertAgentBoundary(
      { ...bwrap, unixSocketsFiltered: false },
      { platform: 'linux', arch: 'arm64' },
    ),
  );
  assert.throws(() =>
    assertAgentBoundary({ ...seatbelt, projectWritable: false }, { platform: 'darwin' }),
  );
});

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

test('installer startup uses the production launcher with a writable project and filtered child environment', async t => {
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
  if (process.platform === 'darwin') {
    assert.equal(boundary.mechanism, 'seatbelt');
    assert.equal(boundary.osIsolation, true);
  } else if (process.platform !== 'linux') {
    assert.equal(boundary.mechanism, 'current-user');
    assert.equal(boundary.osIsolation, false);
  }
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
