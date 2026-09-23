const fs = require('node:fs');
const path = require('node:path');

const valueFlags = new Set(['project-dir', 'domain', 'task', 'task-file', 'provider', 'endpoint', 'model', 'context-size', 'approval', 'api-key-env', 'kimi-executable', 'artifact-manifest', 'timeout-ms']);

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h' || (argv[0] === 'run' && (argv[1] === '--help' || argv[1] === '-h'))) return {help: true};
  if (argv[0] !== 'run') throw Error('Expected the run command. Use --help for usage.');
  const options = {scopeOnly: false, thinking: true};
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--scope-only') {options.scopeOnly = true; continue;}
    if (flag === '--no-thinking') {options.thinking = false; continue;}
    if (!flag.startsWith('--') || !valueFlags.has(flag.slice(2))) throw Error(`Unknown option: ${flag}`);
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw Error(`Missing value for ${flag}.`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (options[key] !== undefined) throw Error(`Duplicate option: ${flag}`);
    options[key] = argv[++index];
  }
  if (!options.projectDir || !options.domain) throw Error('Provide --project-dir and --domain.');
  if (Boolean(options.task) === Boolean(options.taskFile)) throw Error('Provide exactly one of --task or --task-file.');
  if (options.taskFile) options.task = fs.readFileSync(path.resolve(options.taskFile), 'utf8');
  if (!options.task.trim()) throw Error('Task text is empty.');
  if (options.approval && !['reject', 'approve', 'approve_for_session'].includes(options.approval)) throw Error('Invalid --approval policy.');
  if (options.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) throw Error('Invalid --api-key-env name.');
  if (options.timeoutMs && (!Number.isInteger(Number(options.timeoutMs)) || Number(options.timeoutMs) < 1000 || Number(options.timeoutMs) > 7200000)) throw Error('--timeout-ms must be between 1000 and 7200000.');
  return options;
}

module.exports = {parseArgs};
