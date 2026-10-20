const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');

test('unsupported platforms and overlapping project/session storage fail before launching', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const nested = path.join(directory, 'nested');
  fs.mkdirSync(nested);
  assert.throws(() => createProcessSandbox({ platform: 'freebsd' }), /unsupported/);
  for (const [projectDir, shareDir] of [
    [directory, directory],
    [directory, nested],
    [nested, directory],
  ])
    assert.throws(
      () => createProcessSandbox({ projectDir, shareDir, executable: process.execPath }),
      /must be separate/,
    );
});

test(
  'POSIX platform selection has no bubblewrap or Seatbelt prerequisite',
  { skip: process.platform === 'win32' },
  t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-platform-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const name of ['project', 'share']) fs.mkdirSync(path.join(directory, name));
    for (const platform of ['darwin', 'linux']) {
      const launcher = createProcessSandbox({
        platform,
        executable: process.execPath,
        projectDir: path.join(directory, 'project'),
        shareDir: path.join(directory, 'share'),
        environment: { PATH: '' },
      });
      t.after(() => launcher.close());
      assert.equal(launcher.boundary.platform, platform);
      assert.equal(launcher.boundary.mechanism, 'current-user');
      assert.equal(launcher.boundary.osIsolation, false);
      assert.equal(launcher.envIsolated, true);
      assert.deepEqual(fs.readdirSync(launcher.directory), ['scratch']);
    }
    assert.throws(
      () =>
        createProcessSandbox({
          executable: 'missing-kimi',
          projectDir: path.join(directory, 'project'),
          shareDir: path.join(directory, 'share'),
          environment: { PATH: '' },
        }),
      /executable is unavailable/,
    );
  },
);
