const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { startToolServer, createExternalTool } = require('./tool-server.cjs');

const KIMI_CODE_VERSION = '2.1.1';
const IDENTITY_FILE = 'harness-native-session.json';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolName = name => String(name || '').replace(/^mcp__harness_adapter__/, '');

function questionAnswer(item, answer) {
  if (item.multi_select) {
    // The existing UI sends labels joined by ', '. Match complete labels first,
    // including labels that contain commas, and retain remaining custom text.
    const ids = [];
    let rest = answer;
    while (rest) {
      const option = item.options
        .filter(
          option =>
            !ids.includes(option.id) &&
            (rest === option.label || rest.startsWith(option.label + ', ')),
        )
        .sort((a, b) => b.label.length - a.label.length)[0];
      if (!option) break;
      ids.push(option.id);
      rest = rest.slice(option.label.length).replace(/^, /, '');
    }
    if (ids.length)
      return rest
        ? { kind: 'multi_with_other', option_ids: ids, other_text: rest }
        : { kind: 'multi', option_ids: ids };
  }
  const selected = item.options.find(option => option.label === answer);
  return selected ? { kind: 'single', option_id: selected.id } : { kind: 'other', text: answer };
}

function bundledExecutable() {
  return require.resolve('@moonshot-ai/kimi-code/dist/main.mjs');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// This queue carries transport events only. The upstream Kimi runtime owns
// prompting, tool execution, compaction and conversation persistence.
class Turn {
  constructor(session) {
    this.session = session;
    this.queue = [];
    this.waiter = undefined;
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.result.catch(() => {});
    this.promptId = crypto.randomUUID();
    this.offsets = new Map();
    this.calls = new Map();
  }
  push(event) {
    if (!this.ended) {
      this.queue.push(event);
      this.waiter?.();
      this.waiter = undefined;
    }
  }
  finish(result, error) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    if (error) this.reject(error);
    else this.resolve(result);
    this.waiter?.();
    this.waiter = undefined;
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift();
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise(resolve => {
        this.waiter = resolve;
      });
    }
  }
  async interrupt() {
    this.cancelled = true;
    if (this.session.baseUrl && this.session.nativeId)
      await this.session.request(`sessions/${encodeURIComponent(this.session.nativeId)}:abort`, {
        method: 'POST',
        body: {},
      });
  }
  approve(id, response) {
    return this.session.request(
      `sessions/${encodeURIComponent(this.session.nativeId)}/approvals/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: {
          decision: response === 'reject' ? 'rejected' : 'approved',
          ...(response === 'approve_for_session' ? { scope: 'session' } : {}),
        },
      },
    );
  }
  respondQuestion(_rpcId, id, answers) {
    const pending = this.session.questions.get(id);
    if (!pending) throw Error('This question is no longer pending.');
    if (!Object.keys(answers).length)
      return this.session.request(
        `sessions/${encodeURIComponent(this.session.nativeId)}/questions/${encodeURIComponent(id)}:dismiss`,
        { method: 'POST', body: {} },
      );
    const converted = Object.fromEntries(
      pending.map(item => [item.id, questionAnswer(item, answers[item.question])]),
    );
    return this.session.request(
      `sessions/${encodeURIComponent(this.session.nativeId)}/questions/${encodeURIComponent(id)}`,
      { method: 'POST', body: { answers: converted, method: 'click' } },
    );
  }
}

function promptContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map(part => {
    if (part.type === 'text') return part;
    if (part.type === 'image_url') {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
        part.image_url?.url || '',
      );
      if (!match) throw Error('Kimi Code image inputs must be inline image data.');
      return { type: 'image', source: { kind: 'base64', media_type: match[1], data: match[2] } };
    }
    throw Error('Unsupported Kimi Code prompt content.');
  });
}

function redactedNative(value, key = '', secrets = []) {
  if (typeof value === 'string' && /^(data|base64)$/.test(key))
    return `[media redacted, ${value.length} chars]`;
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[REDACTED_TOKEN]');
    return value.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redactedNative(item, '', secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactedNative(item, name, secrets)]),
    );
  return value;
}

class CodeSession {
  constructor(options) {
    this.options = options;
    this.agentProfile = options.agentProfile ?? 'agent';
    if (
      typeof this.agentProfile !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(this.agentProfile)
    )
      throw Error('Kimi Code agent profile must be a valid profile name.');
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.home = path.resolve(options.shareDir);
    this.questions = new Map();
    this.cursors = new Set();
    this.controllers = new Set();
    this.subagents = new Map();
    this.tasks = new Map();
    this.taskWaits = new Set();
  }
  async request(route, { method = 'GET', body, timeout = 15000 } = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/${route}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const envelope = await response.json();
      const dismissed =
        route.includes('/questions/') &&
        route.endsWith(':dismiss') &&
        envelope.code === 40909 &&
        envelope.data?.dismissed === true;
      if (!response.ok || (envelope.code !== 0 && !dismissed)) {
        const error = Error(
          `Kimi Code API ${route}: ${envelope.msg || response.status} (${envelope.code})`,
        );
        error.code = envelope.code;
        throw error;
      }
      return envelope.data;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  async initialize() {
    if (!this.initializing)
      this.initializing = this.start().catch(async error => {
        this.failTurns(error);
        await this.close();
        throw error;
      });
    return this.initializing;
  }
  async start() {
    if (this.closed) throw Error('Kimi Code session is closed.');
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.toolServer = await startToolServer(this.options.externalTools || [], this.options.workDir);
    if (this.closed) {
      await this.toolServer.close();
      throw Error('Kimi Code session is closed.');
    }
    const configFile = path.join(this.home, 'mcp.json');
    const mcp = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    mcp.mcpServers ||= {};
    mcp.mcpServers.harness_adapter = this.toolServer.config;
    fs.writeFileSync(configFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });
    this.token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(this.home, 'server.token'), this.token, { mode: 0o600 });
    fs.chmodSync(path.join(this.home, 'server.token'), 0o600);
    const port = await freePort();
    if (this.closed) throw Error('Kimi Code session is closed.');
    this.baseUrl = `http://127.0.0.1:${port}`;
    const executable =
      !this.options.executable || this.options.executable === 'kimi'
        ? bundledExecutable()
        : this.options.executable;
    const script = /\.[cm]?js$/.test(executable);
    this.child = spawn(
      script ? process.execPath : executable,
      [
        ...(script ? [executable] : []),
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--no-open',
      ],
      {
        cwd: this.options.workDir,
        env: {
          ...process.env,
          ...this.options.env,
          KIMI_CODE_HOME: this.home,
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    this.exit = new Promise(resolve =>
      this.child.once('exit', (code, signal) => {
        this.exitError = Error(
          `Kimi Code process exited (${signal || code}). ${this.startupLog || ''}`,
        );
        this.failTurns(this.exitError);
        resolve();
      }),
    );
    this.child.once('error', error => {
      this.exitError = error;
      this.failTurns(error);
    });
    const log = chunk => {
      const raw = chunk.toString();
      let safe = raw.replaceAll(this.token, '[REDACTED_TOKEN]');
      for (const secret of Object.values(this.options.env || {}))
        if (
          typeof secret === 'string' &&
          secret.length > 6 &&
          /KEY|TOKEN|SECRET/.test(
            Object.keys(this.options.env).find(key => this.options.env[key] === secret) || '',
          )
        )
          safe = safe.replaceAll(secret, '[REDACTED_KEY]');
      safe = safe.replaceAll(
        this.toolServer.config.headers.Authorization.slice(7),
        '[REDACTED_TOKEN]',
      );
      this.startupLog = ((this.startupLog || '') + safe).slice(-3000);
    };
    this.child.stdout.on('data', log);
    this.child.stderr.on('data', log);
    const deadline = Date.now() + 30000;
    let meta;
    while (Date.now() < deadline) {
      if (this.closed) throw Error('Kimi Code session is closed.');
      if (this.exitError) throw this.exitError;
      try {
        meta = await this.request('meta', { timeout: 750 });
        break;
      } catch {}
      await delay(100);
    }
    if (!meta) throw Error(`Kimi Code startup timed out. ${this.startupLog || ''}`);
    if (meta.server_version !== KIMI_CODE_VERSION)
      throw Error(`Kimi Code ${KIMI_CODE_VERSION} is required; found ${meta.server_version}.`);
    const identityFile = path.join(this.home, IDENTITY_FILE);
    let workspaceId;
    if (fs.existsSync(identityFile)) {
      const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (
        identity.version !== KIMI_CODE_VERSION ||
        identity.projectDir !== path.resolve(this.options.workDir) ||
        identity.adapterId !== this.sessionId ||
        (identity.agentProfile ?? 'agent') !== this.agentProfile ||
        !/^session_[\w-]+$/.test(identity.nativeId)
      )
        throw Error('Saved Kimi Code session identity is incompatible.');
      this.nativeId = identity.nativeId;
      const profile = await this.request(`sessions/${encodeURIComponent(this.nativeId)}/profile`);
      workspaceId = profile.workspace_id;
      const snapshot = await this.request(`sessions/${encodeURIComponent(this.nativeId)}/snapshot`);
      if (this.options.resumeRequired && !snapshot.messages?.items?.length)
        throw Error(
          'Saved agent context is missing. Open a new chat; the existing history is preserved.',
        );
    } else {
      if (this.options.resumeRequired)
        throw Error(
          'Saved agent context is missing. Open a new chat; the existing history is preserved.',
        );
      const session = await this.request('sessions', {
        method: 'POST',
        body: { metadata: { cwd: this.options.workDir, harness_adapter_id: this.sessionId } },
      });
      this.nativeId = session.id;
      workspaceId = session.workspace_id;
      fs.writeFileSync(
        identityFile,
        JSON.stringify({
          version: KIMI_CODE_VERSION,
          adapterId: this.sessionId,
          nativeId: this.nativeId,
          projectDir: path.resolve(this.options.workDir),
          agentProfile: this.agentProfile,
        }),
        { mode: 0o600 },
      );
    }
    if (
      this.options.projectDir &&
      path.resolve(this.options.projectDir) !== path.resolve(this.options.workDir)
    )
      await this.request(`workspaces/${encodeURIComponent(workspaceId)}/add-dir`, {
        method: 'POST',
        body: { path: this.options.projectDir, persist: false },
      });
    // Force upstream to load the main agent before waiting for asynchronous MCP startup.
    await this.request(`sessions/${encodeURIComponent(this.nativeId)}/snapshot`);
    const expectedServers = Object.keys(mcp.mcpServers);
    const mcpDeadline = Date.now() + 30000;
    while (true) {
      if (this.closed) throw Error('Kimi Code session is closed.');
      const { servers } = await this.request('mcp/servers');
      const failed = servers.find(
        server =>
          expectedServers.includes(server.name) &&
          ['error', 'disconnected'].includes(server.status),
      );
      if (failed)
        throw Error(`Kimi Code MCP ${failed.name} failed: ${failed.last_error || failed.status}`);
      if (
        expectedServers.every(name =>
          servers.some(server => server.name === name && server.status === 'connected'),
        )
      )
        break;
      if (Date.now() > mcpDeadline) throw Error('Kimi Code MCP startup timed out.');
      await delay(100);
    }
    if (this.closed) throw Error('Kimi Code session is closed.');
    await this.connect();
  }
  async connect() {
    const socket = new WebSocket(this.baseUrl.replace(/^http/, 'ws') + '/api/v1/ws', [
      `kimi-code.bearer.${this.token}`,
    ]);
    this.socket = socket;
    const requestId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Kimi Code event subscription timed out.')),
        10000,
      );
      socket.addEventListener('open', () =>
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            id: requestId,
            payload: { session_ids: [this.nativeId] },
          }),
        ),
      );
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(Error('Kimi Code WebSocket connection failed.'));
      });
      socket.addEventListener('message', event => {
        try {
          const frame = JSON.parse(event.data);
          // Kimi uses application-level heartbeats. Reply even while a host
          // tool is running or no turn is active; WebSocket control pongs do
          // not satisfy the native server's heartbeat deadline.
          if (frame.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong', payload: { nonce: frame.payload.nonce } }));
            return;
          }
          if (frame.type === 'ack' && frame.id === requestId) {
            clearTimeout(timer);
            if (frame.code === 0) resolve();
            else reject(Error(`Kimi Code subscription failed: ${frame.msg}`));
          } else this.onFrame(frame);
        } catch (error) {
          this.failTurns(error);
        }
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(Error('Kimi Code event connection closed.'));
        if (!this.closed) {
          this.transportError = Error(
            'Kimi Code event connection closed; the task was not automatically retried.',
          );
          this.failTurns(this.transportError);
        }
      });
    });
  }
  failTurns(error) {
    if (this.closed) return;
    this.active?.finish(null, error);
    this.backgroundTurn?.finish(null, error);
    if (
      [...this.tasks.values()].some(
        task => task.status === 'running' || task.notificationPending,
      ) ||
      [...this.subagents.values()].some(
        child => child.background && ['running', 'awaiting_approval'].includes(child.status),
      )
    )
      this.options.onBackgroundEvent?.({
        type: 'BackgroundFailure',
        payload: { message: error.message },
      });
  }
  prompt(content) {
    if (
      this.closed ||
      (this.active && !this.active.ended) ||
      (this.backgroundTurn && !this.backgroundTurn.ended)
    )
      throw Error('Kimi Code session is closed or busy.');
    const turn = new Turn(this);
    this.active = turn;
    void (async () => {
      await this.initialize();
      if (this.transportError || this.exitError) throw this.transportError || this.exitError;
      if (turn.cancelled || this.closed) {
        turn.finish({ status: 'cancelled' });
        return;
      }
      await this.request(`sessions/${encodeURIComponent(this.nativeId)}/prompts`, {
        method: 'POST',
        body: {
          prompt_id: turn.promptId,
          content: promptContent(content),
          profile: this.agentProfile,
          model: this.options.model || 'industrial',
          thinking: this.options.thinkingEffort ?? (this.options.thinking ? 'high' : 'off'),
          permission_mode: 'manual',
        },
      });
    })().catch(error => turn.finish(null, error));
    return turn;
  }
  onFrame(frame) {
    if (this.closed) return;
    let turn = this.active && !this.active.ended ? this.active : this.backgroundTurn;
    if (frame.session_id !== this.nativeId) return;
    const p = frame.payload || {};
    if (frame.type === 'resync_required') {
      this.failTurns(Error('Kimi Code event resync is required; execution was not retried.'));
      return;
    }
    const control =
      /^(event\.(approval|question)\.|event\.session\.work_changed$|subagent\.|(?:background\.)?task\.)/.test(
        frame.type,
      );
    // Native child approvals share the session control plane, even though their
    // agent and turn identities differ from the main conversation.
    const taskDelivery = frame.type === 'tool.call.started' || frame.type === 'tool.result';
    if (p.agentId && p.agentId !== 'main' && !control && !taskDelivery) return;
    if (!frame.volatile && Number.isSafeInteger(frame.seq)) {
      const id = `${frame.epoch}:${frame.seq}`;
      if (this.cursors.has(id)) return;
      this.cursors.add(id);
      if (this.cursors.size > 2000) this.cursors.delete(this.cursors.values().next().value);
    }
    if (
      (!turn || turn.ended) &&
      frame.type === 'turn.started' &&
      (!p.agentId || p.agentId === 'main')
    ) {
      // Automatic follow-ups are initiated by Kimi's native background task
      // notification policy. Forward them without scheduling or replaying work.
      turn = new Turn(this);
      turn.promptId = p.promptId;
      turn.push = event => this.options.onBackgroundEvent?.(event);
      const finish = turn.finish.bind(turn);
      turn.finish = (result, error) => {
        if (turn.ended) return;
        finish(result, error);
        this.options.onBackgroundEvent?.({
          type: 'BackgroundTurnEnd',
          payload: { result, error: error?.message },
        });
      };
      this.backgroundTurn = turn;
      this.options.onBackgroundEvent?.({ type: 'BackgroundTurnBegin', payload: {} });
    }
    const emit = (type, payload) => {
      const event = { type, payload };
      if (turn && !turn.ended) turn.push(event);
      else this.options.onBackgroundEvent?.(event);
    };
    // Session lifecycle must take effect at receipt time. A native follow-up
    // can start before the consumer drains the completed foreground queue.
    const emitState = (type, payload) => {
      if (this.options.onBackgroundEvent) this.options.onBackgroundEvent({ type, payload });
      else emit(type, payload);
    };
    const acknowledge = taskId => {
      const key = `${p.agentId || 'main'}:${taskId}`;
      const previous = this.tasks.get(key);
      if (previous && previous.status !== 'running' && !previous.notified) {
        const state = { ...previous, notified: true, notificationPending: false };
        this.tasks.set(key, state);
        emitState('BackgroundTaskState', state);
      }
    };
    const waitKey = `${p.agentId || 'main'}:${p.toolCallId}`;
    if (frame.type === 'tool.call.started' && p.name === 'WaitFor') this.taskWaits.add(waitKey);
    if (frame.type === 'tool.result' && this.taskWaits.delete(waitKey)) {
      const result = p.result || p;
      const output = result.output;
      if (
        !result.isError &&
        typeof output === 'string' &&
        output.startsWith('wait_status: completed\n')
      ) {
        // WaitFor delivers completion itself and suppresses the automatic
        // notification. Read only native metadata, never the command's output.
        const header = output.split('\n\n', 1)[0];
        acknowledge(/^task_id: (\S+)$/m.exec(header)?.[1]);
        const extras =
          /\[completed_during_wait\]\n([\s\S]*?)\nUse TaskOutput/.exec(output)?.[1] || '';
        for (const match of extras.matchAll(/^task_id: (\S+)$/gm)) acknowledge(match[1]);
      }
    }
    if (p.agentId && p.agentId !== 'main' && !control) return;
    if (/^(?:background\.)?task\.(started|terminated)$/.test(frame.type) && p.info?.taskId) {
      const key = `${p.agentId || 'main'}:${p.info.taskId}`;
      const previous = this.tasks.get(key);
      const info = p.info;
      const state = {
        id: `${this.nativeId}:${key}`,
        taskId: info.taskId,
        agentId: p.agentId || 'main',
        kind: info.kind,
        description: this.redact(info.description),
        background: info.detached !== false,
        status: info.status,
        exitCode: info.exitCode,
        stopReason: this.redact(info.stopReason),
        // Kimi reads output asynchronously before notifying its agent. A
        // terminal process alone does not mean the session is ready to close.
        notificationPending:
          info.status !== 'running' &&
          info.detached !== false &&
          !info.terminalNotificationSuppressed &&
          !previous?.notified,
        notified: previous?.notified || false,
      };
      if (JSON.stringify(previous) !== JSON.stringify(state)) {
        this.tasks.set(key, state);
        emitState('BackgroundTaskState', state);
      }
      return;
    }
    if (frame.type === 'task.notified' && p.sourceKind === 'background_task') {
      acknowledge(p.sourceId);
      return;
    }
    if (frame.type === 'event.session.work_changed') {
      emitState('NativeWorkState', this.redact(p));
      return;
    }
    if (frame.type.startsWith('subagent.') && p.subagentId) {
      const previous = this.subagents.get(p.subagentId) || {};
      const state = {
        ...previous,
        id: `${this.nativeId}:${p.subagentId}`,
        agentId: p.subagentId,
        parentToolCallId: p.parentToolCallId || previous.parentToolCallId || '',
        subagentType: p.subagentName || previous.subagentType || 'agent',
        description: p.description || previous.description || p.subagentId,
        background: p.runInBackground ?? previous.background ?? false,
        status:
          {
            spawned: 'running',
            started: 'running',
            completed: 'completed',
            failed: 'failed',
            cancelled: 'cancelled',
          }[frame.type.slice(9)] || previous.status,
        ...(p.resultSummary ? { summary: this.redact(p.resultSummary) } : {}),
        ...(p.error ? { summary: this.redact(String(p.error)) } : {}),
      };
      this.subagents.set(p.subagentId, state);
      emitState('SubagentState', state);
      return;
    }
    if (!turn || turn.ended) {
      // Background work retains native control events; it must not end or write
      // into the already completed main turn.
      if (!control) return;
    }
    if (turn && !turn.ended) turn.push({ type: 'NativeEvent', payload: this.redact(frame) });
    if (!control && frame.type === 'turn.started' && p.promptId && p.promptId !== turn.promptId)
      return;
    if (frame.type === 'turn.started') {
      turn.turnId = p.turnId;
      this.contextInitialized = true;
      emit('TurnBegin', {});
    }
    if (!control && p.turnId !== undefined && turn.turnId !== undefined && p.turnId !== turn.turnId)
      return;
    if (
      p.agentId &&
      p.agentId !== 'main' &&
      this.subagents.has(p.agentId) &&
      /^event\.(approval|question)\.(requested|resolved)$/.test(frame.type)
    ) {
      const state = {
        ...this.subagents.get(p.agentId),
        status: frame.type.endsWith('requested') ? 'awaiting_approval' : 'running',
      };
      this.subagents.set(p.agentId, state);
      emitState('SubagentState', state);
    }
    switch (frame.type) {
      case 'assistant.delta':
      case 'thinking.delta': {
        const key = `${turn.stepId || 'initial'}:${frame.type}`;
        const offset = turn.offsets.get(key) || 0;
        const delta = p.delta || '';
        if (Number.isSafeInteger(frame.offset) && frame.offset > offset)
          throw Error('Kimi Code text stream has a gap; task execution was not retried.');
        const skip = Number.isSafeInteger(frame.offset) ? Math.max(0, offset - frame.offset) : 0;
        const text = delta.slice(skip);
        turn.offsets.set(key, offset + text.length);
        if (text)
          emit(
            'ContentPart',
            frame.type === 'assistant.delta'
              ? { type: 'text', text }
              : { type: 'think', think: text },
          );
        break;
      }
      case 'turn.step.started':
        turn.stepId = p.stepId || p.step || p.stepIndex || p.n;
        emit('StepBegin', { n: p.step ?? p.stepIndex ?? p.n ?? 1 });
        break;
      case 'tool.call.started':
        turn.calls.set(p.toolCallId, p.display);
        emit('ToolCall', {
          id: p.toolCallId,
          function: {
            name: toolName(p.name),
            arguments: typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? {}),
          },
        });
        break;
      case 'tool.result': {
        const result = p.result || p;
        const callDisplay = turn.calls.get(p.toolCallId);
        turn.calls.delete(p.toolCallId);
        const displays = [
          ...(Array.isArray(result.display)
            ? result.display
            : result.display
              ? [result.display]
              : []),
          ...(callDisplay?.kind === 'todo_list' && !result.isError
            ? [{ type: 'todo', items: callDisplay.items }]
            : []),
        ];
        emit('ToolResult', {
          tool_call_id: p.toolCallId,
          return_value: {
            is_error: Boolean(result.isError),
            output: this.redact(result.output ?? ''),
            message: result.note || '',
            display: displays,
          },
        });
        break;
      }
      case 'event.approval.requested':
        emit('ApprovalRequest', {
          id: p.approval_id,
          agentId: p.agentId || 'main',
          background: this.subagents.get(p.agentId)?.background || turn === this.backgroundTurn,
          sender: toolName(p.tool_name),
          harness_callback: p.tool_name?.startsWith('mcp__harness_adapter__') === true,
          action: p.action,
          description:
            typeof p.tool_input_display === 'string'
              ? p.tool_input_display
              : JSON.stringify(p.tool_input_display || p.action || ''),
        });
        break;
      case 'event.approval.resolved':
        emit('ApprovalResponse', {
          request_id: p.approval_id,
          response: p.decision === 'approved' ? 'approve' : 'reject',
        });
        break;
      case 'event.question.requested':
        this.questions.set(p.question_id, p.questions);
        emit('QuestionRequest', {
          id: p.question_id,
          agentId: p.agentId || 'main',
          background: this.subagents.get(p.agentId)?.background || turn === this.backgroundTurn,
          tool_call_id: p.tool_call_id,
          questions: p.questions.map(item => ({
            ...item,
            options: item.options.map(option => ({
              label: option.label,
              description: option.description || '',
            })),
          })),
        });
        break;
      case 'compaction.started':
        emit('CompactionBegin', {});
        break;
      case 'compaction.completed':
      case 'compaction.cancelled':
        emit('CompactionEnd', {});
        break;
      case 'agent.status.updated': {
        const usage = p.usage?.currentTurn;
        emit('StatusUpdate', {
          context_usage:
            Number.isFinite(p.contextTokens) && p.maxContextTokens > 0
              ? p.contextTokens / p.maxContextTokens
              : undefined,
          token_usage: usage
            ? {
                input:
                  (usage.inputOther || 0) +
                  (usage.inputCacheRead || 0) +
                  (usage.inputCacheCreation || 0),
                output: usage.output || 0,
              }
            : undefined,
        });
        break;
      }
      case 'turn.ended':
        if (p.reason === 'failed' || p.reason === 'blocked')
          turn.finish(
            null,
            Error(
              `Kimi Code turn ${p.reason}: ${p.error?.message || p.error || p.interruptReason || ''}`,
            ),
          );
        else
          turn.finish({
            status: p.reason === 'cancelled' || turn.cancelled ? 'cancelled' : 'finished',
          });
        break;
      case 'resync_required':
        turn.finish(null, Error('Kimi Code event resync is required; execution was not retried.'));
        break;
    }
  }
  redact(value) {
    return redactedNative(value, '', [
      this.token,
      this.toolServer?.config.headers.Authorization.replace(/^Bearer /, ''),
    ]);
  }
  async diagnosticSnapshot() {
    if (!this.nativeId || this.closed) return null;
    const messages = [];
    let before;
    let bytes = 0;
    for (let page = 0; page < 1000; page++) {
      const data = await this.request(
        `sessions/${encodeURIComponent(this.nativeId)}/messages?page_size=100${before ? `&before_id=${encodeURIComponent(before)}` : ''}`,
      );
      const items = data.items || [];
      if (!items.length) break;
      bytes += Buffer.byteLength(JSON.stringify(items));
      if (bytes > 64 * 1024 * 1024) throw Error('Kimi Code diagnostic snapshot exceeds 64 MiB.');
      messages.push(...items);
      if (!data.has_more) break;
      const next = items.at(-1).id;
      if (!next || next === before) throw Error('Kimi Code history pagination did not advance.');
      before = next;
      if (page === 999) throw Error('Kimi Code history exceeds 100,000 messages.');
    }
    return [
      {
        role: '_harness_snapshot',
        format: 'kimi-code-server-v1',
        version: KIMI_CODE_VERSION,
        nativeSessionId: this.nativeId,
        note: 'Saved conversation from the Kimi Code messages API; not a full model-context or HTTP-request snapshot.',
      },
      ...messages
        .reverse()
        .map(message => this.redact({ ...message, role: message.role, content: message.content })),
    ];
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.active?.finish({ status: 'cancelled' });
      this.backgroundTurn?.finish({ status: 'cancelled' });
      this.socket?.close();
      for (const controller of this.controllers) controller.abort();
      if (this.child && this.child.exitCode === null && !this.exitError) {
        try {
          await this.request('shutdown', { method: 'POST', body: {}, timeout: 1000 });
        } catch {}
        if (this.exit) await Promise.race([this.exit, delay(1000)]);
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (this.child.exitCode !== null || this.exitError) break;
          try {
            if (process.platform === 'win32') this.child.kill(signal);
            else process.kill(-this.child.pid, signal);
          } catch {}
          if (this.exit) await Promise.race([this.exit, delay(1000)]);
        }
      }
      await this.toolServer?.close();
    })();
    return this.closing;
  }
}

function createSession(options) {
  return new CodeSession(options);
}
module.exports = {
  KIMI_CODE_VERSION,
  createSession,
  createExternalTool,
  bundledExecutable,
  CodeSession,
  promptContent,
  redactedNative,
};
