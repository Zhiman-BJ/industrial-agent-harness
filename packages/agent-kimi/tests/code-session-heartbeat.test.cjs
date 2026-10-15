const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createSession } = require('../src/code-session.cjs');
const { runtimeTools } = require('../src/runtime-tools.cjs');
const { configToml, sessionEnv } = require('../src/model-config.cjs');
const { createProjectRuntime } = require('../../harness-core/src/index.cjs');
const { resolveFromState } = require('../../capability-broker/src/index.cjs');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');

test(
  'real Kimi completes a Runtime callback beyond 60 seconds and keeps its idle session without replay',
  { skip: !['darwin', 'linux'].includes(process.platform), timeout: 120000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-code-heartbeat-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, 'runner.cjs'),
      `const fs=require('node:fs'),path=require('node:path');
      const start=Date.now();
      setTimeout(()=>fs.writeFileSync(path.join(process.env.HARNESS_OUTPUT_DIR,'checks.json'),
        JSON.stringify({schemaVersion:'1',checks:[{name:'completed after 60 seconds',passed:Date.now()-start>=65000}]})),65000);`,
    );
    fs.writeFileSync(
      path.join(project, 'harness.tasks.json'),
      JSON.stringify({
        schemaVersion: '1',
        tasks: {
          long: {
            command: [process.execPath, '{input}/runner.cjs'],
            inputs: ['runner.cjs'],
            timeoutMs: 75000,
            verification: { kind: 'checks-json', path: 'checks.json' },
          },
        },
      }),
    );
    const { runtime, capabilities } = createProjectRuntime({
      projectDir: project,
      domain: 'example',
      directory: path.join(directory, 'state'),
      registry: { runtimePacks: [] },
      environment: {
        ...process.env,
        INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
      },
    });
    let model, session;
    t.after(async () => {
      runtime.cancel('heartbeat');
      await runtime.waitForIdle('heartbeat');
      await session?.close();
      model?.close();
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const state = await runtime.inspect();
    const scope = resolveFromState({ task: 'run the declared task', state }, capabilities).scope;
    model = await startModel({
      calls: [
        {
          name: 'industrial_action_call',
          arguments: {
            toolId: 'project.task.run',
            inputs: { task: 'long' },
            expectedStateId: state.id,
          },
        },
      ],
      success: 'HEARTBEAT_TURN_FINISHED',
    });
    const profile = {
      provider: 'openai_legacy',
      endpoint: model.endpoint,
      model: 'controlled',
      contextSize: 32768,
      thinking: false,
    };
    fs.writeFileSync(path.join(directory, 'config.toml'), configToml(profile));
    fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
    const results = [];
    session = createSession({
      workDir: directory,
      shareDir: directory,
      env: sessionEnv(profile, 'heartbeat-fixture-key'),
      externalTools: runtimeTools(
        runtime,
        () => scope,
        async () => true,
        result => {
          results.push(result);
        },
        { ownerId: 'heartbeat' },
      ),
    });
    async function completeTurn() {
      const turn = session.prompt('Complete the controlled task');
      const events = [];
      for await (const event of turn) {
        events.push(event);
        if (event.type === 'ApprovalRequest') await turn.approve(event.payload.id, 'approve');
      }
      assert.equal((await turn.result).status, 'finished');
      assert.ok(
        events.some(
          event => event.type === 'ContentPart' && event.payload.text === 'HEARTBEAT_TURN_FINISHED',
        ),
      );
      return events;
    }
    const events = await completeTurn();
    const toolResult = events.find(event => event.type === 'ToolResult');
    assert.ok(toolResult, 'The real Kimi client must receive the host Runtime result.');
    const output = JSON.parse(toolResult.payload.return_value.output);
    assert.equal(output.actionStatus, 'completed');
    assert.equal(output.verification.status, 'passed');
    assert.equal(results.length, 1);
    const execution = JSON.parse(
      runtime.readArtifact(
        results[0].artifacts.find(artifact => artifact.kind === 'report.execution').id,
      ).content,
    );
    assert.equal(execution.status, 'COMPLETED');
    assert.ok(Date.parse(execution.endedAt) - Date.parse(execution.startedAt) >= 65000);
    assert.equal(runtime.listActions()[0].status, 'completed');
    assert.equal(runtime.listActions()[0].verification.status, 'passed');
    const nativeId = session.nativeId;
    await delay(22000);
    await completeTurn();
    assert.equal(session.nativeId, nativeId);
    assert.equal(results.length, 1, 'A live connection must never replay the host action.');
    assert.equal(runtime.listActions().length, 1);
    assert.equal(model.requests.length, 3);
  },
);
