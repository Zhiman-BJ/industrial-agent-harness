const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { IndustrialRuntime, createWorkspacePlugin } = require('../src/index.cjs');
const { hash } = require('../src/workspace-files.cjs');
const { createInputIndexer } = require('../src/workspace-files.cjs');
function open(t, domain = 'example') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-workspace-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const plugin = createWorkspacePlugin({
    domain,
    protectedPaths: [path.join(project, 'private-state')],
  });
  const runtime = new IndustrialRuntime(project, domain, {
    directory: path.join(directory, 'state'),
    ...plugin,
  });
  t.after(() => {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const execute = async (toolId, inputs, approval = true, override = {}) => {
    const state = await runtime.inspect();
    return runtime.execute(
      { toolId, inputs, expectedStateId: state.id, ...override },
      {
        approval,
        scope: {
          domain,
          projectId: state.projectId,
          stateId: state.id,
          tools: runtime.descriptors().map(t => t.id),
        },
      },
    );
  };
  return { project, runtime, execute };
}

test('unrelated large assets and symlinks do not prevent inspection or repair; selected task inputs remain checked', async t => {
  const { project, runtime, execute } = open(t);
  fs.writeFileSync(path.join(project, 'runner.cjs'), 'process.exit(0)');
  const fd = fs.openSync(path.join(project, 'unused.bin'), 'w');
  fs.ftruncateSync(fd, 65 * 1024 * 1024);
  fs.closeSync(fd);
  if (process.platform !== 'win32') fs.symlinkSync('runner.cjs', path.join(project, 'unused-link'));
  const state = await runtime.inspect();
  assert.equal(state.inputHashes['runner.cjs'], hash(Buffer.from('process.exit(0)')));
  assert.equal(state.inputHashes['unused.bin'], undefined);
  const listed = await execute('project.files.read', {});
  const report = JSON.parse(runtime.readArtifact(listed.artifacts[0].id).content);
  assert.ok(report.diagnostics.some(d => d.includes('unused.bin')));
  assert.equal(
    (
      await execute('project.files.apply', {
        changes: [{ path: 'new.txt', content: 'repair', expectedSha256: null }],
      })
    ).action.status,
    'completed',
  );
  fs.writeFileSync(
    path.join(project, 'harness.tasks.json'),
    JSON.stringify({
      schemaVersion: '1',
      tasks: {
        bad: { command: ['node', '{input}/runner.cjs'], inputs: ['unused.bin'] },
      },
    }),
  );
  const failed = await execute('project.task.run', { task: 'bad' });
  assert.equal(failed.action.status, 'failed');
  assert.notEqual(failed.verification.status, 'passed');
  assert.match(failed.action.diagnostics.join(), /bounded read/);
});

test('workspace input/ignore policy stays deterministic and never hides declared task inputs or control files', async t => {
  const { project, runtime } = open(t);
  for (const name of ['src/main', 'tests/check', 'assets/ignored']) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), name);
  }
  fs.writeFileSync(
    path.join(project, 'harness.tasks.json'),
    JSON.stringify({
      schemaVersion: '1',
      workspace: { inputs: ['src'], ignore: ['tests', 'assets', 'harness.tasks.json'] },
      tasks: { test: { command: ['node'], inputs: ['tests/check'] } },
    }),
  );
  const before = await runtime.inspect();
  assert.deepEqual(Object.keys(before.inputHashes).sort(), [
    'harness.tasks.json',
    'src/main',
    'tests/check',
  ]);
  fs.writeFileSync(path.join(project, 'assets/ignored'), 'changed');
  assert.equal((await runtime.inspect()).id, before.id);
  fs.writeFileSync(path.join(project, 'tests/check'), 'changed');
  assert.notEqual((await runtime.inspect()).id, before.id);
});

test('incremental hashing catches same-size edits even when mtime is restored, removals and additions', async t => {
  const { project } = open(t),
    indexer = createInputIndexer(),
    file = path.join(project, 'source');
  fs.writeFileSync(file, 'before');
  const before = await indexer.index(project),
    stat = fs.statSync(file);
  assert.deepEqual(await indexer.index(project), before);
  fs.writeFileSync(file, 'after!');
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal((await indexer.index(project)).source, hash(Buffer.from('after!')));
  fs.unlinkSync(file);
  fs.writeFileSync(path.join(project, 'new'), 'new');
  assert.deepEqual(await indexer.index(project), { new: hash(Buffer.from('new')) });
});

test('invalid input policy remains inspectable and repairable', async t => {
  const { project, execute, runtime } = open(t);
  const content = JSON.stringify({
    schemaVersion: '1',
    workspace: { ignore: ['../outside'] },
    tasks: {},
  });
  fs.writeFileSync(path.join(project, 'harness.tasks.json'), content);
  const inspection = await execute('project.tasks.inspect', {});
  assert.match(
    JSON.parse(runtime.readArtifact(inspection.artifacts[0].id).content).error,
    /project-relative/,
  );
  assert.equal(
    (
      await execute('project.files.apply', {
        changes: [
          {
            path: 'harness.tasks.json',
            content: '{"schemaVersion":"1","tasks":{}}',
            expectedSha256: hash(Buffer.from(content)),
          },
        ],
      })
    ).action.status,
    'completed',
  );
});

test('approval previews show real file differences and declared task commands, without mutating files', async t => {
  const { project, runtime } = open(t);
  fs.writeFileSync(path.join(project, 'main.cjs'), 'old\nunchanged\n');
  const state = await runtime.inspect(),
    request = {
      toolId: 'project.files.apply',
      expectedStateId: state.id,
      inputs: {
        changes: [
          {
            path: 'main.cjs',
            content: 'new\nunchanged\n',
            expectedSha256: state.inputHashes['main.cjs'],
          },
          { path: 'new.cjs', content: 'new', expectedSha256: null },
        ],
      },
    };
  const preview = runtime.approvalPreview(request);
  assert.match(preview.text, /Modify main.cjs/);
  assert.match(preview.text, /Create new.cjs/);
  assert.match(preview.text, /-old\n\+new/);
  assert.match(preview.requestSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(
    runtime.approvalPreview({
      ...request,
      inputs: { ...request.inputs, changes: [request.inputs.changes[0]] },
    }).requestSha256,
    preview.requestSha256,
  );
  assert.equal(fs.readFileSync(path.join(project, 'main.cjs'), 'utf8'), 'old\nunchanged\n');
  assert.equal(fs.existsSync(path.join(project, 'new.cjs')), false);
  fs.writeFileSync(
    path.join(project, 'harness.tasks.json'),
    JSON.stringify({
      schemaVersion: '1',
      tasks: {
        test: { command: ['python3', '{input}/check.py'], inputs: ['check.py'] },
      },
    }),
  );
  assert.match(
    runtime.approvalPreview({
      toolId: 'project.task.run',
      expectedStateId: state.id,
      inputs: { task: 'test' },
    }).text,
    /python3/,
  );
});
test('same initialization and file lifecycle works in unrelated domains and retains immutable history', async t => {
  for (const domain of ['example', 'another']) {
    const { project, runtime, execute } = open(t, domain);
    const initialized = await execute('project.initialize', { name: 'new design' });
    assert.equal(initialized.action.status, 'completed');
    assert.equal(initialized.verification.status, 'not_run');
    assert.equal(initialized.state.stage, null);
    assert.equal(initialized.state.status, 'unverified');
    assert.equal(
      (await execute('project.initialize', { name: 'overwrite' })).action.status,
      'failed',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(project, 'harness.project.json'))).name,
      'new design',
    );
    const created = await execute('project.files.apply', {
      changes: [{ path: 'src/design.txt', content: 'first', expectedSha256: null }],
    });
    assert.equal(created.action.status, 'completed');
    const read = await execute('project.files.read', { path: 'src/design.txt' });
    const report = JSON.parse(runtime.readArtifact(read.artifacts[0].id).content);
    assert.equal(report.content, 'first');
    assert.equal(report.sha256, hash(Buffer.from('first')));
    const rejected = await execute('project.files.apply', {
      changes: [{ path: 'src/design.txt', content: 'bad', expectedSha256: null }],
    });
    assert.equal(rejected.action.status, 'failed');
    assert.match(rejected.action.diagnostics.join(), /precondition/);
    const edited = await execute('project.files.apply', {
      changes: [{ path: 'src/design.txt', content: 'second', expectedSha256: report.sha256 }],
    });
    assert.equal(edited.action.status, 'completed');
    assert.notEqual(edited.state.id, created.state.id);
    assert.equal(JSON.parse(runtime.readArtifact(read.artifacts[0].id).content).content, 'first');
    assert.ok(runtime.listCheckpoints().some(c => c.id === created.checkpoint.id));
    assert.equal(
      (
        await execute('project.files.apply', {
          changes: [
            { path: 'src/design.txt', content: null, expectedSha256: hash(Buffer.from('second')) },
          ],
        })
      ).action.status,
      'completed',
    );
    assert.equal(fs.existsSync(path.join(project, 'src/design.txt')), false);
  }
});
test('approval, scope and all batch preconditions are checked before any file write', async t => {
  const { project, execute } = open(t);
  const edit = { changes: [{ path: 'src/a', content: 'a', expectedSha256: null }] };
  assert.equal((await execute('project.files.apply', edit, false)).action.status, 'failed');
  assert.equal(fs.existsSync(path.join(project, 'src')), false);
  const invalid = {
    changes: [...edit.changes, { path: 'missing', content: 'x', expectedSha256: 'a'.repeat(64) }],
  };
  assert.equal((await execute('project.files.apply', invalid)).action.status, 'failed');
  assert.equal(fs.existsSync(path.join(project, 'src')), false);
  for (const name of [
    '../escape',
    '.git/config',
    '.harness-runs/fake',
    'node_modules/pkg',
    'private-state/fact',
  ]) {
    const result = await execute('project.files.apply', {
      changes: [{ path: name, content: 'bad', expectedSha256: null }],
    });
    assert.equal(result.action.status, 'failed', name);
    assert.equal(result.artifacts.length, 0);
  }
});
test('input mutations make accepted evidence stale rather than replacing it with file-write acceptance', async t => {
  const { project, runtime, execute } = open(t);
  await execute('project.files.apply', {
    changes: [{ path: 'source', content: 'one', expectedSha256: null }],
  });
  const before = await runtime.inspect();
  const verified = {
    ...before,
    id: require('node:crypto').randomUUID(),
    status: 'verified',
    verificationIds: [require('node:crypto').randomUUID()],
  };
  runtime.put('state', verified.id, verified);
  runtime.setMetadata('head_state', verified.id);
  const edit = await execute('project.files.apply', {
    changes: [{ path: 'source', content: 'two', expectedSha256: before.inputHashes.source }],
  });
  assert.equal(edit.state.status, 'stale');
  assert.deepEqual(edit.state.verificationIds, verified.verificationIds);
  assert.equal(edit.verification.status, 'not_run');
  assert.equal(runtime.get('state', verified.id).status, 'verified');
});
test('partial staging failures preserve original files and rollback prior edits in the batch', async t => {
  const { project, execute, runtime } = open(t);
  const large = 'one'.repeat(200000);
  fs.writeFileSync(path.join(project, 'first'), large, { mode: 0o600 });
  fs.writeFileSync(path.join(project, 'second'), 'two', { mode: 0o600 });
  const original = fs.writeFileSync;
  for (const failAt of [1, 2]) {
    let writes = 0;
    fs.writeFileSync = (file, ...args) => {
      if (typeof file === 'number' && ++writes === failAt) {
        original(file, 'partial');
        throw Error('Controlled partial staging failure');
      }
      return original(file, ...args);
    };
    let failed;
    try {
      failed = await execute('project.files.apply', {
        changes: [
          {
            path: 'first',
            content: 'new first'.repeat(100000),
            expectedSha256: hash(Buffer.from(large)),
          },
          { path: 'second', content: 'new second', expectedSha256: hash(Buffer.from('two')) },
        ],
      });
    } finally {
      fs.writeFileSync = original;
    }
    assert.equal(failed.action.status, 'failed');
    assert.equal(failed.verification.status, 'insufficient_evidence');
    assert.equal(fs.readFileSync(path.join(project, 'first'), 'utf8'), large);
    assert.equal(fs.readFileSync(path.join(project, 'second'), 'utf8'), 'two');
    assert.ok(!fs.readdirSync(project).some(name => name.startsWith('.harness-edit-')));
    assert.equal((await runtime.inspect()).inputHashes.first, hash(Buffer.from(large)));
  }
});
test('symlink, hard-link and reserved output-kind inputs are refused', async t => {
  const { project, execute } = open(t);
  // The file boundary independently refuses the path, including before inspection.
  const { projectFile } = require('../src/workspace-files.cjs');
  if (process.platform !== 'win32') {
    fs.symlinkSync(os.tmpdir(), path.join(project, 'link'));
    assert.throws(() => projectFile(project, 'link/out'), /symlink/);
    fs.unlinkSync(path.join(project, 'link'));
  }
  fs.writeFileSync(path.join(project, 'a'), 'x');
  fs.linkSync(path.join(project, 'a'), path.join(project, 'b'));
  assert.throws(() => projectFile(project, 'a'), /Hard-linked/);
  const { ProjectTaskManifestSchema } = require('@industrial-agent-harness/contracts');
  assert.equal(
    ProjectTaskManifestSchema.safeParse({
      schemaVersion: '1',
      tasks: {
        test: {
          command: ['node'],
          inputs: ['a'],
          outputs: [{ path: 'fake', kind: 'report.task-checks' }],
        },
      },
    }).success,
    false,
  );
});

test('Pack input boundary ignores changing derived evidence and retains design dependencies', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-input-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [
    'design.kicad_pcb',
    'session/receipt.json',
    '.pcb/reports/status.json',
    '.pcb/libraries/custom.lib',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), name);
  }
  const indexer = createInputIndexer({ ignore: ['session', '.pcb/reports'] });
  const first = await indexer.index(root);
  assert.deepEqual(Object.keys(first).sort(), ['.pcb/libraries/custom.lib', 'design.kicad_pcb']);
  fs.writeFileSync(path.join(root, 'session/new-receipt.json'), 'read-only status evidence');
  fs.writeFileSync(path.join(root, '.pcb/reports/status.json'), 'new observation');
  assert.deepEqual(await indexer.index(root), first);
  fs.writeFileSync(path.join(root, '.pcb/libraries/custom.lib'), 'changed design dependency');
  assert.notDeepEqual(await indexer.index(root), first);
  await assert.rejects(createInputIndexer({ ignore: ['../escape'] }).index(root));
});

test('protected file batches can replace and delete existing native source files above 256KiB', t => {
  const { project } = open(t);
  const { applyFiles } = require('../src/workspace-files.cjs');
  const before = 'a'.repeat(1024 * 1024),
    after = 'b'.repeat(2 * 1024 * 1024);
  fs.writeFileSync(path.join(project, 'large.dxf'), before);
  applyFiles(project, [
    { path: 'large.dxf', content: after, expectedSha256: hash(Buffer.from(before)) },
  ]);
  assert.equal(fs.readFileSync(path.join(project, 'large.dxf'), 'utf8'), after);
  assert.throws(
    () =>
      applyFiles(project, [
        { path: 'large.dxf', content: 'stale', expectedSha256: hash(Buffer.from(before)) },
      ]),
    /stale/,
  );
  applyFiles(project, [
    { path: 'large.dxf', content: null, expectedSha256: hash(Buffer.from(after)) },
  ]);
  assert.equal(fs.existsSync(path.join(project, 'large.dxf')), false);
});
