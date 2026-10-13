#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const { startModel } = require('../tests/integration/fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);

// After the external-native-dependencies redesign the packaged CAD selftest
// associates an externally installed FreeCAD application (HARNESS_CAD_INSTALL_APP_PATH)
// instead of downloading one itself. Detect that contract so this smoke keeps
// driving both selftest generations.
function packagedSelftestExpectsExternalApp(
  source = path.join(__dirname, '../apps/desktop/electron/cad-install-selftest.cjs'),
) {
  return fs.readFileSync(source, 'utf8').includes('HARNESS_CAD_INSTALL_APP_PATH');
}

// Provision a verified external FreeCAD fixture the selftest can associate.
// Bytes come from the pinned owner's declared archive through the shared CI
// archive verifier; the app is copied out of the DMG without installing it.
async function provisionExternalFreeCADApp(directory, { archive } = {}) {
  let source = archive;
  if (!source) {
    const { archiveDeclarations, prepareArchives } = require('./prepare-ci-runtime-archives.cjs');
    const asset = archiveDeclarations(path.join(__dirname, '..', 'dist')).find(
      item => item.id === 'freecad',
    );
    if (!asset) throw Error('The pinned owner must declare the FreeCAD runtime archive.');
    ({ freecad: source } = await prepareArchives([asset], { download: true }));
  }
  const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cad-fixture-')));
  const app = path.join(directory, 'FreeCAD.app');
  let attached = false;
  try {
    await execute('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      source,
    ]);
    attached = true;
    await execute('/usr/bin/ditto', [path.join(mount, 'FreeCAD.app'), app]);
    return app;
  } finally {
    if (attached) await execute('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmSync(mount, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('Native CAD installer gate requires Apple Silicon.');
  const output = path.resolve(__dirname, '../dist/desktop-release');
  const folder = ['mac-arm64', 'mac'].find(name =>
    fs.existsSync(path.join(output, name, 'Industrial Agent Harness.app')),
  );
  let executable =
    process.env.HARNESS_CAD_INSTALL_APP ||
    path.join(
      output,
      folder || 'missing',
      'Industrial Agent Harness.app/Contents/MacOS/Industrial Agent Harness',
    );
  const evidence = path.resolve(process.argv[2] || 'dist/ci-reports/cad-install');
  if (fs.existsSync(evidence)) throw Error('Use a fresh installer evidence directory.');
  fs.mkdirSync(evidence, { recursive: true });
  if (process.argv.includes('--dmg')) {
    const dmg = fs.readdirSync(output).find(name => name.endsWith('-arm64.dmg'));
    if (!dmg) throw Error('Apple Silicon installer DMG is missing.');
    const mount = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-gate-')),
    );
    let attached = false;
    try {
      await execute('/usr/bin/hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        mount,
        path.join(output, dmg),
      ]);
      attached = true;
      const installed = path.join(evidence, 'application', 'Industrial Agent Harness.app');
      fs.mkdirSync(path.dirname(installed));
      await execute('/usr/bin/ditto', [
        path.join(mount, 'Industrial Agent Harness.app'),
        installed,
      ]);
      executable = path.join(installed, 'Contents/MacOS/Industrial Agent Harness');
    } finally {
      if (attached) await execute('/usr/bin/hdiutil', ['detach', mount]);
      fs.rmdirSync(mount);
    }
  }
  const recipe = {
    parameters: { L: 40, W: 20, T: 5, R: 2 },
    features: [
      { id: 'Plate', op: 'sketch_pad', profile: 'rectangle', length: 'L', width: 'W', height: 'T' },
      { id: 'Drilled', op: 'hole', base: 'Plate', radius: 'R', height: 'T', origin: [10, 10, 0] },
    ],
    result: 'Drilled',
  };
  const externalAppDirectory = packagedSelftestExpectsExternalApp()
    ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cad-external-')))
    : null;
  let externalApp = null;
  if (externalAppDirectory) {
    try {
      externalApp = await provisionExternalFreeCADApp(externalAppDirectory);
    } catch (error) {
      fs.rmSync(externalAppDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const model = await startModel({
    success: 'CAD_INSTALL_TASK_OK',
    calls: body => {
      const text = JSON.stringify(body.messages);
      const state = [...text.matchAll(/expectedStateId=([a-f0-9-]{36})/g)].at(-1)?.[1];
      assert.ok(state, 'Native Kimi must receive an observed Runtime state');
      const follow = text.includes('CAD_INSTALL_EDIT');
      const file = text.match(/cad-output\/[a-f0-9-]{36}\/model.FCStd/)?.[0];
      return follow
        ? [
            null,
            null,
            { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.edit' } },
            {
              name: 'industrial_action_call',
              arguments: {
                toolId: 'cad.freecad.edit',
                inputsJson: JSON.stringify({
                  file,
                  changes: { parameters: { W: 30, R: 3 } },
                  expect: { bounds: [40, 30, 5], volume: 6000 - 45 * Math.PI, solids: 1 },
                }),
                expectedStateId: state,
              },
            },
          ]
        : [
            { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.build' } },
            {
              name: 'industrial_action_call',
              arguments: {
                toolId: 'cad.freecad.build',
                inputs: {
                  recipe,
                  expect: { bounds: [40, 20, 5], volume: 4000 - 20 * Math.PI, solids: 1 },
                },
                expectedStateId: state,
              },
            },
          ];
    },
  });
  try {
    const env = {
      ...process.env,
      INDUSTRIAL_HARNESS_FREECAD_CMD: '',
      KIMI_EXECUTABLE: '',
      INDUSTRIAL_HARNESS_PACK_FEED_FILE: '',
      INDUSTRIAL_HARNESS_PACK_CATALOG_URL: '',
      HARNESS_CAD_INSTALL_MODEL_ENDPOINT: model.endpoint,
      HARNESS_CAD_INSTALL_REPORT_DIR: evidence,
      ...(externalApp ? { HARNESS_CAD_INSTALL_APP_PATH: externalApp } : {}),
    };
    const first = await promisify(execFile)(executable, ['--cad-install-selftest'], {
      cwd: evidence,
      env,
      timeout: 25 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(evidence, 'application.log'), first.stdout + first.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(evidence, 'acceptance.json'), 'utf8'));
    assert.equal(report.packaged, true);
    assert.equal(report.actions.length, 2);
    assert.ok(report.verifications.every(item => item.status === 'passed'));
    assert.equal(report.repaired, true);
    assert.ok(model.requests.length >= 6, 'Both tasks must use the packaged native Kimi loop');
    const restart = await promisify(execFile)(
      executable,
      ['--cad-install-selftest', '--cad-install-restart'],
      { cwd: evidence, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
    fs.appendFileSync(path.join(evidence, 'application.log'), restart.stdout + restart.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'restart.json'))).ready, true);
    process.stdout.write(
      `Installed CAD/FreeCAD build, edit, Viewer, repair and restart passed: ${evidence}\n`,
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, 'failure.log'),
      [error.message, error.stdout, error.stderr].filter(Boolean).join('\n'),
    );
    throw error;
  } finally {
    model.close();
    if (externalAppDirectory) fs.rmSync(externalAppDirectory, { recursive: true, force: true });
  }
}
module.exports = { packagedSelftestExpectsExternalApp, provisionExternalFreeCADApp };
if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
