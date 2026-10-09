const fs = require('node:fs');
const path = require('node:path');
const { parseTimeoutMs } = require('./lib/timeout.cjs');
const { distributionDomain } = require('@industrial-agent-harness/domain-skills');

const valueFlags = new Set([
  'project-dir',
  'domain',
  'task',
  'task-file',
  'provider',
  'endpoint',
  'model',
  'context-size',
  'approval',
  'api-key-env',
  'kimi-executable',
  'artifact-manifest',
  'timeout-ms',
  'disable-skill',
  'disable-mcp',
  'state-dir',
  'log-dir',
  'chat-id',
  'chat-dir',
]);

function parseArgs(argv) {
  if (
    argv[0] === '--help' ||
    argv[0] === '-h' ||
    (['run', 'chats', 'doctor'].includes(argv[0]) && (argv[1] === '--help' || argv[1] === '-h'))
  )
    return { help: true };
  if (!['run', 'chats', 'doctor'].includes(argv[0]))
    throw Error('Expected run, chats or doctor. Use --help for usage.');
  const options = {
    command: argv[0],
    scopeOnly: false,
    thinking: true,
    disabledSkills: [],
    disabledMcpServers: [],
  };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--scope-only') {
      options.scopeOnly = true;
      continue;
    }
    if (flag === '--no-thinking') {
      options.thinking = false;
      continue;
    }
    if (flag === '--image-input') {
      options.imageInput = true;
      continue;
    }
    if (flag === '--enable-gui') {
      options.enableGui = true;
      continue;
    }
    if (!flag.startsWith('--') || !valueFlags.has(flag.slice(2)))
      throw Error(`Unknown option: ${flag}`);
    if (!argv[index + 1] || argv[index + 1].startsWith('--'))
      throw Error(`Missing value for ${flag}.`);
    if (flag === '--disable-skill') {
      options.disabledSkills.push(argv[++index]);
      continue;
    }
    if (flag === '--disable-mcp') {
      options.disabledMcpServers.push(argv[++index]);
      continue;
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (options[key] !== undefined) throw Error(`Duplicate option: ${flag}`);
    options[key] = argv[++index];
  }
  if (distributionDomain) {
    if (options.domain && options.domain !== distributionDomain)
      throw Error(`This CLI package is fixed to the ${distributionDomain} domain.`);
    options.domain = distributionDomain;
  }
  if (!options.projectDir || !options.domain) throw Error('Provide --project-dir and --domain.');
  if (options.command === 'chats' || options.command === 'doctor') {
    if (options.scopeOnly || options.task || options.taskFile || options.chatId)
      throw Error(
        options.command === 'doctor'
          ? 'doctor checks the environment; use run to submit a task.'
          : 'chats only lists project history; use run to submit a task.',
      );
    return options;
  }
  if (Boolean(options.task) === Boolean(options.taskFile))
    throw Error('Provide exactly one of --task or --task-file.');
  if (options.taskFile) options.task = fs.readFileSync(path.resolve(options.taskFile), 'utf8');
  if (!options.task.trim()) throw Error('Task text is empty.');
  if (
    options.approval &&
    !['reject', 'approve', 'approve_for_session', 'auto'].includes(options.approval)
  )
    throw Error('Invalid --approval policy.');
  if (options.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv))
    throw Error('Invalid --api-key-env name.');
  if (options.timeoutMs !== undefined) parseTimeoutMs(options.timeoutMs);
  return options;
}

module.exports = { parseArgs };
