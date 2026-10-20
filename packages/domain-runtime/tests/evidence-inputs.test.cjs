const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  IndustrialRuntime,
  createWorkspacePlugin,
  createEvidenceInspector,
} = require('../src/index.cjs');
const { bindSnapshotResult, hasSnapshotBinding } = require('../src/evidence-inputs.cjs');
const { hash, applyFiles } = require('../src/workspace-files.cjs');

function project(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-inputs-'));
  const projectDir = path.join(directory, 'project');
  fs.mkdirSync(projectDir);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, projectDir };
}

test('read-only observations detect native same-size edits, deletion and unsafe inputs without trusting mtime', t => {
  const { projectDir } = project(t);
  const file = path.join(projectDir, 'source');
  fs.writeFileSync(file, 'before');
  const inputHashes = { source: hash('before') };
  const stat = fs.statSync(file);
  assert.equal(createEvidenceInspector(projectDir)(inputHashes).status, 'matches');
  fs.writeFileSync(file, 'after!');
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.deepEqual(createEvidenceInspector(projectDir)(inputHashes), {
    status: 'changed',
    changedPaths: ['source'],
  });
  fs.unlinkSync(file);
  assert.equal(createEvidenceInspector(projectDir)(inputHashes).status, 'changed');
  fs.mkdirSync(file);
  assert.equal(createEvidenceInspector(projectDir)(inputHashes).status, 'unavailable');
  assert.equal(
    createEvidenceInspector(projectDir)({ '../outside': hash('x') }).status,
    'unavailable',
  );
  assert.equal(createEvidenceInspector(projectDir)({}).status, 'unchecked');
  fs.rmdirSync(file);
  fs.writeFileSync(file, 'before');
  fs.linkSync(file, path.join(projectDir, 'alias'));
  assert.equal(createEvidenceInspector(projectDir)(inputHashes).status, 'unavailable');
  fs.unlinkSync(path.join(projectDir, 'alias'));
  const fd = fs.openSync(path.join(projectDir, 'large'), 'w');
  fs.ftruncateSync(fd, 65 * 1024 * 1024);
  fs.closeSync(fd);
  assert.equal(createEvidenceInspector(projectDir)({ large: hash('x') }).status, 'unavailable');
});

test('only an action-bound captured snapshot preserves a historical verdict when live inputs change during work', async t => {
  const { projectDir, directory } = project(t);
  const file = path.join(projectDir, 'source');
  for (const binding of ['snapshot', 'live', 'forged', 'other-action']) {
    fs.writeFileSync(file, 'before');
    const runtime = new IndustrialRuntime(projectDir, 'example', {
      directory: path.join(directory, binding),
      stateProvider: async () => ({
        stage: null,
        inputHashes: { source: hash(fs.readFileSync(file)) },
      }),
      tools: [
        {
          descriptor: {
            schemaVersion: '1',
            id: 'fixture.check',
            version: '1',
            risk: 'mutating',
            verification: ['fixture'],
          },
          execute: ({ action }) => {
            const captured = fs.readFileSync(file);
            const result = {
              executionSucceeded: true,
              artifacts: [],
              captured,
              inputBinding: 'snapshot',
            };
            if (binding === 'snapshot') bindSnapshotResult(result, action);
            if (binding === 'other-action') bindSnapshotResult(result, { ...action, id: 'other' });
            assert.equal(hasSnapshotBinding(result, action), binding === 'snapshot');
            fs.writeFileSync(file, 'after!');
            return result;
          },
        },
      ],
      verifiers: {
        fixture: ({ result }) => ({
          status: result.captured.equals(Buffer.from('before')) ? 'passed' : 'failed',
          reason: 'Captured-byte fixture',
          metrics: {},
        }),
      },
    });
    try {
      const state = await runtime.inspect();
      const result = await runtime.execute(
        { toolId: 'fixture.check', inputs: {}, expectedStateId: state.id },
        {
          approval: true,
          scope: {
            domain: 'example',
            projectId: state.projectId,
            stateId: state.id,
            tools: ['fixture.check'],
          },
        },
      );
      assert.equal(result.action.status, 'completed');
      assert.equal(
        result.verification.status,
        binding === 'snapshot' ? 'passed' : 'insufficient_evidence',
      );
      assert.equal(result.action.inputBinding, binding === 'snapshot' ? 'snapshot' : undefined);
      assert.equal(result.state.status, 'stale');
      assert.equal(
        runtime.get('verification', result.verification.id).evidence.inputHashes.source,
        hash('before'),
      );
      assert.equal(
        createEvidenceInspector(projectDir)(result.verification.evidence.inputHashes).status,
        'changed',
      );
    } finally {
      runtime.close();
    }
  }
});

test('task declaration changes after inspection are rejected before creating execution directories', async t => {
  const { projectDir } = project(t);
  const file = path.join(projectDir, 'harness.tasks.json');
  const content = JSON.stringify({
    schemaVersion: '1',
    tasks: { check: { command: ['node'], inputs: [] } },
  });
  fs.writeFileSync(file, content);
  const plugin = createWorkspacePlugin({ domain: 'example' });
  const state = await plugin.stateProvider({ projectDir });
  fs.writeFileSync(file, content.replace('node', 'another-executable'));
  await assert.rejects(
    plugin.tools
      .find(tool => tool.descriptor.id === 'project.task.run')
      .execute({
        projectDir,
        state,
        action: { id: 'not-started' },
        inputs: { task: 'check' },
      }),
    /declaration differs/,
  );
  assert.equal(fs.existsSync(path.join(projectDir, '.harness-runs')), false);
});

test('late write conflicts abort the batch and rollback preserves intervening external edits', t => {
  const { projectDir } = project(t);
  const first = path.join(projectDir, 'first'),
    second = path.join(projectDir, 'second');
  fs.writeFileSync(first, 'one');
  fs.writeFileSync(second, 'two');
  const write = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'number' && ++writes === 2) {
      write(first, 'external-first');
      write(second, 'external-second');
    }
    return write(file, ...args);
  };
  try {
    assert.throws(
      () =>
        applyFiles(projectDir, [
          { path: 'first', content: 'ours-one', expectedSha256: hash('one') },
          { path: 'second', content: 'ours-two', expectedSha256: hash('two') },
        ]),
      /changed before writing/,
    );
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(fs.readFileSync(first, 'utf8'), 'external-first');
  assert.equal(fs.readFileSync(second, 'utf8'), 'external-second');
  assert.ok(!fs.readdirSync(projectDir).some(name => name.startsWith('.harness-edit-')));
});

test('the workspace adapter detects a changed captured copy even when live inputs still match', async t => {
  const { projectDir } = project(t);
  fs.writeFileSync(path.join(projectDir, 'source'), 'before');
  fs.writeFileSync(
    path.join(projectDir, 'harness.tasks.json'),
    JSON.stringify({
      schemaVersion: '1',
      tasks: {
        check: { command: [path.join(projectDir, 'missing-executable')], inputs: ['source'] },
      },
    }),
  );
  const plugin = createWorkspacePlugin({ domain: 'example' });
  const state = await plugin.stateProvider({ projectDir });
  const action = { id: require('node:crypto').randomUUID(), inputHashes: state.inputHashes };
  const copy = path.join(projectDir, '.harness-runs', action.id, 'input', 'source');
  // The missing executable deliberately avoids needing OS isolation here.
  // Corrupt the captured file at the adapter's execution/collection boundary.
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('execution.json')) {
      fs.chmodSync(copy, 0o600);
      write(copy, 'tampered');
    }
    return write(file, ...args);
  };
  let result;
  try {
    result = await plugin.tools
      .find(tool => tool.descriptor.id === 'project.task.run')
      .execute({
        projectDir,
        state,
        action,
        inputs: { task: 'check' },
      });
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(fs.readFileSync(path.join(projectDir, 'source'), 'utf8'), 'before');
  assert.equal(result.inputSnapshotChanged, true);
  assert.equal(hasSnapshotBinding(result, action), false);
  assert.match(result.diagnostics.join(), /Captured task input changed/);
  assert.equal(plugin.verifiers['project.task.checks']({ result }).status, 'insufficient_evidence');
});
