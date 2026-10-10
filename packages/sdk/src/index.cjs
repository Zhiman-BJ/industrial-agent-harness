const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { startProcess, signalProcess } = require('./process.cjs');
const { StreamRedactor, environmentSecrets } = require('./redact.cjs');

const SDK_SCHEMA_VERSION = 1;
class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
  }
}

class EventStream {
  constructor(limit, stop) {
    this.limit = limit;
    this.stop = stop;
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    this.error = null;
    this.claimed = false;
  }
  push(value) {
    if (this.closed) return;
    if (this.waiter) {
      this.waiter.resolve({ value, done: false });
      this.waiter = null;
    } else if (this.queue.length < this.limit) this.queue.push(value);
    else
      this.stop(
        new HarnessError('EVENT_OVERFLOW', 'Consume the event stream while the run is active.'),
      );
  }
  finish(error) {
    this.closed = true;
    this.error = error;
    if (this.waiter) {
      if (error) this.waiter.reject(error);
      else this.waiter.resolve({ done: true });
      this.waiter = null;
    }
  }
  [Symbol.asyncIterator]() {
    if (this.claimed)
      throw new HarnessError('STREAM_IN_USE', 'Each run has one event stream consumer.');
    this.claimed = true;
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.closed)
          return this.error ? Promise.reject(this.error) : Promise.resolve({ done: true });
        if (this.waiter)
          return Promise.reject(
            new HarnessError('STREAM_IN_USE', 'Concurrent next calls are unsupported.'),
          );
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: async () => {
        this.stop(new HarnessError('CANCELLED', 'Event consumer stopped.'));
        return { done: true };
      },
    };
  }
}

const valueFlags = {
  agentId: 'agent',
  chatId: 'chat-id',
  chatDir: 'chat-dir',
  stateDir: 'state-dir',
  logDir: 'log-dir',
  provider: 'provider',
  endpoint: 'endpoint',
  model: 'model',
  contextSize: 'context-size',
  apiKeyEnv: 'api-key-env',
  kimiExecutable: 'kimi-executable',
  artifactManifest: 'artifact-manifest',
  approval: 'approval',
};
const booleanFlags = {
  scopeOnly: 'scope-only',
  imageInput: 'image-input',
  enableGui: 'enable-gui',
};
const allowed = new Set([
  'task',
  'timeoutMs',
  'signal',
  'thinking',
  'disabledSkills',
  'disabledMcpServers',
  ...Object.keys(valueFlags),
  ...Object.keys(booleanFlags),
]);

function createClient(config) {
  if (
    !config ||
    typeof config.cliPath !== 'string' ||
    typeof config.projectDir !== 'string' ||
    typeof config.domain !== 'string' ||
    !/^[a-zA-Z0-9][\w.-]*$/.test(config.domain)
  )
    throw new HarnessError('INVALID_ARGUMENT', 'Provide cliPath, projectDir, and domain.');
  let cliPath, projectDir;
  try {
    cliPath = fs.realpathSync(config.cliPath);
    projectDir = fs.realpathSync(config.projectDir);
  } catch (error) {
    throw new HarnessError('INVALID_ARGUMENT', String(error));
  }
  if (!fs.statSync(cliPath).isFile() || !fs.statSync(projectDir).isDirectory())
    throw new HarnessError(
      'INVALID_ARGUMENT',
      'CLI must be a file and project must be a directory.',
    );
  const graceMs = config.cancelGraceMs ?? 5000;
  const maxBufferedEvents = config.maxBufferedEvents ?? 1024;
  if (
    !Number.isInteger(graceMs) ||
    graceMs < 1 ||
    graceMs > 30000 ||
    !Number.isInteger(maxBufferedEvents) ||
    maxBufferedEvents < 1 ||
    maxBufferedEvents > 100000
  )
    throw new HarnessError('INVALID_ARGUMENT', 'Invalid cancellation grace or event buffer limit.');
  const environment = { ...process.env, ...(config.environment || {}) };
  const secrets = environmentSecrets(environment);
  const active = new Set();
  let closed = false;

  function execute(command, options = {}) {
    if (closed) throw new HarnessError('CLIENT_CLOSED', 'Client is closed.');
    if (!options || Object.keys(options).some(key => !allowed.has(key)))
      throw new HarnessError('INVALID_ARGUMENT', 'Unknown run option.');
    if (
      command === 'run' &&
      (typeof options.task !== 'string' ||
        !options.task.trim() ||
        options.task.length > 1024 * 1024)
    )
      throw new HarnessError('INVALID_ARGUMENT', 'Provide a nonempty task of at most 1 MiB.');
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 7200000)
    )
      throw new HarnessError('INVALID_ARGUMENT', 'timeoutMs must be between 1 and 7200000.');
    if (options.thinking !== undefined && typeof options.thinking !== 'boolean')
      throw new HarnessError('INVALID_ARGUMENT', 'Invalid thinking option.');
    const args = [cliPath, command, '--project-dir', projectDir, '--domain', config.domain];
    for (const [key, flag] of Object.entries(valueFlags)) {
      if (options[key] === undefined) continue;
      if (
        !['string', 'number'].includes(typeof options[key]) ||
        !String(options[key]) ||
        String(options[key]).startsWith('--')
      )
        throw new HarnessError('INVALID_ARGUMENT', `Invalid ${key}.`);
      args.push(`--${flag}`, String(options[key]));
    }
    for (const [key, flag] of Object.entries(booleanFlags)) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean')
        throw new HarnessError('INVALID_ARGUMENT', `Invalid ${key}.`);
      if (options[key]) args.push(`--${flag}`);
    }
    if (options.thinking === false) args.push('--no-thinking');
    for (const [key, flag] of [
      ['disabledSkills', 'disable-skill'],
      ['disabledMcpServers', 'disable-mcp'],
    ]) {
      if (options[key] === undefined) continue;
      if (
        !Array.isArray(options[key]) ||
        options[key].some(id => typeof id !== 'string' || !id || id.startsWith('--'))
      )
        throw new HarnessError('INVALID_ARGUMENT', `Invalid ${key}.`);
      for (const id of options[key]) args.push(`--${flag}`, id);
    }
    if (
      options.signal &&
      (typeof options.signal.addEventListener !== 'function' ||
        typeof options.signal.removeEventListener !== 'function' ||
        typeof options.signal.aborted !== 'boolean')
    )
      throw new HarnessError('INVALID_ARGUMENT', 'Invalid AbortSignal.');
    const temporary =
      command === 'run' ? fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sdk-')) : null;
    if (temporary) {
      fs.chmodSync(temporary, 0o700);
      const taskFile = path.join(temporary, 'task.txt');
      fs.writeFileSync(taskFile, options.task, { mode: 0o600 });
      args.push('--task-file', taskFile);
    }
    const startedAt = Date.now();
    let child;
    try {
      child = startProcess(config.nodeExecutable || process.execPath, args, {
        env: environment,
        cwd: projectDir,
      });
    } catch (error) {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      throw new HarnessError('SPAWN_FAILED', String(error));
    }
    let pending = '',
      stderr = '',
      lastResult,
      runId,
      chatId,
      failure,
      killTimer,
      timeout,
      finished = false;
    let references = { industrialRunId: null, actionId: null, checkpointId: null };
    const decoder = new StringDecoder('utf8');
    const stderrRedactor = new StreamRedactor(secrets);
    const stop = error => {
      if (finished || failure) return;
      failure = error;
      signalProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => signalProcess(child, 'SIGKILL'), graceMs);
      killTimer.unref();
    };
    const events = new EventStream(maxBufferedEvents, stop);
    const id = randomUUID();
    const aborted = () => stop(new HarnessError('CANCELLED', 'Run was cancelled.'));
    const cancel = () => {
      aborted();
      return result.catch(() => undefined);
    };
    function line(text) {
      if (!text.trim()) return;
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) {
        stop(new HarnessError('PROTOCOL_ERROR', 'CLI event exceeds 4 MiB.'));
        return;
      }
      try {
        const event = JSON.parse(text);
        if (!event || event.schemaVersion !== 1 || typeof event.type !== 'string')
          throw Error('Unsupported CLI event schema.');
        if (event.runId) runId = event.runId;
        if (event.chatId) chatId = event.chatId;
        if (event.type === 'industrial_result')
          references = {
            industrialRunId: event.run?.id || null,
            actionId: event.action?.id || null,
            checkpointId: event.checkpoint?.id || null,
          };
        if (event.type === 'result' && event.engineering?.checkpointId)
          references.checkpointId = event.engineering.checkpointId;
        if (event.type === (command === 'chats' ? 'chats' : 'result')) lastResult = event;
        events.push(event);
      } catch (error) {
        stop(new HarnessError('PROTOCOL_ERROR', String(error)));
      }
    }
    child.stdout.on('data', chunk => {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024)
        stop(new HarnessError('PROTOCOL_ERROR', 'CLI event exceeds 4 MiB.'));
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + stderrRedactor.write(chunk)).slice(-16384);
    });
    const result = new Promise((resolve, reject) => {
      child.once('error', error => {
        failure = new HarnessError('SPAWN_FAILED', String(error));
      });
      child.once('exit', () => signalProcess(child, 'SIGKILL'));
      child.once('close', (exitCode, signal) => {
        pending += decoder.end();
        stderr = (stderr + stderrRedactor.end()).slice(-16384);
        if (pending) line(pending);
        finished = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', aborted);
        // A child may exit while leaving descendants alive in its process group.
        signalProcess(child, 'SIGKILL');
        active.delete(handle);
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
        const details = {
          runId: runId || null,
          chatId: chatId || null,
          references,
          exitCode,
          signal,
          stderr,
          result: lastResult || null,
        };
        failure ||=
          exitCode !== 0
            ? new HarnessError('RUN_FAILED', 'CLI exited unsuccessfully.', details)
            : !lastResult
              ? new HarnessError('PROTOCOL_ERROR', 'CLI closed without a terminal event.', details)
              : null;
        events.finish(failure);
        if (failure) {
          failure.details = { ...details, ...failure.details };
          reject(failure);
        } else
          resolve({
            sdkSchemaVersion: SDK_SCHEMA_VERSION,
            ...details,
            elapsedMs: Date.now() - startedAt,
          });
      });
    });
    // result remains observable by the consumer without an unhandled rejection race.
    result.catch(() => {});
    const handle = { id, events, result, cancel };
    active.add(handle);
    if (options.timeoutMs)
      timeout = setTimeout(
        () => stop(new HarnessError('TIMEOUT', 'Run exceeded timeoutMs.')),
        options.timeoutMs,
      );
    if (options.signal?.aborted) aborted();
    else options.signal?.addEventListener('abort', aborted, { once: true });
    return handle;
  }
  return {
    sdkSchemaVersion: SDK_SCHEMA_VERSION,
    project: Object.freeze({ projectDir, domain: config.domain }),
    run: options => execute('run', options),
    async chats(options = {}) {
      if (Object.keys(options).some(key => !['chatDir', 'timeoutMs', 'signal'].includes(key)))
        throw new HarnessError('INVALID_ARGUMENT', 'Unknown chats option.');
      const handle = execute('chats', options);
      for await (const _event of handle.events) {
        /* Drain the bounded transport stream. */
      }
      return (await handle.result).result.chats;
    },
    async close() {
      closed = true;
      await Promise.all([...active].map(handle => handle.cancel()));
    },
  };
}

module.exports = { SDK_SCHEMA_VERSION, HarnessError, createClient };
