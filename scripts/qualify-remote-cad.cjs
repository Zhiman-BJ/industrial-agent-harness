// Opt-in real remote qualification through the shared Harness Broker/Runtime.
// Supply an authenticated RemoteSettings instance; credentials are never saved.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { verifyCurrentGateway } = require('./verify-current-remote-gateway.cjs');
const { createCadPlugins } = require('../packages/viewer-builtin/src/cad/service.cjs');
async function qualifyRemoteCad({
  settings,
  projectDir,
  directory,
  evidenceDir,
  chatId = randomUUID(),
  approved = false,
  onProgress = () => {},
}) {
  if (!approved) throw Error('Approve the synthetic CAD snapshot upload and execution first.');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const inputs = {
    recipe: {
      parameters: { L: 40, W: 20, T: 5, R: 2 },
      features: [
        { id: 'Plate', op: 'box', length: 'L', width: 'W', height: 'T' },
        { id: 'Drilled', op: 'hole', base: 'Plate', radius: 'R', height: 'T', origin: [10, 10, 0] },
      ],
      result: 'Drilled',
    },
    expect: { volume: 4000 - Math.PI * 4 * 5, solids: 1, bounds: [40, 20, 5] },
  };
  const save = (name, value) =>
    fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
    });
  // A retained attempt prevents accidental replay following an uncertain call.
  fs.writeFileSync(
    path.join(evidenceDir, 'attempt.json'),
    JSON.stringify({ chatId, inputs, startedAt: new Date().toISOString() }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  fs.writeFileSync(path.join(projectDir, 'recipe.json'), JSON.stringify(inputs, null, 2));
  try {
    const report = await verifyCurrentGateway({
      settings,
      projectDir,
      domain: 'cad',
      toolId: 'cad.freecad.build',
      inputs,
      files: ['recipe.json'],
      chatId,
      directory,
      approved: true,
      onProgress,
    });
    save('result.json', report);
    if (report.task?.requestId) {
      const receipt = JSON.parse(
        fs.readFileSync(
          path.join(settings.directory, 'remote-receipts', report.task.requestId + '.json'),
        ),
      );
      save('receipt.json', receipt);
    }
    assert.equal(
      report.result.action.status,
      'completed',
      report.result.action.diagnostics.join('\n'),
    );
    assert.equal(report.result.verification.status, 'passed', report.result.verification.reason);
    const plugin = createCadPlugins({ projectRoot: () => projectDir })[0];
    const previews = [];
    for (const artifact of report.result.artifacts.filter(item =>
      ['model.cad.fcstd', 'model.cad.step', 'model.cad.stl'].includes(item.kind),
    )) {
      const file = path.join(projectDir, artifact.relativePath);
      assert.equal(plugin.matches(file), true);
      const view = await plugin.open({
        file,
        artifact: { ...artifact, name: path.basename(file) },
      });
      assert.ok(view.data.triangles > 0);
      if (artifact.kind !== 'model.cad.stl') assert.ok(view.data.brep);
      previews.push({
        kind: artifact.kind,
        sha256: artifact.sha256,
        triangles: view.data.triangles,
        brep: Boolean(view.data.brep),
        bounds: view.data.bounds,
      });
    }
    assert.equal(previews.length, 3);
    save('preview-checks.json', previews);
    onProgress('cad-preview-passed', previews);
    return report;
  } catch (error) {
    save('failure.json', {
      message: error.message,
      code: error.code,
      task: settings.task(projectDir, 'cad', chatId),
    });
    throw error;
  } finally {
    let client;
    try {
      const binding = settings.project(projectDir, 'cad');
      const task = settings.task(projectDir, 'cad', chatId);
      const released = task?.sessionRelease;
      if (released?.status === 'released') {
        save('cleanup.json', { ...released, automatic: true });
        onProgress('cleanup', { ...released, automatic: true });
      } else if (
        binding.remoteProjectId &&
        (!task || (task.outcome === 'completed' && task.needsImport === false))
      ) {
        client = settings.sessionClient(projectDir, 'cad', chatId);
        const session = await client.currentSession();
        if (session?.id && !session.callLocked) {
          const stopped =
            session.status === 'stopped' ? session : await client.terminateSession(session.id);
          save('cleanup.json', { id: stopped.id, status: stopped.status });
          onProgress('cleanup', { id: stopped.id, status: stopped.status });
        }
      }
    } catch (error) {
      save('cleanup-error.json', { message: error.message, code: error.code });
    } finally {
      await client?.close();
    }
  }
}
module.exports = { qualifyRemoteCad };
