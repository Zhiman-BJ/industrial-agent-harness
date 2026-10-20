#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { assertAgentBoundary } = require('./assert-agent-boundary.cjs');

async function child(archive, directory, endpoint) {
  const shareDir = path.join(directory, 'session');
  const projectDir = path.join(directory, 'project');
  fs.mkdirSync(shareDir);
  fs.mkdirSync(projectDir);
  const appRequire = createRequire(path.join(archive, 'electron', 'main.cjs'));
  const agentEntry = appRequire.resolve('@industrial-agent-harness/agent-kimi');
  const agentRequire = createRequire(agentEntry);
  const { z } = agentRequire('zod');
  const { createSession, createExternalTool, KIMI_CODE_VERSION } =
    agentRequire('./code-session.cjs');
  const { configToml, sessionEnv } = agentRequire('./model-config.cjs');
  const profile = {
    provider: 'openai_legacy',
    endpoint,
    model: 'controlled',
    contextSize: 32768,
    thinking: false,
  };
  fs.writeFileSync(path.join(shareDir, 'config.toml'), configToml(profile));
  fs.writeFileSync(path.join(shareDir, 'mcp.json'), '{}');
  let hostCalls = 0;
  const options = {
    workDir: shareDir,
    shareDir,
    env: sessionEnv(profile, 'packaged-local-fixture'),
    externalTools: [
      createExternalTool({
        name: 'packaged_probe',
        description: 'Exercise the packaged host callback',
        parameters: z.object({ value: z.literal('PACKAGED_HOST_OK') }),
        handler: async () => {
          hostCalls++;
          return { output: 'PACKAGED_HOST_OK' };
        },
      }),
    ],
  };
  let sandbox;
  {
    const { createProcessSandbox } = agentRequire('./process-sandbox.cjs');
    sandbox = createProcessSandbox({
      executable: agentRequire('./code-session.cjs').bundledExecutable(),
      shareDir,
      projectDir,
      kimiProjectAccess: true,
      environment: {
        ...process.env,
        ...options.env,
        HARNESS_PACKAGED_HOST_ONLY: 'host-only-marker',
      },
      hostOnlyEnv: ['HARNESS_PACKAGED_HOST_ONLY'],
    });
    assertAgentBoundary(sandbox.boundary);
    assert.equal(sandbox.env.HARNESS_PACKAGED_HOST_ONLY, undefined);
    Object.assign(options, {
      executable: sandbox.executable,
      workDir: sandbox.workDir,
      projectDir,
      env: sandbox.env,
      envIsolated: true,
      spawn: sandbox.spawn,
    });
  }
  let session = createSession(options);
  const sessions = [session];
  let approvals = 0;
  let questions = 0;
  async function run(prompt) {
    const turn = session.prompt(prompt);
    let answer = '';
    for await (const event of turn) {
      if (event.type === 'ApprovalRequest') {
        approvals++;
        await turn.approve(event.payload.id, 'approve');
      }
      if (event.type === 'QuestionRequest') {
        questions++;
        await turn.respondQuestion(event.payload.id, event.payload.id, {});
      }
      if (event.type === 'ContentPart') answer += event.payload.text || '';
    }
    assert.equal((await turn.result).status, 'finished');
    assert.match(answer, /PACKAGED_CODE_OK/);
  }
  try {
    await run('PACKAGED_FIRST: run the host probe and write the approved marker.');
    assert.equal(hostCalls, 1);
    assert.ok(approvals >= 1, 'native Bash must request approval');
    assert.equal(questions, 1, 'the packaged question must be explicitly dismissed');
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'packaged-code.txt'), 'utf8').trim(),
      'PACKAGED_CODE_OK',
    );
    // Also read the real web assets from inside app.asar, rather than only --version.
    assert.equal((await fetch(session.baseUrl)).status, 200);
    const identity = { sessionId: session.sessionId, nativeId: session.nativeId };
    await session.close();
    session = createSession({ ...options, sessionId: identity.sessionId, resumeRequired: true });
    sessions.push(session);
    await run('PACKAGED_SECOND: continue the saved conversation.');
    assert.equal(session.sessionId, identity.sessionId);
    assert.equal(session.nativeId, identity.nativeId);
    assert.equal(hostCalls, 1, 'resuming must not replay the host callback');
    const snapshot = await session.diagnosticSnapshot();
    assert.equal(snapshot[0].format, 'kimi-code-server-v1');
    assert.match(JSON.stringify(snapshot), /PACKAGED_FIRST/);
    assert.match(JSON.stringify(snapshot), /PACKAGED_SECOND/);
    process.stdout.write(
      JSON.stringify({
        version: KIMI_CODE_VERSION,
        hostCalls,
        approvals,
        questions,
        resumed: true,
        projectWrite: true,
        hostEnvironmentFiltered: true,
        boundary: sandbox.boundary,
      }) + '\n',
    );
  } finally {
    await Promise.allSettled(sessions.map(item => item.close()));
    sandbox?.close();
  }
}

async function main() {
  if (process.argv[2] === '--child') return child(...process.argv.slice(3));
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const { startModel } = require('../tests/integration/fixtures/domain-mcp-model.cjs');
  const output = path.resolve(__dirname, '../dist/desktop-release');
  let executable, archive;
  if (process.platform === 'darwin') {
    const preferred = process.arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-x64'];
    const folder = preferred.find(name =>
      fs.existsSync(path.join(output, name, 'Industrial Agent Harness.app')),
    );
    assert.ok(folder, 'Packaged macOS application is missing.');
    const contents = path.join(output, folder, 'Industrial Agent Harness.app', 'Contents');
    executable = path.join(contents, 'MacOS', 'Industrial Agent Harness');
    archive = path.join(contents, 'Resources', 'app.asar');
  } else if (process.platform === 'win32') {
    executable = path.join(output, 'win-unpacked', 'Industrial Agent Harness.exe');
    archive = path.join(output, 'win-unpacked', 'resources', 'app.asar');
  } else throw Error('Packaged Desktop smoke supports macOS and Windows.');
  assert.ok(
    fs.existsSync(executable) && fs.existsSync(archive),
    'Packaged Desktop runtime is missing.',
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-packaged-kimi-'));
  const model = await startModel({
    calls: [
      { name: 'packaged_probe', arguments: { value: 'PACKAGED_HOST_OK' } },
      {
        name: 'Bash',
        arguments: {
          command: `echo PACKAGED_CODE_OK > "${path.join(directory, 'project', 'packaged-code.txt')}"`,
          description: 'Write the approved marker in the actual project',
        },
      },
      {
        name: 'AskUserQuestion',
        arguments: {
          questions: [
            {
              question: 'Which marker?',
              options: [{ label: 'First' }, { label: 'Second' }],
              multi_select: false,
            },
          ],
        },
      },
    ],
    success: 'PACKAGED_CODE_OK',
  });
  try {
    const { stdout } = await promisify(execFile)(
      executable,
      [__filename, '--child', archive, directory, model.endpoint],
      {
        cwd: directory,
        timeout: 60000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KIMI_EXECUTABLE: '' },
      },
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.version, '2.1.1');
    assert.equal(result.resumed, true);
    assert.equal(result.projectWrite, true);
    assert.equal(result.hostEnvironmentFiltered, true);
    assertAgentBoundary(result.boundary);
    assert.equal(model.requests.length, 5);
    assert.match(JSON.stringify(model.requests.at(-1).messages), /PACKAGED_FIRST/);
    process.stdout.write(
      `Packaged Kimi Code tools, approval and resume passed (${process.platform}-${process.arch}): ${stdout}`,
    );
  } finally {
    model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
