const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskService } = require('../../packages/harness-application/src/index.cjs');
const { runtimeTools } = require('../../packages/agent-kimi/src/runtime-tools.cjs');
const { createCadPlugins } = require('../../packages/viewer-builtin/src/cad/service.cjs');
const { createViewerRegistry } = require('../../packages/viewer-core/src/registry.cjs');
const { applicationTools } = require('../../packages/agent-kimi/src/application-tools.cjs');

if (!process.env.INDUSTRIAL_HARNESS_FREECAD_CMD)
  throw Error('Pinned native FreeCAD 1.1.4 is required.');
const recipe = {
  parameters: { W: 20 },
  features: [
    { id: 'Plate', op: 'sketch_pad', profile: 'rectangle', length: 40, width: 'W', height: 5 },
  ],
  result: 'Plate',
};

test(
  'shared TaskService → native FreeCAD build/edit/check → exact result opening → Registry; comparison and diagnostic selection',
  { timeout: 180000 },
  async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-results-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = { id: 'native-results', domain: 'cad', path: path.join(root, 'project') };
    fs.mkdirSync(project.path);
    const facts = [];
    class Kernel {
      constructor(_dir, getScope, _read, _detail, emit, _config, _factory, options) {
        Object.assign(this, { getScope, emit, options });
      }
      async run(task) {
        const tools = runtimeTools(
          this.options.industrialRuntime,
          this.getScope,
          async () => true,
          this.options.onIndustrialResult,
          { getApplicationContext: this.options.getApplicationContext },
        );
        const call = async (operation, inputs) => {
          const output = JSON.parse(
            (
              await tools
                .find(tool => tool.name === 'industrial_action_call')
                .handler({
                  toolId: `cad.freecad.${operation}`,
                  inputsJson: JSON.stringify(inputs),
                  expectedStateId: this.getScope().stateId,
                })
            ).output,
          );
          facts.push(output);
          assert.equal(output.actionStatus, 'completed', JSON.stringify(output));
          return output;
        };
        const fileOf = result =>
          result.artifactSet.find(artifact => artifact.kind === 'model.cad.fcstd').relativePath;
        if (task === 'generate then modify and check') {
          const first = await call('build', { recipe, expect: { bounds: [40, 20, 5] } });
          const second = await call('edit', {
            file: fileOf(first),
            changes: { parameters: { W: 30 } },
            expect: { bounds: [40, 30, 5] },
          });
          await call('inspect', { file: fileOf(second), expect: { bounds: [40, 30, 5] } });
        } else if (task === 'compare two FreeCAD designs') {
          await call('build', { recipe });
          await call('build', { recipe: { ...recipe, parameters: { W: 35 } } });
          const current = this.options.getApplicationContext().view();
          const models = current.groups.filter(group => group.previewArtifactId);
          const modelIds = models.map(group => group.id);
          assert.equal(models.length, 2);
          assert.ok(
            models.every(
              group =>
                group.verifications.length === 1 &&
                group.verifications[0].status === 'passed' &&
                group.verifications[0].inputStatus.status === 'unchecked',
            ),
            'inline recipe builds have no recorded project-file input hashes',
          );
          const select = applicationTools(this.options.getApplicationContext).find(
            tool => tool.name === 'select_result',
          );
          const request = { groupIds: modelIds, revision: current.revision };
          await assert.rejects(select.handler(request), /inputs changed or could not be checked/);
          const rejected = this.options.getApplicationContext().view();
          assert.equal(rejected.revision, current.revision);
          assert.deepEqual(rejected.selection, current.selection);
          // Compare the recorded designs explicitly without presenting their
          // historical verification as a check of current project inputs.
          await select.handler({ ...request, historical: true });
        } else {
          await call('inspect', { file: fileOf(facts[1]) });
          const current = this.options.getApplicationContext().view();
          const report = current.groups.find(group => group.title === 'Geometry inspection');
          this.options
            .getApplicationContext()
            .select({ groupIds: [report.id], revision: current.revision });
        }
        this.emit({ type: 'done', result: { status: 'completed' } });
      }
      async close() {}
    }
    const tasks = new TaskService({
      Session: Kernel,
      chatDirectory: path.join(root, 'chats'),
      resourceDirectory: path.join(root, 'resources'),
      runtimeOptions: { directory: path.join(root, 'state') },
      getConfig: () => ({}),
    });
    t.after(() => tasks.close());
    const chat = tasks.chats.create(project.path, project.domain),
      entry = tasks.resume(project, chat.id);
    async function run(task) {
      await tasks.prepare(entry, { task });
      return (await tasks.start(entry, task)).completion;
    }
    const result = await run('generate then modify and check');
    assert.equal(result.status, 'completed');
    assert.ok(facts.every(fact => fact.verification.status === 'passed'));
    const models = result.results.groups.filter(group => group.previewArtifactId);
    assert.equal(models.length, 2);
    assert.equal(models.filter(group => !group.superseded).length, 1);
    const model = models.find(group => !group.superseded);
    assert.equal(model.verifications.length, 2, 'build and exact-version inspection are linked');
    assert.equal(
      models.find(group => group.superseded).verifications.length,
      1,
      'later check must not attach to the previous version',
    );
    const request = {
      turnId: result.turnId,
      groupId: model.id,
      artifactId: model.primaryArtifactId,
    };
    const resolved = await tasks.openResult(entry, request);
    const registry = createViewerRegistry(createCadPlugins({ projectRoot: () => project.path }));
    assert.equal(registry.canAutoPreview(resolved.file), true);
    const opened = await registry.get(registry.match(resolved.file)).open(resolved);
    assert.equal(opened.kind, 'cad');
    assert.ok(opened.data.triangles >= 12);
    assert.ok(opened.data.brep);
    assert.ok(model.artifacts.some(artifact => artifact.kind === 'model.cad.step'));
    assert.ok(model.artifacts.some(artifact => artifact.kind === 'model.cad.stl'));
    const comparison = await run('compare two FreeCAD designs');
    assert.equal(
      comparison.status,
      'completed',
      JSON.stringify(
        tasks
          .history(project, entry.id)
          .turns.at(-1)
          .events.filter(event => event.type === 'error'),
      ),
    );
    assert.equal(comparison.results.selection.groupIds.length, 2);
    assert.equal(comparison.results.selection.historical, true);
    assert.ok(
      comparison.results.groups
        .filter(group => group.selected)
        .every(
          group =>
            group.historical &&
            group.verifications[0].status === 'passed' &&
            group.verifications[0].inputStatus.status === 'unchecked',
        ),
    );
    assert.equal(
      comparison.results.groups.filter(group => group.previewArtifactId && !group.superseded)
        .length,
      2,
    );
    const diagnostic = await run('FreeCAD diagnostic report only');
    assert.equal(
      diagnostic.results.groups.find(group => group.selected).title,
      'Geometry inspection',
    );
    const brep = resolved.companions.find(item => item.artifact.kind === 'display.cad.brep');
    fs.appendFileSync(brep.file, '\nchanged');
    await assert.rejects(tasks.openResult(entry, request), /changed/);
    assert.equal(
      (await tasks.openResult(entry, { ...request, revealOnly: true })).artifact.id,
      model.primaryArtifactId,
      'the valid native file remains available when a preview companion changes',
    );
    assert.equal(
      entry.runtimeBundle.runtime.get('verification', facts[1].verification.id).status,
      'passed',
      'presentation never rewrites canonical evidence',
    );
  },
);
