const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IndustrialRuntime } = require('../../packages/domain-runtime/src/index.cjs');
const { resolveFromState } = require('../../packages/capability-broker/src/index.cjs');
const { createRuntimePlugin } = require(
  require('../../packages/domain-skills/src/index.cjs').packSourceDirectory('chip-pack') +
    '/runtime/index.cjs',
);
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-real-rtl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  fs.cpSync(path.join(__dirname, 'fixtures/industrial-rtl'), project, { recursive: true });
  const plugin = createRuntimePlugin();
  const open = () =>
    new IndustrialRuntime(project, 'chip', { directory: path.join(directory, 'state'), ...plugin });
  return { directory, project, plugin, open };
}

function simulationGate(directory, project) {
  const ready = path.join(directory, 'simulation-ready.json');
  const release = path.join(directory, 'simulation-release');
  const python =
    process.env.INDUSTRIAL_HARNESS_EDA_PYTHON ||
    path.join(
      require('../../packages/domain-skills/src/index.cjs').packSourceDirectory('chip-pack'),
      'eda-harness/.venv/bin/python',
    );
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // Verilator 5.026 limits a literal $system command to 256 bytes. Keep the
  // native simulator command short while the script passes full paths safely.
  const gateScript = path.join(directory, 'simulation-gate.sh');
  fs.writeFileSync(
    gateScript,
    '#!/bin/sh\nexec ' +
      [python, path.join(__dirname, 'fixtures/native-simulation-gate.py'), ready, release]
        .map(quote)
        .join(' ') +
      '\n',
    { mode: 0o700 },
  );
  const command = 'exec ' + quote(gateScript);
  const file = path.join(project, 'tb/counter_tb.sv');
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes('  initial begin\n'));
  // Hold the actual compiled Verilator simulation, with a real descendant in
  // its owned process group. No mocked execution or engineering result.
  fs.writeFileSync(
    file,
    source.replace(
      '  initial begin\n',
      '  initial begin\n    if ($system(' +
        JSON.stringify(command) +
        ') != 0) $fatal(1, "simulation gate failed");\n',
    ),
  );
  return { ready, release: () => fs.writeFileSync(release, 'continue\n') };
}

async function waitForSimulation(ready, pending) {
  let settled;
  void pending.then(
    result => {
      settled = result;
    },
    error => {
      settled = { error: String(error) };
    },
  );
  const deadline = Date.now() + 45000;
  while (!fs.existsSync(ready)) {
    if (settled) throw Error('Native execution ended before readiness: ' + JSON.stringify(settled));
    if (Date.now() >= deadline) throw Error('Timed out waiting for the real simulation: ' + ready);
    await sleep(20);
  }
  assert.equal(settled, undefined, 'The simulation must still be running at the handshake.');
  const processInfo = JSON.parse(fs.readFileSync(ready, 'utf8'));
  for (const pid of Object.values(processInfo)) assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(processInfo.parentPid, processInfo.processGroupId);
  return processInfo;
}

async function assertProcessesExited(processInfo) {
  const pids = [processInfo.pid, processInfo.parentPid];
  const alive = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await sleep(20);
  assert.deepEqual(pids.filter(alive), [], 'Owned simulation and descendant must both be gone.');
}

test(
  'real Verilator: StateProvider → Broker → runtime → artifacts → assertions → durable state/checkpoint; stale inputs and restart retain evidence',
  { timeout: 120000 },
  async t => {
    const { project, plugin, open } = workspace(t);
    let runtime = open();
    t.after(() => runtime?.close());
    const state = await runtime.inspect();
    assert.equal(state.status, 'unverified');
    assert.equal(state.stage, 'rtl');
    const resolution = resolveFromState(
      { task: 'Run RTL simulation verification assertions', state },
      plugin.capabilities,
    );
    assert.deepEqual(resolution.scope.tools, ['chip.rtl.verify', 'chip.environment.check']);
    const result = await runtime.execute(
      { toolId: resolution.scope.tools[0], inputs: {}, expectedStateId: state.id },
      { scope: resolution.scope, approval: true },
    );
    assert.equal(result.action.status, 'completed', JSON.stringify(result.action));
    assert.match(result.action.toolVersion, /Verilator/);
    assert.equal(result.verification.status, 'passed', JSON.stringify(result));
    assert.equal(result.state.status, 'verified');
    assert.ok(result.artifacts.some(artifact => artifact.kind === 'waveform.vcd'));
    const wave = result.artifacts.find(artifact => artifact.kind === 'waveform.vcd');
    assert.match(runtime.readArtifact(wave.id).content.toString(), /\$var/);
    const checkpointId = result.checkpoint.id;
    runtime.close();
    runtime = open();
    assert.equal(runtime.listActions()[0].id, result.action.id);
    assert.equal(runtime.listVerifications()[0].id, result.verification.id);
    assert.equal(runtime.latestCheckpoint().id, checkpointId);
    assert.equal((await runtime.inspect()).id, result.state.id);
    const originalWave = runtime.readArtifact(wave.id).content;
    fs.appendFileSync(path.join(project, 'rtl/counter.sv'), '\n// changed source identity\n');
    const stale = await runtime.inspect();
    assert.equal(stale.status, 'stale');
    assert.notEqual(stale.id, result.state.id);
    const rejected = await runtime.execute(
      { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
      { scope: resolution.scope, approval: true },
    );
    assert.equal(rejected.action.status, 'failed');
    assert.equal(rejected.artifacts.length, 0);
    assert.equal(rejected.verification.status, 'insufficient_evidence');
    assert.match(rejected.action.diagnostics.join(), /stale/);
    assert.deepEqual(runtime.readArtifact(wave.id).content, originalWave);
    assert.ok(
      runtime
        .listCheckpoints()
        .some(item => item.id === checkpointId && item.state.status === 'verified'),
    );
  },
);

test(
  'real native timeout preserves diagnostics and no engineering acceptance',
  { timeout: 120000 },
  async t => {
    const { project, plugin, open } = workspace(t);
    const yaml = path.join(project, 'eda.yaml');
    fs.writeFileSync(
      yaml,
      fs.readFileSync(yaml, 'utf8').replace('timeout_seconds: 60', 'timeout_seconds: 1'),
    );
    const runtime = open();
    t.after(() => runtime.close());
    const state = await runtime.inspect();
    const scope = resolveFromState(
      { task: 'simulation assertions', state },
      plugin.capabilities,
    ).scope;
    const result = await runtime.execute(
      { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
      { scope, approval: true },
    );
    assert.equal(result.action.status, 'failed');
    assert.equal(result.verification.status, 'insufficient_evidence');
    const executions = result.artifacts
      .filter(item => item.kind === 'report.execution')
      .flatMap(item => JSON.parse(runtime.readArtifact(item.id).content.toString()));
    assert.ok(
      executions.some(item => item.status === 'TIMEOUT'),
      JSON.stringify(executions),
    );
    assert.ok(result.action.diagnostics.length);
  },
);

test('cancellation before native startup records failure without starting a tool', async t => {
  const { project, plugin, open } = workspace(t);
  const runtime = open();
  t.after(() => runtime.close());
  const state = await runtime.inspect();
  const scope = resolveFromState(
    { task: 'simulation assertions', state },
    plugin.capabilities,
  ).scope;
  const pending = runtime.execute(
    { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
    { scope, approval: true },
  );
  runtime.cancel();
  const result = await pending;
  assert.equal(result.action.status, 'failed');
  assert.equal(result.verification.status, 'insufficient_evidence');
  assert.match(result.action.diagnostics.join(), /cancelled before native execution/);
  assert.deepEqual(result.artifacts, []);
  assert.equal(fs.existsSync(path.join(project, '.eda')), false);
});

test(
  'real native cancellation waits for simulation readiness and owned descendant cleanup',
  { timeout: 120000 },
  async t => {
    const { directory, project, plugin, open } = workspace(t);
    const gate = simulationGate(directory, project);
    const runtime = open();
    try {
      const state = await runtime.inspect();
      const scope = resolveFromState(
        { task: 'simulation assertions', state },
        plugin.capabilities,
      ).scope;
      const pending = runtime.execute(
        { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
        { scope, approval: true },
      );
      const processInfo = await waitForSimulation(gate.ready, pending);
      runtime.cancel();
      const cancelled = await pending;
      await runtime.waitForIdle();
      await assertProcessesExited(processInfo);
      assert.equal(cancelled.action.status, 'failed');
      assert.equal(cancelled.verification.status, 'insufficient_evidence');
      const reports = cancelled.artifacts
        .filter(item => item.kind === 'report.execution')
        .flatMap(item => JSON.parse(runtime.readArtifact(item.id).content.toString()));
      assert.ok(
        reports.some(item => item.status === 'CANCELLED' && item.argv[0].endsWith('/Vcounter_tb')),
        JSON.stringify(reports),
      );
      assert.notEqual((await runtime.inspect()).status, 'verified');
    } finally {
      runtime.cancel();
      try {
        await runtime.waitForIdle();
      } finally {
        runtime.close();
      }
    }
  },
);

test(
  'input changes after real simulation readiness never become current acceptance',
  { timeout: 120000 },
  async t => {
    const { directory, project, plugin, open } = workspace(t);
    const gate = simulationGate(directory, project);
    const runtime = open();
    try {
      const state = await runtime.inspect();
      const scope = resolveFromState(
        { task: 'simulation assertions', state },
        plugin.capabilities,
      ).scope;
      const pending = runtime.execute(
        { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
        { scope, approval: true },
      );
      const processInfo = await waitForSimulation(gate.ready, pending);
      fs.appendFileSync(path.join(project, 'rtl/counter.sv'), '\n// concurrent input change\n');
      gate.release();
      const result = await pending;
      await assertProcessesExited(processInfo);
      assert.equal(result.action.status, 'completed');
      assert.equal(result.verification.status, 'insufficient_evidence');
      assert.match(result.verification.reason, /inputs changed during execution/);
      assert.ok(result.artifacts.some(item => item.kind === 'waveform.vcd'));
      assert.equal(result.state.status, 'stale');
      assert.notEqual(
        result.state.inputHashes['rtl/counter.sv'],
        state.inputHashes['rtl/counter.sv'],
      );
      assert.equal(result.state.id, result.checkpoint.state.id);
    } finally {
      runtime.cancel();
      try {
        await runtime.waitForIdle();
      } finally {
        runtime.close();
      }
    }
  },
);

test(
  'the real Pack subprocess receives engineering environment without inherited model credentials',
  { timeout: 15000 },
  async t => {
    const { directory, project } = workspace(t);
    const python =
      process.env.INDUSTRIAL_HARNESS_EDA_PYTHON ||
      path.join(
        require('../../packages/domain-skills/src/index.cjs').packSourceDirectory('chip-pack'),
        'eda-harness/.venv/bin/python',
      );
    const wrapper = path.join(directory, 'checked-python');
    const capture = path.join(directory, 'credential-check.json');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const probe = `import json, os; json.dump({name: name in os.environ for name in ['OPENAI_API_KEY','KIMI_API_KEY','HF_TOKEN','TEST_PASSWORD']},open(${JSON.stringify(capture)},'w'))`;
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\n${quote(python)} -c ${quote(probe)}\nexec ${quote(python)} "$@"\n`,
      { mode: 0o700 },
    );
    const plugin = createRuntimePlugin({
      environment: {
        ...process.env,
        INDUSTRIAL_HARNESS_EDA_PYTHON: wrapper,
        OPENAI_API_KEY: 'local-test-key',
        KIMI_API_KEY: 'local-test-key',
        HF_TOKEN: 'local-test-token',
        TEST_PASSWORD: 'local-test-password',
      },
    });
    const state = await plugin.stateProvider({ projectDir: project });
    assert.ok(state.inputHashes['rtl/counter.sv']);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), {
      OPENAI_API_KEY: false,
      KIMI_API_KEY: false,
      HF_TOKEN: false,
      TEST_PASSWORD: false,
    });
  },
);

test(
  'real failed assertion and compiler failure remain distinct engineering outcomes; denied scope/approval creates no native run',
  { timeout: 120000 },
  async t => {
    const { project, plugin, open } = workspace(t);
    const runtime = open();
    t.after(() => runtime.close());
    let state = await runtime.inspect();
    let scope = resolveFromState(
      { task: 'simulation assertions', state },
      plugin.capabilities,
    ).scope;
    for (const policy of [
      { scope: { ...scope, tools: [] }, approval: true },
      { scope: { ...scope, projectId: 'f'.repeat(64) }, approval: true },
      { scope: { ...scope, projectId: undefined }, approval: true },
      { scope: { ...scope, stateId: undefined }, approval: true },
      { scope, approval: false },
    ]) {
      const denied = await runtime.execute(
        { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
        policy,
      );
      assert.equal(denied.action.status, 'failed');
      assert.deepEqual(denied.artifacts, []);
      assert.equal(denied.verification.status, 'insufficient_evidence');
      assert.ok(!fs.existsSync(path.join(project, '.eda')));
    }
    const tb = path.join(project, 'tb/counter_tb.sv');
    fs.writeFileSync(tb, fs.readFileSync(tb, 'utf8').replace('count == 4', 'count == 9'));
    state = await runtime.inspect();
    scope = resolveFromState({ task: 'simulation assertions', state }, plugin.capabilities).scope;
    const failed = await runtime.execute(
      { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
      { scope, approval: true },
    );
    assert.equal(failed.verification.status, 'failed', JSON.stringify(failed));
    assert.equal(failed.state.status, 'failed');
    assert.ok(failed.artifacts.some(item => item.kind === 'log.tool'));
    fs.appendFileSync(path.join(project, 'rtl/counter.sv'), '\nthis is invalid RTL;\n');
    state = await runtime.inspect();
    scope = resolveFromState({ task: 'simulation assertions', state }, plugin.capabilities).scope;
    const compiler = await runtime.execute(
      { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: state.id },
      { scope, approval: true },
    );
    assert.equal(compiler.action.status, 'failed');
    assert.equal(compiler.verification.status, 'insufficient_evidence');
    assert.notEqual(compiler.state.status, 'verified');
  },
);

test(
  'real CLI + pinned Kimi writes a native fixture as the current user and executes approved host RTL tool with a durable engineering result',
  {
    timeout: 120000,
    skip: process.platform !== 'darwin' && !process.env.HARNESS_REQUIRE_CORE_NATIVE,
  },
  async t => {
    const { directory, project } = workspace(t);
    const native =
      process.env.KIMI_EXECUTABLE ||
      require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();
    assert.ok(fs.existsSync(native), 'The mandatory Core gate requires the pinned Kimi CLI.');
    const marker = path.join(directory, 'native-agent-marker.txt');
    const script =
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'CORE_NATIVE_FIXTURE_WRITE_OK');` +
      "console.log('CORE_NATIVE_FIXTURE_WRITE_OK')";
    const fixture = await startModel({
      success: 'CORE_VERIFICATION_RECORDED',
      calls: body => {
        const prompt = JSON.stringify(body.messages);
        const id = prompt.match(/expectedStateId=([a-f0-9-]{36})/)?.[1];
        assert.ok(id, 'Real Kimi prompt must disclose the persisted DomainState identity.');
        return [
          {
            name: 'Bash',
            arguments: {
              command: `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}', 'base64').toString())"`,
              description: 'Write a synthetic marker outside the temporary RTL project inputs',
            },
          },
          {
            name: 'industrial_action_call',
            arguments: { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: id },
          },
        ];
      },
    });
    t.after(fixture.close);
    const before = fs.readFileSync(path.join(project, 'rtl/counter.sv'));
    const result = await execute(
      process.execPath,
      [
        path.join(root, 'apps/cli/src/main.cjs'),
        'run',
        '--project-dir',
        project,
        '--domain',
        'chip',
        '--task',
        'Run RTL simulation verification assertions',
        '--approval',
        'approve',
        '--provider',
        'openai_legacy',
        '--endpoint',
        fixture.endpoint,
        '--model',
        'controlled-core',
        '--no-thinking',
        '--kimi-executable',
        native,
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
        cwd: root,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'local-core-fixture-key',
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
        },
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch(error => {
      // Node's Error inspector truncates large JSONL stdout before the final
      // error row. Keep the useful tail in CI so failures remain diagnosable.
      t.diagnostic('CLI stdout tail:\n' + String(error.stdout || '').slice(-24000));
      t.diagnostic('CLI stderr tail:\n' + String(error.stderr || '').slice(-8000));
      throw error;
    });
    const rows = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).status, 'finished', result.stderr + result.stdout);
    assert.deepEqual(fs.readFileSync(path.join(project, 'rtl/counter.sv')), before);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'CORE_NATIVE_FIXTURE_WRITE_OK');
    assert.match(JSON.stringify(fixture.requests), /CORE_NATIVE_FIXTURE_WRITE_OK/);
    const engineering = rows.find(row => row.type === 'industrial_result');
    assert.ok(engineering, 'CLI must expose the real canonical runtime result.');
    assert.equal(engineering.verification.status, 'passed', JSON.stringify(engineering));
    assert.equal(engineering.state.id, engineering.checkpoint.state.id);
    assert.equal(rows.at(-1).engineering.checkpointId, engineering.checkpoint.id);
    assert.ok(
      rows.some(
        row =>
          row.event?.type === 'execution-boundary' &&
          row.event.mechanism === 'current-user' &&
          row.event.osIsolation === false &&
          row.event.projectWritable === true,
      ),
    );
  },
);
