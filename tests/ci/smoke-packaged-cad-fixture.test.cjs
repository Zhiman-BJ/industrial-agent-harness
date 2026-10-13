const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  packagedSelftestExpectsExternalApp,
  provisionExternalFreeCADApp,
} = require('../../scripts/smoke-packaged-cad.cjs');

const execute = promisify(execFile);

test('the external-app gate follows the packaged selftest contract marker', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cad-gate-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const selfPreparing = path.join(directory, 'self-preparing.cjs');
  fs.writeFileSync(selfPreparing, "fs.realpathSync('/Applications/FreeCAD.app')");
  const externallyAssociated = path.join(directory, 'externally-associated.cjs');
  fs.writeFileSync(
    externallyAssociated,
    "process.env.HARNESS_CAD_INSTALL_APP_PATH || '/Applications/FreeCAD.app'",
  );
  assert.equal(packagedSelftestExpectsExternalApp(selfPreparing), false);
  assert.equal(packagedSelftestExpectsExternalApp(externallyAssociated), true);
});

test('external FreeCAD provisioning copies the app out of a DMG without installing it', async t => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cad-provision-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (process.platform !== 'darwin') {
    // The packaged CAD gate itself only runs on Apple Silicon; elsewhere the
    // provisioning must fail on the macOS tooling instead of pretending success.
    await assert.rejects(
      provisionExternalFreeCADApp(directory, { archive: path.join(directory, 'unused.dmg') }),
      /hdiutil|ENOENT/,
    );
    return;
  }
  const content = path.join(directory, 'content');
  fs.mkdirSync(path.join(content, 'FreeCAD.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(content, 'FreeCAD.app/Contents/MacOS/FreeCAD'), 'fixture-binary\n', {
    mode: 0o755,
  });
  const archive = path.join(directory, 'fixture.dmg');
  await execute('/usr/bin/hdiutil', [
    'create',
    '-volname',
    'Fixture',
    '-srcfolder',
    content,
    '-fs',
    'HFS+',
    '-format',
    'UDZO',
    '-o',
    archive,
  ]);
  const destination = path.join(directory, 'out');
  fs.mkdirSync(destination);
  const app = await provisionExternalFreeCADApp(destination, { archive });
  assert.equal(
    fs.readFileSync(path.join(app, 'Contents/MacOS/FreeCAD'), 'utf8'),
    'fixture-binary\n',
  );
  assert.equal(
    fs.existsSync(path.join(destination, 'FreeCAD.app')),
    true,
    'The fixture app must land in the requested directory.',
  );
});
