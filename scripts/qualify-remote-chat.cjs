'use strict';
// Opt-in real model + TaskService acceptance. Import and inject a normally
// authenticated AuthManager; this module never restores/extracts saved tokens.
// No fake fetch, Session, tools, gateway, model or Electron is used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const DEFAULT_REPO = path.resolve(__dirname, '..');
const PLAN = 'project.remote.plan',
  PREPARE = 'project.remote.prepare';
const FILE = 'recipe.json',
  TOOL = 'cad.freecad.build',
  EDIT = 'project.files.apply';
const sha = value => createHash('sha256').update(value).digest('hex');
function redact(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      /^(authorization|apiKey|access_?token|refresh_?token|credential|password|secret|principal)$/i.test(
        key,
      )
        ? '[redacted]'
        : item,
    ),
  );
}
function privateDirectory(prefix) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(result, 0o700);
  return result;
}
function modulesAt(repo) {
  const requireRoot = createRequire(path.join(repo, 'package.json'));
  return suffix => {
    const source = path.join(repo, 'packages', suffix);
    return requireRoot(fs.existsSync(source) ? source : '@industrial-agent-harness/' + suffix);
  };
}
function syntheticCase() {
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
  return { inputs, files: { [FILE]: Buffer.from(JSON.stringify(inputs, null, 2) + '\n') } };
}
function createMemoryAccount({ repo = DEFAULT_REPO, config, directory } = {}) {
  const requireRepo = modulesAt(repo);
  const { AuthManager, SessionStore } = requireRepo('harness-auth/src/index.cjs');
  directory ||= privateDirectory('pr230-account-');
  // SessionStore defaults to memory-only; no plaintext or OS secret store.
  const store = new SessionStore({ directory });
  assert.equal(store.persistent(), false);
  return new AuthManager({ config, store });
}
function startManualLogin(account, { onAuthorization = () => {} } = {}) {
  // The ordinary PKCE manager owns verifier/state and code exchange. This bridge
  // only forwards the public login URL and accepts code#state in memory.
  const listener = url => onAuthorization(url);
  account.on('manual-authorization', listener);
  const completion = account
    .login({ manualOnly: true })
    .finally(() => account.removeListener('manual-authorization', listener));
  completion.catch(() => {});
  return {
    completion,
    submitCode: value => account.submitCode(value),
    cancel: () => account.cancel(),
  };
}
function permutations(items) {
  if (!items.length) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]),
  );
}
function requestHash(toolId, version, stateId, inputs) {
  return sha(JSON.stringify({ toolId, version, stateId, inputs }));
}
// Acceptance-only pre-dispatch guard. It delegates unchanged to the real
// Runtime; it neither simulates tools nor creates a successful result.
function guardSyntheticRuntime(
  runtime,
  { before, after, inputs, state, hostOnlyEnv = [], onFailure = () => {} },
) {
  let remoteAttempts = 0;
  const execute = runtime.execute.bind(runtime);
  const guardedExecute = async (request, policy = {}) => {
    try {
      const current = state();
      assert.equal(policy.taskId, current.turnId, 'Action belongs to another task.');
      if (request.toolId === 'project.files.read') {
        assert.deepEqual(request.inputs, { path: FILE });
      } else if (request.toolId === PLAN) {
        assert.equal(current.planned, false, 'A second plan is outside this acceptance.');
        assert.deepEqual(
          { ...request.inputs, remember: request.inputs.remember ?? true },
          { files: [FILE], tools: [TOOL], remember: true },
        );
      } else if (request.toolId === PREPARE) {
        assert.equal(current.prepared, false, 'A second preparation is outside this acceptance.');
        assert.ok(current.reviewId, 'Plan the task first.');
        assert.deepEqual(request.inputs, { reviewId: current.reviewId });
      } else if (request.toolId === EDIT) {
        assert.equal(current.completedRemoteRuns, 1);
        assert.equal(current.edited, false);
        assert.deepEqual(request.inputs, {
          changes: [{ path: FILE, content: after, expectedSha256: sha(before) }],
        });
      } else if (request.toolId === TOOL) {
        assert.ok(current.prepared, 'Prepare the approved batch first.');
        assert.ok(remoteAttempts < 2, 'Only two real CAD calls are authorized.');
        assert.equal(
          current.completedRemoteRuns,
          remoteAttempts,
          'Do not retry or overlap an uncertain CAD call.',
        );
        assert.deepEqual(
          request.inputs,
          inputs,
          'CAD inputs differ from the exact authorized fixture.',
        );
        assert.equal(current.edited, remoteAttempts === 1);
        assert.equal(
          fs.readFileSync(path.join(current.projectDir, FILE), 'utf8'),
          remoteAttempts === 0 ? before : after,
        );
        remoteAttempts++;
      } else {
        throw Error('Action is outside this acceptance scope: ' + request.toolId);
      }
    } catch (error) {
      onFailure(error);
      throw error;
    }
    return execute(request, policy);
  };
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'execute') return guardedExecute;
      if (property === 'hostOnlyEnv')
        return [...new Set([...(target.hostOnlyEnv || []), ...hostOnlyEnv])];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function createChatAcceptance({
  repo = DEFAULT_REPO,
  account,
  endpoint = account?.config.remoteOrigin,
  modelProfile,
  executable,
  environment = process.env,
  onProgress = () => {},
} = {}) {
  const requireRepo = modulesAt(repo);
  const { TaskService } = requireRepo('harness-application/src/index.cjs');
  const { RemoteSettings } = requireRepo('harness-core/src/index.cjs');
  const { AuthManager } = requireRepo('harness-auth/src/index.cjs');
  const { createModelProxy } = requireRepo('harness-auth/src/model-proxy.cjs');
  const { defaults, validateProfile, writeCliConfig, sessionEnv } = requireRepo(
    'agent-kimi/src/model-config.cjs',
  );
  const { KimiSession, KIMI_CODE_VERSION, bundledExecutable } = requireRepo(
    'agent-kimi/src/index.cjs',
  );
  if (!(account instanceof AuthManager))
    throw Error('Inject the real, normally authenticated AuthManager.');
  if (!endpoint || endpoint !== account.config.remoteOrigin)
    throw Error('Use the confirmed remote endpoint bound to this AuthManager.');
  if (!modelProfile?.provider || !modelProfile.model)
    throw Error('Pass the confirmed modelProfile.provider and modelProfile.model.');
  // Validates config locally. Do not store a proxy key or call either service.
  const selectedProfile = validateProfile({
    ...defaults,
    ...modelProfile,
    endpoint: account.config.modelBaseUrl,
  });
  const root = privateDirectory('pr230-chat-');
  const projectDir = path.join(root, 'project'),
    evidenceDir = path.join(root, 'evidence');
  for (const directory of [projectDir, evidenceDir]) fs.mkdirSync(directory, { mode: 0o700 });
  const spec = syntheticCase();
  const before = spec.files[FILE].toString('utf8'),
    after = before + '\n';
  fs.writeFileSync(path.join(projectDir, FILE), before, { flag: 'wx', mode: 0o600 });
  const isolatedEnvironment = {
    ...environment,
    INDUSTRIAL_REMOTE_SERVICE_URL: endpoint,
    INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config'),
    INDUSTRIAL_HARNESS_PACK_STORE: path.join(root, 'unused-pack-store'),
  };
  // Keep inherited host credentials out of the model process. The only model
  // key it needs is the restricted loopback proxy key supplied at startup.
  const hostOnlyEnv = Object.keys({ ...process.env, ...environment }).filter(
    name =>
      name !== 'HARNESS_MODEL_API_KEY' &&
      /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(name),
  );
  const settings = new RemoteSettings({
    directory: path.join(root, 'remote'),
    environment: isolatedEnvironment,
    account,
  });
  const project = { id: projectDir, path: projectDir, domain: 'cad' };
  const save = (name, value) =>
    fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(redact(value), null, 2) + '\n', {
      mode: 0o600,
    });
  const emit = (phase, detail) => onProgress(phase, redact(detail));
  const summary = {
    mode: 'real-TaskService-real-model-real-remote-no-Electron',
    root,
    projectDir,
    evidenceDir,
    endpoint,
    model: selectedProfile.model,
    provider: selectedProfile.provider,
    modelBaseUrl: selectedProfile.endpoint,
    kimiVersion: KIMI_CODE_VERSION,
    selectedFiles: [FILE],
    selectedTools: [TOOL],
    initialSha256: sha(before),
    changedSha256: sha(after),
    expectedApprovals: { batch: 1, localEdit: 1, remoteTool: 0, other: 0 },
  };
  save('fixture.json', summary);
  // All engineering inputs are synthetic and exact; no application user files.
  const prompt = `完成本隔离测试工程的一次真实远端 CAD 对话任务。只能使用工业 Runtime 工具，不使用 Shell、原生文件写入、外部 MCP、子代理或后台任务。不要另开任务，不要询问用户，不要自行重试失败或不确定的远端动作；失败时明确停止。
1. 先通过 project.files.read 读取 ${FILE}，再用 industrial_artifact_read 读文件报告，取得完整内容与 SHA-256。文件是完整 cad.freecad.build inputs（recipe 和 expect），按原值使用。需要工具指南时调用 industrial_tool_describe。
2. 通过 project.remote.plan 选择唯一文件 ["${FILE}"]、唯一远端工具 ["${TOOL}"]、remember:true。读返回的计划 artifact，取得 reviewId；此时没有上传。
3. 通过 project.remote.prepare 提交该 reviewId，等待一次本任务批量授权。读 ready 回执后才继续；不要把 ready 当成工程验证通过。
4. 用 ${FILE} 中原样 inputs 调用 ${TOOL} 一次。等待 completed、verification passed 和实际 artifacts。若失败立即停止，不能重试。
5. 用 project.files.apply 修改唯一 ${FILE}：保持读取到的全部原文，只在文件末尾追加恰好一个换行字符，expectedSha256 使用第 1 步读取的 SHA-256。此独立本地编辑会接受一次明确授权；不得修改其他内容或文件。更新 expectedStateId 使用每次工业动作返回的 stateId。
6. 在同一任务内再次用原样 inputs 调用 ${TOOL}，不再 plan 或 prepare。让客户端自动同步已批准文件的新版本；不得手动上传或绕过授权。等待 completed、verification passed 和实际 artifacts。
7. 通过 industrial_artifact_read 检查至少一个远端 report artifact，并在最后简短报告两次 actionId、验证结果和 artifacts。不得把猜测、环境 ready 或进程退出成功描述为 CAD 验证成功。完成后立即结束，不再执行第三次 CAD。`;
  fs.writeFileSync(path.join(evidenceDir, 'prompt.txt'), prompt, { mode: 0o600 });
  let tasks,
    entry,
    proxy,
    runtime,
    timer,
    fatal,
    closing = false;
  let approvalsQueue = Promise.resolve();
  const events = [],
    approvals = [],
    actions = [],
    remoteRuns = [],
    reportReads = [];
  const toolCalls = new Map();
  let plan, planResult, prepareResult, editResult, allowedTurnId;
  const allowedTools = new Set(['project.files.read', PLAN, PREPARE, EDIT, TOOL]);
  function fail(error) {
    if (!fatal) {
      fatal = error;
      save('observer-failure.json', { message: error.message });
    }
    if (entry && !closing) void Promise.resolve(tasks.cancel(entry, 'interrupted')).catch(() => {});
  }
  function artifactJSON(result) {
    return JSON.parse(runtime.readArtifact(result.artifacts[0].id).content.toString('utf8'));
  }
  function assertPlan(value, metadata) {
    assert.equal(value.domain, 'cad');
    assert.equal(value.destination, endpoint);
    assert.equal(value.remember, true);
    assert.equal(value.ownerId, entry.id);
    assert.equal(value.taskId, metadata.turnId);
    assert.equal(value.explicitTools, true);
    assert.deepEqual(value.tools, [TOOL]);
    assert.deepEqual(
      value.files.map(file => ({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })),
      [{ path: FILE, sha256: sha(before), sizeBytes: Buffer.byteLength(before) }],
    );
    assert.match(value.manifestDigest, /^[a-f0-9]{64}$/);
    assert.equal(settings.project(projectDir, 'cad').snapshotId || null, null);
  }
  async function decide(event, metadata) {
    const record = {
      id: event.id,
      action: event.action,
      turnId: metadata.turnId,
      stateId: event.stateId,
      decision: 'reject',
      category: 'other',
    };
    approvals.push(record);
    try {
      assert.equal(metadata.turnId, allowedTurnId);
      assert.equal(event.preview?.truncated, false);
      assert.equal(event.stateId, (await runtime.inspect()).id);
      const descriptor = runtime.descriptors().find(item => item.id === event.action);
      assert.ok(descriptor, 'Only canonical industrial approvals are eligible.');
      if (event.action === PREPARE) {
        record.category = 'batch';
        assert.ok(plan && planResult);
        assert.equal(approvals.filter(item => item.category === 'batch').length, 1);
        assertPlan(plan, metadata);
        const request = {
          toolId: PREPARE,
          expectedStateId: event.stateId,
          inputs: { reviewId: plan.reviewId },
        };
        assert.equal(
          event.preview.requestSha256,
          requestHash(PREPARE, descriptor.version, event.stateId, request.inputs),
        );
        assert.deepEqual(
          event.preview,
          runtime.approvalPreview(request, { taskId: metadata.turnId }),
        );
        save('batch-approval.json', { ...record, preview: event.preview, plan });
      } else if (event.action === EDIT) {
        record.category = 'localEdit';
        assert.equal(remoteRuns.length, 1);
        assert.equal(remoteRuns[0].verification, 'passed');
        assert.equal(approvals.filter(item => item.category === 'localEdit').length, 1);
        assert.equal(fs.readFileSync(path.join(projectDir, FILE), 'utf8'), before);
        const change = { path: FILE, content: after, expectedSha256: sha(before) };
        // The preview binds the complete request bytes. Accept harmless JSON key
        // order differences, but no extra fields, files, deletes or content.
        const hashes = permutations(Object.keys(change)).map(keys =>
          requestHash(EDIT, descriptor.version, event.stateId, {
            changes: [Object.fromEntries(keys.map(key => [key, change[key]]))],
          }),
        );
        assert.ok(
          hashes.includes(event.preview.requestSha256),
          'Local edit differs from the exact approved newline-only change.',
        );
        save('local-edit-approval.json', { ...record, preview: event.preview });
      } else {
        record.category = event.action === TOOL ? 'remoteTool' : 'other';
        throw Error(
          'Unexpected approval: only the exact planned batch and one exact local edit are approved.',
        );
      }
      record.decision = 'approve';
      await tasks.approve(entry, event.id, 'approve');
      emit('approval', record);
    } catch (error) {
      record.reason = error.message;
      await tasks.approve(entry, event.id, 'reject').catch(() => {});
      throw error;
    } finally {
      save('approvals.json', approvals);
    }
  }
  function observe(event, metadata) {
    events.push({ ...event, metadata });
    fs.appendFileSync(
      path.join(evidenceDir, 'events.jsonl'),
      JSON.stringify(redact({ ...event, metadata })) + '\n',
      { mode: 0o600 },
    );
    if (event.type === 'tool') toolCalls.set(event.id, event);
    if (event.type === 'tool-result' && !event.error) {
      const call = toolCalls.get(event.id);
      if (call?.name === 'industrial_artifact_read') {
        try {
          const args =
            typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
          const report = remoteRuns
            .flatMap(run => run.artifactChecks)
            .find(ref => ref.id === args?.artifactId && ref.kind.startsWith('report.'));
          if (report)
            reportReads.push({ artifactId: report.id, kind: report.kind, toolCallId: event.id });
        } catch {
          /* Partial argument events are not proof of an artifact read. */
        }
      }
    }
    if (event.type === 'approval') {
      approvalsQueue = approvalsQueue.then(() => decide(event, metadata)).catch(fail);
      return;
    }
    if (event.type === 'question') {
      fail(Error('The synthetic test unexpectedly asked a question.'));
      return;
    }
    if (event.type !== 'industrial-result') return;
    try {
      assert.equal(metadata.turnId, allowedTurnId);
      const result = event,
        toolId = result.action.toolId;
      assert.ok(allowedTools.has(toolId), 'Model used an action outside this acceptance scope.');
      actions.push(result);
      save(`action-${actions.length}.json`, result);
      assert.equal(result.action.status, 'completed', result.action.diagnostics.join('\n'));
      if (toolId === PLAN) {
        assert.equal(plan, undefined, 'Do not silently replan or retry this acceptance.');
        planResult = result;
        plan = artifactJSON(result);
        assertPlan(plan, metadata);
        save('immutable-plan.json', plan);
        emit('model-planned-without-upload', {
          actionId: result.action.id,
          reviewId: plan.reviewId,
        });
      } else if (toolId === PREPARE) {
        assert.equal(prepareResult, undefined);
        prepareResult = result;
        const ready = artifactJSON(result),
          session = settings.sessionBinding(projectDir, 'cad', entry.id);
        assert.equal(ready.status, 'ready');
        assert.deepEqual(ready.tools, [TOOL]);
        assert.equal(session.status, 'released');
        save('ready-and-preparation-release.json', { ready, session });
        emit('model-prepared-and-released', { actionId: result.action.id, status: session.status });
      } else if (toolId === EDIT) {
        assert.ok(prepareResult);
        assert.equal(remoteRuns.length, 1);
        assert.equal(editResult, undefined);
        editResult = result;
        assert.equal(fs.readFileSync(path.join(projectDir, FILE), 'utf8'), after);
        emit('model-edited-approved-file', { actionId: result.action.id, sha256: sha(after) });
      } else if (toolId === TOOL) {
        assert.ok(prepareResult);
        assert.ok(remoteRuns.length < 2);
        assert.deepEqual(result.action.inputs, spec.inputs);
        if (remoteRuns.length) assert.ok(editResult);
        assert.equal(result.verification.status, 'passed', result.verification.reason);
        assert.ok(result.artifacts.length, 'Actual remote artifacts required.');
        const journal = settings.task(projectDir, 'cad', entry.id);
        assert.equal(journal.needsImport, false);
        assert.equal(journal.sessionRelease?.status, 'released');
        const binding = settings.project(projectDir, 'cad');
        const snapshotId = binding.snapshotId;
        assert.deepEqual(binding.files, [FILE]);
        const expectedHash = remoteRuns.length === 0 ? sha(before) : sha(after);
        assert.equal(result.action.inputHashes[FILE], expectedHash);
        assert.equal(binding.manifestDigest, settings.snapshot(projectDir, [FILE]).digest);
        assert.equal(journal.snapshotId, snapshotId);
        const artifactChecks = result.artifacts.map(ref => {
          const bytes = fs.readFileSync(path.join(projectDir, ref.relativePath));
          assert.equal(bytes.length, ref.sizeBytes);
          assert.equal(sha(bytes), ref.sha256);
          assert.deepEqual(runtime.get('artifact', ref.id), ref);
          return { id: ref.id, kind: ref.kind, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
        });
        for (const kind of ['run', 'action', 'state', 'verification', 'checkpoint'])
          assert.deepEqual(runtime.get(kind, result[kind].id), result[kind]);
        const run = {
          actionId: result.action.id,
          requestId: journal.requestId,
          snapshotId,
          verification: result.verification.status,
          release: journal.sessionRelease,
          artifactChecks,
          inputHashes: result.action.inputHashes,
        };
        if (remoteRuns.length) assert.notEqual(snapshotId, remoteRuns[0].snapshotId);
        remoteRuns.push(run);
        save(`remote-${remoteRuns.length}.json`, { run, journal });
        if (journal.requestId) {
          const receipt = path.join(
            settings.directory,
            'remote-receipts',
            journal.requestId + '.json',
          );
          if (fs.existsSync(receipt))
            save(`remote-${remoteRuns.length}-receipt.json`, JSON.parse(fs.readFileSync(receipt)));
        }
        emit('model-executed-verified-and-released', run);
      }
    } catch (error) {
      fail(error);
    }
  }
  async function run({ approved = false, timeoutMs = 600000 } = {}) {
    if (approved !== true)
      throw Error(
        'Explicit approval required for this synthetic conversation, exact file upload, and two named CAD executions.',
      );
    if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 1800000)
      throw Error('timeoutMs must be 30000–1800000.');
    if (!account.view().user) throw Error('Complete normal AuthManager login before run.');
    fs.writeFileSync(
      path.join(evidenceDir, 'attempt.json'),
      JSON.stringify({
        startedAt: new Date().toISOString(),
        approval: 'one exact synthetic batch, one exact local newline edit, two CAD executions',
        timeoutMs,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    try {
      settings.setLocation(projectDir, 'cad', 'remote');
      // Fixture registry is only local metadata. Live profiles, capabilities,
      // invocation and artifacts always come from the real protected service.
      const registry = {
        domains: [{ id: 'cad', title: 'CAD', builtin: true }],
        skills: [],
        capabilities: [],
        runtimePacks: [],
        providerPacks: [],
      };
      let config;
      tasks = new TaskService({
        environment: isolatedEnvironment,
        getRegistry: () => registry,
        getConfig: () => config,
        chatDirectory: path.join(root, 'chats'),
        resourceDirectory: path.join(root, 'resources'),
        runtimeOptions: { directory: path.join(root, 'runtime'), remoteSettings: settings },
        contextOptions: { directory: path.join(root, 'context') },
        logDirectory: path.join(root, 'diagnostics'),
        onEvent: observe,
      });
      assert.equal(tasks.Session, KimiSession);
      // Wrap the real session facade before prepare/start so the same stable
      // object reaches Kimi. This only limits the operator-approved experiment.
      const bundle = tasks.projects.get(project, registry);
      const forSession = bundle.runtime.forSession.bind(bundle.runtime);
      const guardedSessions = new Map();
      bundle.runtime.forSession = chatId => {
        if (!guardedSessions.has(chatId))
          guardedSessions.set(
            chatId,
            guardSyntheticRuntime(forSession(chatId), {
              before,
              after,
              inputs: spec.inputs,
              hostOnlyEnv,
              state: () => ({
                turnId: allowedTurnId,
                projectDir,
                planned: Boolean(planResult),
                reviewId: plan?.reviewId,
                prepared: Boolean(prepareResult),
                edited: Boolean(editResult),
                completedRemoteRuns: remoteRuns.length,
              }),
              onFailure: fail,
            }),
          );
        return guardedSessions.get(chatId);
      };
      const chat = tasks.chats.create(projectDir, 'cad');
      entry = tasks.resume(project, chat.id);
      const resolved = await tasks.prepare(entry, { task: prompt });
      runtime = entry.runtimeBundle.runtime;
      assert.equal(settings.project(projectDir, 'cad').snapshotId || null, null);
      assert.ok(resolved.scope.tools.includes(PLAN));
      assert.ok(!resolved.scope.tools.includes(TOOL));
      save('local-chat-before-upload.json', {
        chatId: entry.id,
        scope: resolved.scope,
        state: await runtime.inspect(),
        sessionClass: tasks.Session.name,
      });
      emit('local-chat-opened-without-upload', { chatId: entry.id });
      await account.serviceToken('model', account.config.modelBaseUrl);
      proxy = await createModelProxy({ auth: account });
      const profile = validateProfile({ ...selectedProfile, endpoint: proxy.endpoint });
      config = {
        profile,
        apiKey: proxy.apiKey,
        revision: 0,
        executable: executable || bundledExecutable(),
        shareDir: writeCliConfig(path.join(root, 'model'), profile),
        env: sessionEnv(profile, proxy.apiKey),
        environment: isolatedEnvironment,
        disabledMcpServers: entry.disabled.mcpServers,
        externalServers: entry.externalServers,
        approvalMode: 'ask',
      };
      // prepare creates the durable turn before Kimi starts emitting events.
      allowedTurnId = entry.preparedTurn.id;
      timer = setTimeout(
        () => fail(Error('Conversation acceptance timed out; do not replay uncertain work.')),
        timeoutMs,
      );
      const started = await tasks.start(entry, prompt, { waitForBackground: true });
      assert.equal(started.turnId, allowedTurnId);
      const completion = await started.completion;
      await approvalsQueue;
      if (fatal) throw fatal;
      assert.equal(completion.status, 'completed', JSON.stringify(completion));
      assert.equal(remoteRuns.length, 2, 'The model must actually execute both CAD actions.');
      assert.ok(planResult && prepareResult && editResult);
      const counts = Object.fromEntries(
        ['batch', 'localEdit', 'remoteTool', 'other'].map(category => [
          category,
          approvals.filter(item => item.category === category).length,
        ]),
      );
      assert.deepEqual(counts, summary.expectedApprovals);
      assert.ok(approvals.every(item => item.decision === 'approve'));
      const response = events
        .filter(event => event.type === 'text')
        .map(event => event.text || '')
        .join('');
      assert.ok(response.trim(), 'Actual model response required.');
      for (const remoteRun of remoteRuns)
        assert.ok(
          response.includes(remoteRun.actionId),
          'Model must report both actual action identities.',
        );
      assert.ok(reportReads.length, 'Model must successfully read a real remote report artifact.');
      save('model-report-reads.json', reportReads);
      const history = tasks.history(project, entry.id);
      save('history.json', history);
      save('completion.json', completion);
      const report = {
        ...summary,
        chatId: entry.id,
        turnId: allowedTurnId,
        passed: true,
        finishedAt: new Date().toISOString(),
        approvals: counts,
        totalApprovalPrompts: approvals.length,
        modelEditedApprovedInput: true,
        reportReads,
        remoteRuns,
        completion,
      };
      // A successful report is durable only after native/runtime cleanup has
      // completed; otherwise a cleanup failure could leave a misleading pass.
      clearTimeout(timer);
      closing = true;
      await tasks.close();
      tasks = undefined;
      proxy.close();
      proxy = undefined;
      save('acceptance.json', report);
      emit('passed', report);
      return report;
    } catch (error) {
      const failure = {
        ...summary,
        failedAt: new Date().toISOString(),
        message: error.message,
        approvals,
        remoteRuns,
        pending: entry ? settings.task(projectDir, 'cad', entry.id) : null,
      };
      save('failure.json', failure);
      emit('failed', failure);
      throw error;
    } finally {
      clearTimeout(timer);
      closing = true;
      try {
        await tasks?.close();
      } finally {
        proxy?.close();
      }
      // The caller owns AuthManager. It is neither closed nor persisted here.
    }
  }
  return { summary, prompt, run };
}
module.exports = {
  createChatAcceptance,
  createMemoryAccount,
  startManualLogin,
  guardSyntheticRuntime,
};
if (require.main === module) {
  process.stdout.write(
    'PR230 real conversation acceptance (import-only; no credentials read and no network on CLI):\n' +
      'const {createChatAcceptance,createMemoryAccount,startManualLogin}=require("./scripts/qualify-remote-chat.cjs");\n' +
      '// Use normal AuthManager PKCE sign-in with a memory-only account, or inject an existing account.\n' +
      'const test=createChatAcceptance({repo,account,modelProfile:{provider:"openai_legacy",model:confirmedModel}});\n' +
      'await test.run({approved:true});\n' +
      'Expected user approvals: batch 1 + exact local edit 1; remote-tool approval 0.\n' +
      'Requires Node >=24, actual Kimi 2.1.1 and production process sandbox; Linux x86-64 requires bwrap + namespaces.\n',
  );
}
