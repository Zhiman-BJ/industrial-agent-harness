const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
const { createProjectRuntime } = require('../../packages/harness-core/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const scenario = require('./fixtures/workspace-scenario.cjs');
const execute = promisify(execFile),
  root = path.resolve(__dirname, '../..');
function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-workspace-native-')),
    project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const bundle = createProjectRuntime({
    projectDir: project,
    domain: 'example',
    directory: path.join(directory, 'state'),
    registry: { runtimePacks: [] },
    environment: { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config') },
  });
  t.after(() => {
    bundle.runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const run = async (toolId, inputs, approval = true) => {
    const state = await bundle.runtime.inspect(),
      scope = resolveFromState({ task: 'create and test', state }, bundle.capabilities).scope;
    return bundle.runtime.execute(
      { toolId, inputs, expectedStateId: state.id },
      { scope, approval },
    );
  };
  return { directory, project, bundle, run };
}
test('real protected local task: empty project → create → pass → edit → stale → fail → repair → pass; historical artifacts survive', async t => {
  const { project, bundle, run } = workspace(t);
  await run('project.initialize', { name: 'native' });
  assert.equal(
    (await run('project.files.apply', scenario.files(project))).action.status,
    'completed',
  );
  const passed = await run('project.task.run', { task: 'test' });
  assert.equal(passed.verification.status, 'passed', JSON.stringify(passed));
  assert.equal(passed.state.status, 'verified');
  const report = passed.artifacts.find(a => a.kind === 'report.task-checks');
  const original = bundle.runtime.readArtifact(report.id).content;
  const changed = await run('project.files.apply', {
    changes: [
      {
        path: 'src/calculate.cjs',
        content: scenario.broken,
        expectedSha256: scenario.hash(scenario.source),
      },
    ],
  });
  assert.equal(changed.state.status, 'stale');
  const failed = await run('project.task.run', { task: 'test' });
  assert.equal(failed.verification.status, 'failed');
  assert.equal(failed.state.status, 'failed');
  await run('project.files.apply', {
    changes: [
      {
        path: 'src/calculate.cjs',
        content: scenario.source,
        expectedSha256: scenario.hash(scenario.broken),
      },
    ],
  });
  assert.equal((await run('project.task.run', { task: 'test' })).verification.status, 'passed');
  assert.deepEqual(bundle.runtime.readArtifact(report.id).content, original);
  assert.ok(
    bundle.runtime
      .listCheckpoints()
      .some(c => c.id === passed.checkpoint.id && c.state.status === 'verified'),
  );
});
test('real task cannot write source, runtime evidence, input snapshots or contact host sockets; no inherited credentials', async t => {
  const { project, bundle, run } = workspace(t);
  const stateFile = bundle.runtime.file;
  const script = `const fs=require('node:fs'),path=require('node:path');
    const paths=${JSON.stringify([path.join(fs.realpathSync(project), 'src/probe.cjs'), stateFile])};
    paths.push(path.join(process.env.HARNESS_INPUT_DIR,'src/probe.cjs'));
    const denied=paths.every(file=>{try{fs.writeFileSync(file,'bypass');return false}catch{return true}});
    const clean=!Object.keys(process.env).some(name=>/token|api.?key|password|secret/i.test(name));
    fs.writeFileSync(path.join(process.env.HARNESS_OUTPUT_DIR,'checks.json'),JSON.stringify({schemaVersion:'1',checks:[{name:'write boundaries',passed:denied},{name:'credentials',passed:clean}]}));`;
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src/probe.cjs'), script);
  fs.writeFileSync(
    path.join(project, 'harness.tasks.json'),
    JSON.stringify({
      schemaVersion: '1',
      tasks: {
        test: {
          command: [process.execPath, '{input}/src/probe.cjs'],
          inputs: ['src/probe.cjs'],
          verification: { kind: 'checks-json', path: 'checks.json' },
        },
      },
    }),
  );
  const result = await run('project.task.run', { task: 'test' });
  assert.equal(result.verification.status, 'passed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(project, 'src/probe.cjs'), 'utf8'), script);
});

test('real local task reads only its snapshot, runtime libraries and explicitly granted dependency directories', async t => {
  const { directory, project, bundle, run } = workspace(t);
  const dependencies = path.join(directory, 'dependencies'),
    outside = path.join(directory, 'private.txt');
  fs.mkdirSync(dependencies);
  fs.writeFileSync(path.join(dependencies, 'reference.txt'), 'DECLARED_REFERENCE');
  fs.writeFileSync(outside, 'UNDECLARED_PRIVATE');
  fs.writeFileSync(path.join(project, 'unselected.txt'), 'UNSELECTED_SOURCE');
  for (const granted of [false, true]) {
    fs.writeFileSync(
      path.join(project, 'probe.cjs'),
      `const fs=require('node:fs'),path=require('node:path');
      function readable(file){try{fs.readFileSync(file);return true}catch{return false}}
      const checks=[{name:'outside input denied',passed:!readable(${JSON.stringify(outside)})},
        {name:'outside input alias denied',passed:!readable(${JSON.stringify(process.platform === 'darwin' ? '/System/Volumes/Data' + outside : outside)})},
        {name:'unselected source denied',passed:!readable(${JSON.stringify(path.join(project, 'unselected.txt'))})},
        {name:'snapshot readable',passed:readable(__filename)},
        {name:'explicit dependency grant',passed:readable(${JSON.stringify(path.join(dependencies, 'reference.txt'))})===${granted}}];
      fs.writeFileSync(path.join(process.env.HARNESS_OUTPUT_DIR,'checks.json'),JSON.stringify({schemaVersion:'1',checks}));`,
    );
    fs.writeFileSync(
      path.join(project, 'harness.tasks.json'),
      JSON.stringify({
        schemaVersion: '1',
        tasks: {
          test: {
            command: [process.execPath, '{input}/probe.cjs'],
            inputs: ['probe.cjs'],
            runtime: { kind: 'local', ...(granted ? { readOnlyDirs: [dependencies] } : {}) },
            verification: { kind: 'checks-json', path: 'checks.json' },
          },
        },
      }),
    );
    const result = await run('project.task.run', { task: 'test' });
    assert.equal(result.verification.status, 'passed', JSON.stringify(result));
    const execution = JSON.parse(
      bundle.runtime.readArtifact(result.artifacts.find(a => a.kind === 'report.execution').id)
        .content,
    );
    assert.equal(execution.identity.readOnlyRoots.includes(fs.realpathSync(dependencies)), granted);
  }
});
test('exit zero, stale reports and malformed reports do not become acceptance; timeout retains execution evidence', async t => {
  const { project, bundle, run } = workspace(t);
  fs.writeFileSync(path.join(project, 'runner.cjs'), 'process.exit(0)');
  for (const mode of ['no-verifier', 'missing', 'malformed', 'timeout']) {
    const content =
      mode === 'timeout'
        ? 'setInterval(()=>{},1000)'
        : mode === 'malformed'
          ? "require('node:fs').writeFileSync(require('node:path').join(process.env.HARNESS_OUTPUT_DIR,'checks.json'),'{}')"
          : 'process.exit(0)';
    fs.writeFileSync(path.join(project, 'runner.cjs'), content);
    fs.writeFileSync(
      path.join(project, 'harness.tasks.json'),
      JSON.stringify({
        schemaVersion: '1',
        tasks: {
          test: {
            command: [process.execPath, '{input}/runner.cjs'],
            inputs: ['runner.cjs'],
            timeoutMs: mode === 'timeout' ? 200 : 10000,
            ...(mode === 'no-verifier'
              ? {}
              : { verification: { kind: 'checks-json', path: 'checks.json' } }),
          },
        },
      }),
    );
    const result = await run('project.task.run', { task: 'test' });
    assert.equal(
      result.verification.status,
      mode === 'no-verifier' ? 'not_run' : 'insufficient_evidence',
      JSON.stringify(result),
    );
    assert.notEqual(result.state.status, 'verified');
    assert.ok(result.artifacts.some(a => a.kind === 'log.task'));
    const report = result.artifacts.find(a => a.kind === 'report.execution');
    assert.equal(
      JSON.parse(bundle.runtime.readArtifact(report.id).content).status,
      mode === 'timeout' ? 'TIMEOUT' : 'COMPLETED',
    );
  }
});
test(
  'real Runtime deadline, cancellation and normal parent exit clean up the owned task process group',
  { timeout: 20000 },
  async t => {
    const { project, bundle, run } = workspace(t);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const alive = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    for (const mode of ['timeout', 'cancel', 'exit']) {
      const marker = path.join(project, 'owned-task-' + mode);
      fs.writeFileSync(
        path.join(project, 'runner.cjs'),
        `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
      const child=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)',process.argv[2]],{stdio:'inherit'});
      fs.writeFileSync(path.join(process.env.HARNESS_OUTPUT_DIR,'ready.json'),JSON.stringify({parent:process.pid,child:child.pid}));
      ${mode === 'exit' ? "setInterval(()=>{if(fs.existsSync(path.join(process.env.HARNESS_OUTPUT_DIR,'release')))process.exit(0)},10)" : 'setInterval(()=>{},1000)'};`,
      );
      fs.writeFileSync(
        path.join(project, 'harness.tasks.json'),
        JSON.stringify({
          schemaVersion: '1',
          tasks: {
            test: {
              command: [process.execPath, '{input}/runner.cjs', marker],
              inputs: ['runner.cjs'],
              timeoutMs: mode === 'timeout' ? 3000 : 5000,
            },
          },
        }),
      );
      const pending = run('project.task.run', { task: 'test' });
      let ready, readyFile;
      const deadline = Date.now() + 5000;
      while (!ready && Date.now() < deadline) {
        const action = bundle.runtime.listActions().find(action => action.status === 'running');
        readyFile = action && path.join(project, '.harness-runs', action.id, 'work', 'ready.json');
        if (readyFile && fs.existsSync(readyFile)) ready = JSON.parse(fs.readFileSync(readyFile));
        else await sleep(10);
      }
      assert.ok(ready, 'Actual task process must report readiness before cancellation.');
      let hostPids = Object.values(ready);
      if (process.platform === 'linux') {
        // The task reports PIDs from its private namespace. Resolve only its
        // marker-bound parent/child to host PIDs before testing process cleanup.
        hostPids = fs
          .readdirSync('/proc')
          .filter(name => /^\d+$/.test(name))
          .flatMap(name => {
            try {
              const command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
              if (!command.includes(marker)) return [];
              const status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
              const namespace = status
                .match(/^NSpid:\s+(.+)$/m)?.[1]
                .trim()
                .split(/\s+/)
                .map(Number);
              return namespace?.length > 1 && Object.values(ready).includes(namespace.at(-1))
                ? [Number(name)]
                : [];
            } catch {
              return [];
            }
          });
        assert.equal(
          hostPids.length,
          2,
          'Both owned namespace processes must map to actual host PIDs.',
        );
      }
      if (mode === 'cancel') bundle.runtime.cancel();
      else if (mode === 'exit')
        fs.writeFileSync(path.join(path.dirname(readyFile), 'release'), 'exit');
      const result = await pending;
      await bundle.runtime.waitForIdle();
      assert.equal(result.action.status, mode === 'exit' ? 'completed' : 'failed');
      assert.equal(
        bundle.runtime.listActions().find(action => action.id === result.action.id).status,
        result.action.status,
      );
      const report = JSON.parse(
        bundle.runtime.readArtifact(result.artifacts.find(a => a.kind === 'report.execution').id)
          .content,
      );
      assert.equal(
        report.status,
        { timeout: 'TIMEOUT', cancel: 'CANCELLED', exit: 'COMPLETED' }[mode],
      );
      const reaped = Date.now() + 3000;
      while (hostPids.some(alive) && Date.now() < reaped) await sleep(20);
      assert.deepEqual(
        hostPids.filter(alive),
        [],
        'Owned parent and background child must be gone.',
      );
    }
  },
);
for (const domain of ['chip', 'pcb'])
  test(
    `real packaged-compatible CLI + pinned Kimi bootstraps and repairs an empty ${domain} project through the same shared Tools`,
    { timeout: 90000 },
    async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-workspace-cli-')),
        project = path.join(directory, 'project');
      fs.mkdirSync(project);
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const model = await startModel({
        calls: scenario.modelCalls(project),
        success: 'SHARED_LIFECYCLE_COMPLETE',
      });
      t.after(model.close);
      const kimi =
        process.env.KIMI_EXECUTABLE ||
        createRequire(
          fs.realpathSync(
            process.env.INDUSTRIAL_HARNESS_TEST_CLI || path.join(root, 'apps/cli/src/main.cjs'),
          ),
        )('@industrial-agent-harness/agent-kimi').bundledExecutable();
      assert.ok(fs.existsSync(kimi));
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          process.env.INDUSTRIAL_HARNESS_TEST_CLI || path.join(root, 'apps/cli/src/main.cjs'),
          'run',
          '--project-dir',
          project,
          '--domain',
          domain,
          '--task',
          'Create a project and test; repair failed checks',
          '--approval',
          'approve',
          '--provider',
          'openai_legacy',
          '--endpoint',
          model.endpoint,
          '--model',
          'controlled-workspace',
          '--no-thinking',
          '--kimi-executable',
          kimi,
          '--timeout-ms',
          '60000',
          '--chat-dir',
          path.join(directory, 'chats'),
          '--state-dir',
          path.join(directory, 'state'),
          '--log-dir',
          path.join(directory, 'logs'),
        ],
        {
          cwd: os.tmpdir(),
          env: {
            ...process.env,
            OPENAI_API_KEY: 'local-fixture',
            INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
          },
          timeout: 75000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      const rows = stdout.trim().split('\n').map(JSON.parse),
        results = rows.filter(row => row.type === 'industrial_result');
      assert.equal(rows.at(-1).status, 'finished', stderr + stdout);
      assert.equal(results.length, 8, JSON.stringify(results));
      const reader = rows.find(
        row => row.event?.type === 'tool-result' && row.event.id === 'mcp-call-2',
      )?.event;
      assert.ok(reader && !reader.error, JSON.stringify(reader));
      assert.match(JSON.parse(reader.output).content, /harness.tasks.json/);
      assert.deepEqual(
        results.filter(r => r.action.toolId === 'project.task.run').map(r => r.verification.status),
        ['passed', 'failed', 'passed'],
      );
      assert.equal(results[4].state.status, 'stale');
      assert.equal(results.at(-1).state.status, 'verified');
      assert.ok(rows[0].scope.skills.includes('project.work'));
      assert.ok(
        rows.some(
          row =>
            row.event?.type === 'execution-boundary' &&
            row.event.mechanism === 'current-user' &&
            row.event.osIsolation === false &&
            row.event.projectWritable === true,
        ),
      );
      assert.equal(
        fs.readFileSync(path.join(project, 'src/calculate.cjs'), 'utf8'),
        scenario.source,
      );
    },
  );
