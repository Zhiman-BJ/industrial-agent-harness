const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executeTask } = require('./task-process.cjs');
const { manifest, runDirectory } = require('./workspace-files.cjs');
const { resolveDockerCli, dockerSearchLocations } = require('./docker-cli.cjs');

function available(command, environment) {
  const candidates = command.includes(path.sep)
    ? [command]
    : (environment.PATH || '').split(path.delimiter).map(dir => path.join(dir, command));
  return candidates.some(file => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
async function preflight({ projectDir, action, signal }, environment, protectedPaths) {
  const checks = [],
    directory = runDirectory(projectDir, action.id),
    input = path.join(directory, 'input'),
    work = path.join(directory, 'work');
  fs.mkdirSync(input);
  fs.mkdirSync(work);
  let declared;
  try {
    declared = manifest(projectDir, protectedPaths);
    checks.push({ name: 'task manifest', status: 'ready', required: true });
  } catch (error) {
    checks.push({ name: 'task manifest', status: 'failed', required: true, detail: error.message });
    declared = { tasks: {} };
  }
  const tasks = Object.values(declared.tasks),
    localRequired = tasks.some(task => task.runtime.kind === 'local');
  try {
    const result = await executeTask(
      {
        command: [process.execPath, '-e', 'console.log("HARNESS_PROTECTED_TASK_READY")'],
        runtime: { kind: 'local' },
        timeoutMs: 5000,
      },
      { directory, input, work, actionId: action.id, environment, signal },
    );
    checks.push({
      name: 'protected local execution',
      required: localRequired,
      status:
        result.status === 'COMPLETED' && result.log.includes('HARNESS_PROTECTED_TASK_READY')
          ? 'ready'
          : 'failed',
      detail: result.log.slice(0, 2048),
    });
  } catch (error) {
    checks.push({
      name: 'protected local execution',
      required: localRequired,
      status: 'unavailable',
      detail: error.message,
    });
  }
  for (const [name, task] of Object.entries(declared.tasks)) {
    if (task.runtime.kind === 'local') {
      checks.push({
        name: `task ${name} executable`,
        required: true,
        status: available(task.command[0], environment) ? 'ready' : 'missing',
        detail: task.command[0],
      });
      for (const root of task.runtime.readOnlyDirs || [])
        checks.push({
          name: `task ${name} dependency`,
          required: true,
          status: fs.statSync(root, { throwIfNoEntry: false })?.isDirectory() ? 'ready' : 'missing',
          detail: root,
        });
    }
  }
  const images = [
    ...new Set(
      tasks.filter(task => task.runtime.kind === 'docker').map(task => task.runtime.image),
    ),
  ];
  const docker = await resolveDockerCli(environment);
  if (docker) {
    const deadline = Date.now() + 20000;
    const dockerEnv = Object.fromEntries(
      [
        'PATH',
        'HOME',
        'SystemRoot',
        'DOCKER_HOST',
        'DOCKER_CONTEXT',
        'DOCKER_TLS_VERIFY',
        'DOCKER_CERT_PATH',
      ]
        .filter(key => docker.environment[key])
        .map(key => [key, docker.environment[key]]),
    );
    const inspect = args =>
      spawnSync(docker.docker, args, {
        env: dockerEnv,
        encoding: 'utf8',
        timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
        maxBuffer: 65536,
      });
    const daemon = inspect(['info', '--format', '{{.ServerVersion}}']);
    checks.push({
      name: 'host Docker',
      required: images.length > 0,
      status: daemon.status === 0 ? 'ready' : 'unavailable',
      detail:
        daemon.status === 0
          ? daemon.stdout.trim()
          : 'Check host Docker permissions and service availability.',
    });
    for (const image of images)
      checks.push({
        name: 'offline Docker image',
        required: true,
        status:
          daemon.status !== 0
            ? 'unavailable'
            : Date.now() >= deadline
              ? 'not_checked'
              : inspect(['image', 'inspect', image]).status === 0
                ? 'ready'
                : 'missing',
        detail: image,
      });
  } else
    checks.push({
      name: 'host Docker',
      required: images.length > 0,
      status: 'missing',
      detail: `docker CLI not found. Searched PATH and ${dockerSearchLocations(environment).join(', ')}`,
    });
  const report = {
    schemaVersion: '1',
    ready: checks.every(check => !check.required || check.status === 'ready'),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    checks,
  };
  const file = path.join(directory, 'environment.json');
  fs.writeFileSync(file, JSON.stringify(report));
  return {
    executionSucceeded: true,
    artifacts: [{ kind: 'report.environment', file }],
    diagnostics: [],
  };
}
module.exports = { preflight };
