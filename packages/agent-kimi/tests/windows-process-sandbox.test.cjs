const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');
const systemBinary = name =>
  path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', name);

function windowsOnly(t) {
  if (process.platform === 'win32') return true;
  t.diagnostic('Windows native execution requires a Windows runner; no native qualification here.');
  return false;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-kimi-boundary-'));
  const cleanup = [];
  const dirs = Object.fromEntries(
    ['project', 'share', 'state', 'sibling', 'foreign-low'].map(name => {
      const file = path.join(directory, name);
      fs.mkdirSync(file);
      return [name, file];
    }),
  );
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return { directory, ...dirs, defer: close => cleanup.push(close) };
}

function createBoundary(dirs, options = {}) {
  return createProcessSandbox({
    executable: process.execPath,
    projectDir: dirs.project,
    shareDir: dirs.share,
    protectedPaths: [dirs.state],
    ...options,
  });
}

function capture(child, input = '') {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Error(`Sandbox child timed out: ${stderr}`));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('Windows current-user launch supports null-device I/O and headless subprocess primitives', async t => {
  if (!windowsOnly(t)) return;
  const dirs = fixture(t);
  const sandbox = createBoundary(dirs);
  dirs.defer(() => sandbox.close());
  const probe = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const progress = value => fs.writeSync(2, 'Windows primitive probe: ' + JSON.stringify(value) + '\\n');
    progress({ stage: 'javascript entered' });
    const nullDevice = [fs.constants.O_RDONLY, fs.constants.O_WRONLY, fs.constants.O_RDWR].map(flags => {
      progress({ stage: 'open NUL', flags });
      try { const fd = fs.openSync(String.fromCharCode(92, 92, 46, 92) + 'NUL', flags); fs.closeSync(fd); return { flags, ok: true }; }
      catch (error) { return { flags, ok: false, code: error.code, syscall: error.syscall }; }
    });
    progress({ nullDevice });
    const files = ['input', 'output', 'error'].map((name, index) => fs.openSync(path.join(process.cwd(), name), index ? 'w' : 'w+'));
    const subprocesses = ['inherit', 'files', 'ignore', 'pipe'].map(mode => {
      progress({ stage: 'spawn', mode });
      try {
        const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
          stdio: mode === 'files' ? files : mode, windowsHide: true,
          timeout: 1500, encoding: 'utf8',
        });
        const item = { mode, status: result.status, code: result.error?.code, stderr: result.stderr };
        progress(item);
        return item;
      } catch (error) { return { mode, code: error.code, syscall: error.syscall }; }
    });
    for (const fd of files) fs.closeSync(fd);
    process.stdout.write(JSON.stringify({ nullDevice, subprocesses }));
  `;
  const result = await capture(
    sandbox.spawn(process.execPath, ['-e', probe], {
      cwd: sandbox.workDir,
      env: sandbox.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  );
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(report));
  assert.ok(
    report.nullDevice.every(item => item.ok),
    'headless tools require null-device I/O',
  );
  for (const child of report.subprocesses)
    assert.equal(
      child.status,
      0,
      child.mode + ': ' + (child.code || child.stderr || 'no exit status'),
    );
});

test(
  'Windows current-user descendants preserve argv and pipes and retain normal user file permissions',
  { timeout: 60000 },
  async t => {
    if (!windowsOnly(t)) return;
    const dirs = fixture(t);
    const projectFile = path.join(dirs.project, 'source.txt');
    fs.writeFileSync(projectFile, 'original project');
    // Per-user installers and nvm place executables behind user-private ACLs.
    // The launch must use the existing user token without additional ACL setup.
    const privateRuntime = path.join(dirs.state, 'private-runtime');
    fs.mkdirSync(privateRuntime);
    const userSid = execFileSync(systemBinary('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    }).match(/S-1-5-[\d-]+/)?.[0];
    assert.ok(userSid, 'the Windows fixture must identify its current user');
    execFileSync(
      systemBinary('icacls.exe'),
      [
        privateRuntime,
        '/inheritance:r',
        '/grant:r',
        `*${userSid}:(OI)(CI)F`,
        '*S-1-5-18:(OI)(CI)F',
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    const privateNode = path.join(privateRuntime, 'node.exe');
    fs.copyFileSync(process.execPath, privateNode);
    const sandbox = createBoundary(dirs, {
      environment: { ...process.env, HARNESS_TEST_HOST_SECRET: 'host-only-value' },
      hostOnlyEnv: ['HARNESS_TEST_HOST_SECRET'],
    });
    dirs.defer(() => sandbox.close());
    assert.equal(sandbox.envIsolated, true);
    assert.equal(sandbox.projectAlias, false);
    assert.equal(sandbox.env.HARNESS_TEST_HOST_SECRET, undefined);
    const forbidden = [
      projectFile,
      path.join(dirs.state, 'fake.sqlite'),
      path.join(dirs.sibling, 'other-session.txt'),
      path.join(dirs['foreign-low'], 'foreign.txt'),
    ];
    const allowed = path.join(dirs.share, 'context.json');
    const argv = [
      '',
      'two words',
      'a"quoted"value',
      '尾部 Unicode',
      'trailing\\',
      '\\"quoted',
      '& | < > ^ % !',
    ];
    const probe = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const writes = ${JSON.stringify(forbidden)}.map(file => {
      try { fs.writeFileSync(file, 'bypass'); return true; }
      catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; return false; }
    });
    fs.writeFileSync(${JSON.stringify(allowed)}, 'SESSION_WRITE_OK');
    const temporary = path.join(process.env.TEMP, 'scratch-probe.txt');
    fs.writeFileSync(temporary, 'TEMP_WRITE_OK');
    const inherited = spawnSync(process.execPath, ['-e',
      'try { require("node:fs").writeFileSync(process.argv[1], "bypass"); process.exit(9); } catch (e) { if (!["EACCES", "EPERM"].includes(e.code)) throw e; }',
      ${JSON.stringify(projectFile)}], { encoding: 'utf8', windowsHide: true });
    const privateChild = spawnSync(${JSON.stringify(privateNode)}, ['-e',
      'process.stdout.write("PRIVATE_RUNTIME_OK")'], { encoding: 'utf8', windowsHide: true });
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({
      argv: process.argv.slice(1), input, writes,
      temp: fs.readFileSync(temporary, 'utf8'),
      inherited: inherited.status, inheritedError: inherited.stderr,
      privateChild: privateChild.status, privateOutput: privateChild.stdout,
      privateError: privateChild.error?.message || privateChild.stderr,
      hostSecret: process.env.HARNESS_TEST_HOST_SECRET ?? null,
    })));
  `;
    const result = await capture(
      sandbox.spawn(process.execPath, ['-e', probe, ...argv], {
        cwd: sandbox.workDir,
        env: sandbox.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      'PIPE_INPUT_OK\n',
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.argv, argv);
    assert.equal(output.input, 'PIPE_INPUT_OK\n');
    assert.deepEqual(
      output.writes,
      forbidden.map(() => true),
    );
    assert.equal(output.temp, 'TEMP_WRITE_OK');
    assert.equal(output.inherited, 9, output.inheritedError);
    assert.equal(output.privateChild, 0, output.privateError);
    assert.equal(output.privateOutput, 'PRIVATE_RUNTIME_OK');
    assert.equal(output.hostSecret, null);
    assert.equal(fs.readFileSync(allowed, 'utf8'), 'SESSION_WRITE_OK');
    assert.equal(fs.readFileSync(projectFile, 'utf8'), 'bypass');
    assert.equal(sandbox.boundary.projectWritable, true);
    assert.equal(sandbox.boundary.osIsolation, false);
  },
);

test(
  'Windows current-user cancellation stops the live process tree',
  { timeout: 60000 },
  async t => {
    if (!windowsOnly(t)) return;
    {
      const dirs = fixture(t);
      const sandbox = createBoundary(dirs);
      dirs.defer(() => sandbox.close());
      const pidFile = path.join(dirs.share, 'descendant.pid');
      const code = `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
      setInterval(() => {}, 1000);
    `;
      const child = sandbox.spawn(process.execPath, ['-e', code], {
        cwd: sandbox.workDir,
        env: sandbox.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stderr.on('data', chunk => t.diagnostic(chunk.toString().trim()));
      const completed = capture(child);
      dirs.defer(async () => {
        child.kill();
        await completed.catch(() => {});
      });
      await waitFor(() => fs.existsSync(pidFile), 'descendant PID');
      const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(descendantPid > 0);
      dirs.defer(() => {
        if (alive(descendantPid))
          execFileSync(systemBinary('taskkill.exe'), ['/PID', String(descendantPid), '/T', '/F'], {
            stdio: 'ignore',
          });
      });
      child.kill();
      await completed;
      await waitFor(() => !alive(descendantPid), 'cancelled descendant cleanup');
    }
  },
);

test(
  'Windows current-user execution runs pinned Kimi tools and resumes the same real conversation',
  { timeout: 90000 },
  async t => {
    if (!windowsOnly(t)) return;
    const { z } = require('zod');
    const {
      createSession,
      createExternalTool,
      bundledExecutable,
      KIMI_CODE_VERSION,
    } = require('../src/code-session.cjs');
    const { configToml, sessionEnv } = require('../src/model-config.cjs');
    const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');
    const dirs = fixture(t);
    const model = await startModel({
      calls: [
        { name: 'windows_host_probe', arguments: { value: 'WINDOWS_HOST_OK' } },
        {
          name: 'Bash',
          arguments: {
            command: 'echo WINDOWS_CODE_OK > windows-code.txt',
            description: 'Write the Windows sandbox marker',
          },
        },
      ],
      success: 'WINDOWS_CODE_OK',
    });
    dirs.defer(() => model.close());
    const profile = {
      provider: 'openai_legacy',
      endpoint: model.endpoint,
      model: 'controlled',
      contextSize: 32768,
      thinking: false,
    };
    fs.writeFileSync(path.join(dirs.share, 'config.toml'), configToml(profile));
    fs.writeFileSync(path.join(dirs.share, 'mcp.json'), '{}');
    const sandbox = createBoundary(dirs, {
      executable: bundledExecutable(),
      kimiProjectAccess: true,
      environment: { ...process.env, ...sessionEnv(profile, 'windows-local-fixture') },
    });
    dirs.defer(() => sandbox.close());
    let hostCalls = 0;
    let approvals = 0;
    const options = {
      executable: sandbox.executable,
      workDir: sandbox.workDir,
      projectDir: dirs.project,
      shareDir: dirs.share,
      env: sandbox.env,
      envIsolated: sandbox.envIsolated,
      spawn(...args) {
        const child = sandbox.spawn(...args);
        child.stderr.on('data', chunk => t.diagnostic(chunk.toString().trim()));
        return child;
      },
      externalTools: [
        createExternalTool({
          name: 'windows_host_probe',
          description: 'Exercise the real Windows host MCP callback',
          parameters: z.object({ value: z.literal('WINDOWS_HOST_OK') }),
          handler: async () => {
            hostCalls++;
            return { output: 'WINDOWS_HOST_OK' };
          },
        }),
      ],
    };
    const sessions = [];
    dirs.defer(async () => {
      await Promise.allSettled(sessions.map(session => session.close()));
    });
    async function run(session, prompt) {
      const turn = session.prompt(prompt);
      let answer = '';
      for await (const event of turn) {
        if (event.type === 'ApprovalRequest') {
          approvals++;
          await turn.approve(event.payload.id, 'approve');
        }
        if (event.type === 'ContentPart') answer += event.payload.text || '';
      }
      assert.equal((await turn.result).status, 'finished');
      assert.match(answer, /WINDOWS_CODE_OK/);
    }
    const first = createSession(options);
    sessions.push(first);
    await run(first, 'WINDOWS_FIRST: run the host probe and approved shell marker.');
    assert.equal(KIMI_CODE_VERSION, '2.1.1');
    assert.equal(hostCalls, 1);
    assert.ok(approvals >= 1, 'the native shell must request approval');
    assert.equal(
      fs.readFileSync(path.join(sandbox.workDir, 'windows-code.txt'), 'utf8').trim(),
      'WINDOWS_CODE_OK',
    );
    const identity = { sessionId: first.sessionId, nativeId: first.nativeId };
    await first.close();
    const resumed = createSession({
      ...options,
      sessionId: identity.sessionId,
      resumeRequired: true,
    });
    sessions.push(resumed);
    await run(resumed, 'WINDOWS_SECOND: continue the saved conversation.');
    assert.equal(resumed.sessionId, identity.sessionId);
    assert.equal(resumed.nativeId, identity.nativeId);
    assert.equal(hostCalls, 1, 'resume must not replay the host callback');
    assert.equal(model.requests.length, 4);
    assert.match(JSON.stringify(model.requests.at(-1).messages), /WINDOWS_FIRST/);
    const snapshot = await resumed.diagnosticSnapshot();
    assert.equal(snapshot[0].format, 'kimi-code-server-v1');
    assert.match(JSON.stringify(snapshot), /WINDOWS_SECOND/);
  },
);

test(
  'Windows shared Agent starts a chat with nested settings storage and reports current-user permissions',
  { timeout: 60000 },
  async t => {
    if (!windowsOnly(t)) return;
    const { KimiSession } = require('../src/index.cjs');
    const { bundledExecutable } = require('../src/code-session.cjs');
    const { validateProfile, writeCliConfig, sessionEnv } = require('../src/model-config.cjs');
    const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');
    const dirs = fixture(t);
    const model = await startModel({ calls: [], success: 'WINDOWS_CHAT_OK' });
    dirs.defer(() => model.close());
    const profile = validateProfile({
      provider: 'openai_legacy',
      endpoint: model.endpoint,
      model: 'windows-chat-controlled',
      contextSize: 32768,
      thinking: false,
    });
    const runtime = {
      profile,
      apiKey: 'windows-chat-fixture',
      shareDir: writeCliConfig(path.join(dirs.state, 'model'), profile),
      executable: bundledExecutable(),
      env: sessionEnv(profile, 'windows-chat-fixture'),
      revision: 0,
    };
    const events = [];
    const session = new KimiSession(
      dirs.project,
      () => ({ domain: 'test', stage: 'test', capabilityIds: [], skills: [], tools: [] }),
      () => null,
      () => null,
      event => events.push(event),
      () => runtime,
      undefined,
      {
        directory: path.join(dirs.state, 'logs'),
        protectedPaths: [dirs.state],
        resolveSession: () => ({
          id: 'windows-chat-session',
          shareDir: path.join(dirs.state, 'chats', 'sessions', 'windows-chat-session'),
          initialized: false,
        }),
      },
    );
    dirs.defer(() => session.close());
    await session.run('WINDOWS_CURRENT_USER_CHAT');
    assert.deepEqual(
      events.filter(event => event.type === 'error'),
      [],
    );
    assert.ok(
      events.some(
        event =>
          event.type === 'execution-boundary' &&
          event.mechanism === 'windows-current-user' &&
          event.osIsolation === false &&
          event.projectWritable === true,
      ),
    );
    assert.ok(model.requests.length > 0);
    const messages = JSON.stringify(model.requests[0].messages);
    assert.match(messages, /there is no OS write isolation/);
    assert.doesNotMatch(messages, /Native working directory is isolated session scratch/);
  },
);
