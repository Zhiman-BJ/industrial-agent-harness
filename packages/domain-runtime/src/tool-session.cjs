// Persistent stdio MCP lifecycle belongs to the execution backend, not Packs.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
function dockerCommand(spec) {
  const runtime = spec.runtime;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(runtime.image || '') &&
    !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(runtime.image || '')
  )
    throw Error('A tool session requires an immutable container image.');
  const name = 'industrial-session-' + crypto.randomUUID();
  const environment = { ...process.env, ...spec.env, ...spec.hostEnvironment };
  const docker = spec.docker || 'docker';
  const command = Array.isArray(spec.command) ? spec.command : [spec.command, ...(spec.args || [])];
  if (!command.length || command.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')))
    throw Error('Invalid tool session command.');
  for (const [key, fallback, min, max] of [
    ['cpus', 2, 0.1, 64],
    ['memoryMb', 4096, 128, 262144],
    ['pids', 256, 16, 4096],
  ]) {
    const value = runtime[key] ?? fallback;
    if (!Number.isFinite(value) || value < min || value > max)
      throw Error('Invalid container resource limit.');
  }
  const capabilities = runtime.capabilities || [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      value => !['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'].includes(value),
    )
  )
    throw Error('Unsupported container capability.');
  const mounts = (spec.mounts || []).flatMap(mount => {
    const source = fs.realpathSync(mount.source);
    if (
      source.includes(',') ||
      !/^\/[A-Za-z0-9._/-]+$/.test(mount.target || '') ||
      mount.target.includes('/../')
    )
      throw Error('Invalid container mount.');
    return [
      '--mount',
      `type=bind,src=${source},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`,
    ];
  });
  const containerEnvironment = Object.entries(spec.environment || {}).flatMap(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
      throw Error('Invalid container environment.');
    return ['--env', `${key}=${value}`];
  });
  if (runtime.platform && !/^linux\/(amd64|arm64)$/.test(runtime.platform))
    throw Error('Invalid container platform.');
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '-i',
    '--init',
    '--name',
    name,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    ...capabilities.flatMap(value => ['--cap-add', value]),
    '--security-opt',
    'no-new-privileges',
    '--cpus',
    String(runtime.cpus ?? 2),
    '--memory',
    `${runtime.memoryMb ?? 4096}m`,
    '--pids-limit',
    String(runtime.pids ?? 256),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=512m',
    ...(runtime.platform ? ['--platform', runtime.platform] : []),
    ...mounts,
    ...containerEnvironment,
    ...(spec.cwd ? ['--workdir', spec.cwd] : []),
    '--entrypoint',
    command[0],
    runtime.image,
    ...command.slice(1),
  ];
  return {
    command: docker,
    args,
    environment,
    cleanup: () => {
      const result = spawnSync(docker, ['rm', '--force', name], {
        env: environment,
        encoding: 'utf8',
        timeout: 15000,
      });
      if (result.status !== 0 && !/No such container/.test(result.stderr || ''))
        throw Error(
          'Container cleanup could not be confirmed: ' +
            String(result.stderr || result.error).slice(0, 2000),
        );
    },
  };
}
async function openToolSession(spec) {
  spec.signal?.throwIfAborted();
  if (spec.runtime?.kind !== 'docker')
    throw Error('Persistent tool sessions require the protected Docker backend.');
  const launch = dockerCommand(spec);
  const child = spawn(launch.command, launch.args, {
    env: launch.environment,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0,
    buffer = '',
    stderr = '',
    closed = false,
    closing,
    queue = Promise.resolve();
  let exited;
  const exit = new Promise(resolve => {
    exited = resolve;
  });
  const fail = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const session = {
    get closing() {
      return closed;
    },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        fail(Error('Tool session closed.'));
        child.stdin.destroy();
        const kill = signal => {
          if (child.pid)
            try {
              process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal);
            } catch {}
        };
        kill('SIGTERM');
        const force = setTimeout(() => kill('SIGKILL'), 2000);
        try {
          await exit;
        } finally {
          clearTimeout(force);
          spec.signal?.removeEventListener('abort', cancelSession);
          launch.cleanup();
        }
      })();
      return closing;
    },
    request(method, params, { signal, timeoutMs = spec.callTimeoutMs || 60000 } = {}) {
      const dispatch = async () => {
        signal?.throwIfAborted();
        if (closed) throw Error('Tool session is closed.');
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          let timer;
          const finish = (handler, value) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            pending.delete(id);
            handler(value);
          };
          const cancel = () => {
            const reason = signal.reason || Error('Tool call cancelled.');
            pending.delete(id);
            session.close().then(
              () => finish(reject, reason),
              error => finish(reject, error),
            );
          };
          pending.set(id, {
            resolve: value => finish(resolve, value),
            reject: error => finish(reject, error),
          });
          signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => {
            pending.delete(id);
            session.close().then(
              () => finish(reject, Error('Tool request timed out.')),
              error => finish(reject, error),
            );
          }, timeoutMs);
          child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
            error => {
              if (error) pending.get(id)?.reject(error);
            },
          );
          if (signal?.aborted) cancel();
        });
      };
      const result = queue.then(dispatch);
      queue = result.catch(() => {});
      return result;
    },
    callTool(name, args, options) {
      return session.request('tools/call', { name, arguments: args }, options);
    },
  };
  const cancelSession = () => {
    session.close().catch(() => {});
  };
  child.stdin.on('error', error => {
    fail(error);
    cancelSession();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
      fail(Error('Tool response exceeds transport limit.'));
      cancelSession();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(Error('Invalid MCP response.'));
        cancelSession();
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter)
        message.error
          ? waiter.reject(Error(message.error.message || 'Tool protocol error.'))
          : waiter.resolve(message.result);
    }
  });
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.on('error', error => {
    fail(error);
    exited();
  });
  child.on('close', (code, signal) => {
    closed = true;
    if (!closing) cancelSession();
    fail(Error(`Tool process exited (${signal || code}): ${stderr.slice(-2000)}`));
    exited();
  });
  spec.signal?.addEventListener('abort', cancelSession, { once: true });
  try {
    const initialized = await session.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'industrial-harness', version: '1' },
      },
      { signal: spec.signal, timeoutMs: spec.startupTimeoutMs || 150000 },
    );
    if (spec.expectedServerName && initialized?.serverInfo?.name !== spec.expectedServerName)
      throw Error('Unexpected tool server identity.');
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}
module.exports = { openToolSession, dockerCommand };
