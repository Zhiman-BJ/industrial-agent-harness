const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
const { createProjectRuntime } = require('../../packages/harness-core/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
const { boundaryMatches } = require('./fixtures/execution-boundary.cjs');
const scenario = require('./fixtures/workspace-scenario.cjs');
const execute = promisify(execFile);
function workspace(t, environment = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-workspace-native-')),
    project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const bundle = createProjectRuntime({
    projectDir: project,
    domain: 'example',
    directory: path.join(directory, 'state'),
    registry: { runtimePacks: [] },
    environment: {
      ...process.env,
      ...environment,
      INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
    },
  });
  t.after(() => {
    try {
      // The focused native runner retains canonical records and report bytes
      // before cleanup. No model configuration or user project is copied.
      if (process.env.HARNESS_WORKSPACE_ACCEPTANCE_EVIDENCE) {
        const evidence = path.join(
          process.env.HARNESS_WORKSPACE_ACCEPTANCE_EVIDENCE,
          path.basename(directory),
        );
        fs.mkdirSync(evidence, { recursive: true });
        const actions = bundle.runtime.listActions();
        const artifacts = [...new Set(actions.flatMap(action => action.artifactIds))].map(id =>
          bundle.runtime.get('artifact', id),
        );
        fs.writeFileSync(
          path.join(evidence, 'records.json'),
          JSON.stringify(
            {
              test: t.name,
              actions,
              artifacts,
              verifications: bundle.runtime.listVerifications(),
              checkpoints: bundle.runtime.listCheckpoints(),
            },
            null,
            2,
          ) + '\n',
        );
        for (const artifact of artifacts) {
          if (!['report.execution', 'report.task-checks', 'log.task'].includes(artifact.kind))
            continue;
          fs.writeFileSync(
            path.join(evidence, artifact.id),
            bundle.runtime.readArtifact(artifact.id).content,
          );
        }
      }
    } finally {
      bundle.runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
  // The real child waits after its immutable input copy exists. An external
  // writer then changes the live source; the checks must still read the copy.
  fs.writeFileSync(
    path.join(project, 'tests/check.cjs'),
    [
      "const fsWait = require('node:fs'), pathWait = require('node:path');",
      "fsWait.writeFileSync(pathWait.join(process.env.HARNESS_OUTPUT_DIR, 'ready'), 'ready');",
      "const wait = setInterval(() => { if (!fsWait.existsSync(pathWait.join(process.env.HARNESS_OUTPUT_DIR, 'release'))) return; clearInterval(wait);",
      scenario.checks,
      '}, 10);',
    ].join('\n'),
  );
  const waitingChecks = fs.readFileSync(path.join(project, 'tests/check.cjs'));
  async function startPausedTask() {
    const running = run('project.task.run', { task: 'test' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const action = bundle.runtime.listActions().find(action => action.status === 'running');
      const work = action && path.join(project, '.harness-runs', action.id, 'work');
      if (work && fs.existsSync(path.join(work, 'ready'))) return { running, work };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const result = await running;
    assert.fail('Real task did not become ready: ' + JSON.stringify(result));
  }
  const { running, work } = await startPausedTask();
  fs.writeFileSync(path.join(project, 'src/calculate.cjs'), scenario.broken);
  fs.writeFileSync(path.join(work, 'release'), 'release');
  const historical = await running;
  assert.equal(historical.action.inputBinding, 'snapshot');
  assert.equal(historical.verification.status, 'passed');
  assert.equal(historical.state.status, 'stale');
  assert.equal(
    historical.verification.evidence.inputHashes['src/calculate.cjs'],
    scenario.hash(scenario.source),
  );
  fs.writeFileSync(path.join(project, 'tests/check.cjs'), scenario.checks);
  assert.equal((await run('project.task.run', { task: 'test' })).verification.status, 'failed');
  // Passing child checks must be rejected if a host writer changes their input copy.
  fs.writeFileSync(path.join(project, 'src/calculate.cjs'), scenario.source);
  fs.writeFileSync(path.join(project, 'tests/check.cjs'), waitingChecks);
  const tampered = await startPausedTask();
  const copy = path.resolve(tampered.work, '../input/src/calculate.cjs');
  fs.chmodSync(copy, 0o600);
  fs.writeFileSync(copy, scenario.source + '// external change to captured bytes\n');
  fs.writeFileSync(path.join(tampered.work, 'release'), 'release');
  const rejected = await tampered.running;
  assert.equal(rejected.action.status, 'failed');
  assert.equal(rejected.verification.status, 'insufficient_evidence');
  assert.equal(rejected.action.inputBinding, undefined);
  assert.notEqual(rejected.state.status, 'verified');
  const checks = JSON.parse(
    bundle.runtime.readArtifact(
      rejected.artifacts.find(artifact => artifact.kind === 'report.task-checks').id,
    ).content,
  );
  assert.ok(
    checks.checks.length > 0 && checks.checks.every(check => check.passed),
    'Actual child checks passed, but their changed input copy is rejected.',
  );
  assert.equal(fs.readFileSync(path.join(project, 'src/calculate.cjs'), 'utf8'), scenario.source);
});
test('real task cannot write source, runtime evidence, input snapshots or contact host sockets; no inherited credentials', async t => {
  const { project, bundle, run } = workspace(t, {
    HARNESS_ACCEPTANCE_SECRET: 'controlled-credential-marker',
  });
  const net = require('node:net');
  const connections = { tcp: 0, unix: 0 };
  const tcp = net.createServer(socket => {
    connections.tcp++;
    socket.end();
  });
  const unix = net.createServer(socket => {
    connections.unix++;
    socket.end();
  });
  // Keep Unix socket names below macOS sun_path's limit, including long TMPDIRs.
  const socketPath = path.join('/tmp', 'ih-net-' + require('node:crypto').randomUUID() + '.sock');
  async function listen(server, options) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options, resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  await listen(tcp, { host: '127.0.0.1', port: 0 });
  await listen(unix, socketPath);
  // A live endpoint is the positive control: an absent server cannot count as isolation.
  for (const endpoint of [{ host: '127.0.0.1', port: tcp.address().port }, { path: socketPath }]) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(endpoint, () => socket.end());
      socket.once('error', reject);
      socket.once('close', resolve);
    });
  }
  assert.deepEqual(connections, { tcp: 1, unix: 1 });
  const stateFile = bundle.runtime.file;
  const script = `const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
    function deniedConnection(options) { return new Promise(resolve => {
      const socket=net.connect(options);
      const timer=setTimeout(()=>{socket.destroy();resolve(false)},1500);
      socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false)});
      socket.once('error',error=>{clearTimeout(timer);resolve(['EPERM','EACCES'].includes(error.code))});
    });}
    const paths=${JSON.stringify([path.join(fs.realpathSync(project), 'src/probe.cjs'), stateFile])};
    paths.push(path.join(process.env.HARNESS_INPUT_DIR,'src/probe.cjs'));
    const denied=paths.every(file=>{try{fs.writeFileSync(file,'bypass');return false}catch{return true}});
    const clean=!Object.keys(process.env).some(name=>/token|api.?key|password|secret/i.test(name));
    Promise.all([
      deniedConnection(${JSON.stringify({ host: '127.0.0.1', port: tcp.address().port })}),
      deniedConnection(${JSON.stringify({ path: socketPath })})
    ]).then(([tcpDenied,unixDenied])=>{
      fs.writeFileSync(path.join(process.env.HARNESS_OUTPUT_DIR,'checks.json'),JSON.stringify({schemaVersion:'1',checks:[
        {name:'write boundaries',passed:denied},{name:'credentials',passed:clean},
        {name:'host TCP denied',passed:tcpDenied},{name:'host Unix socket denied',passed:unixDenied}
      ]}));
    });`;
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
  assert.deepEqual(
    connections,
    { tcp: 1, unix: 1 },
    'Only host positive controls may reach the listeners.',
  );
});

test('real local task reads only its snapshot, runtime libraries and explicitly granted dependency directories', async t => {
  const { directory, project, bundle, run } = workspace(t);
  // Call the production backend through a directory alias, as with macOS TMPDIR.
  // A canonicalized project path can otherwise hide an incorrect Seatbelt grant.
  const { executeTask } = require('../../packages/domain-runtime/src/task-process.cjs');
  const alias = path.join(directory, 'backend-alias');
  fs.symlinkSync(directory, alias, 'dir');
  const input = path.join(alias, 'input'),
    work = path.join(alias, 'work');
  fs.mkdirSync(input);
  fs.mkdirSync(work);
  const aliased = await executeTask(
    {
      command: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync(require('node:path').join(process.env.HARNESS_OUTPUT_DIR, 'ran'), 'aliased-output')",
      ],
      runtime: { kind: 'local' },
      timeoutMs: 5000,
    },
    { directory: alias, input, work, actionId: 'aliased-output', environment: process.env },
  );
  assert.equal(aliased.exitCode, 0, JSON.stringify(aliased));
  assert.equal(fs.readFileSync(path.join(work, 'ran'), 'utf8'), 'aliased-output');
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
    `shared TaskService and pinned Kimi bootstrap and repair an empty ${domain} project through the shared Tools`,
    { timeout: 90000 },
    async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-workspace-task-')),
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
        require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();
      assert.ok(fs.existsSync(kimi));
      const { stdout, stderr } = await execute(
        process.execPath,
        taskArguments({
          projectDir: project,
          domain,
          task: 'Create a project and test; repair failed checks',
          approval: 'approve',
          provider: 'openai_legacy',
          endpoint: model.endpoint,
          model: 'controlled-workspace',
          thinking: false,
          kimiExecutable: kimi,
          timeoutMs: 60000,
          chatDir: path.join(directory, 'chats'),
          stateDir: path.join(directory, 'state'),
          logDir: path.join(directory, 'logs'),
        }),
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
      assert.ok(rows.some(boundaryMatches));
      assert.equal(
        fs.readFileSync(path.join(project, 'src/calculate.cjs'), 'utf8'),
        scenario.source,
      );
    },
  );
