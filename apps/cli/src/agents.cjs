const fs = require('node:fs');
const path = require('node:path');
const { TaskService } = require('@industrial-agent-harness/harness-application');
const { distributionDomain } = require('@industrial-agent-harness/domain-skills');

const usage = `industrial-harness agents list [--project-dir DIR --domain DOMAIN]
industrial-harness agents save --file AGENT.json
industrial-harness agents delete --id AGENT_ID
industrial-harness agents default --project-dir DIR --domain DOMAIN --id AGENT_ID

Optional --config-dir DIR isolates the shared Desktop/CLI Agent configuration.
Use run --agent AGENT_ID to select a role for a new chat.
Agent JSON: {"name":"Reviewer","description":"Review changes","domain":"*","instructions":"Report findings with evidence."}
Optional tools, disallowedTools, skills and subagents arrays narrow the role.
Omit an array to inherit defaults; an empty allowlist disables that resource.
Existing chats keep their original Agent snapshot.\n`;

async function runAgents(argv, output = process.stdout, environment = process.env) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    output.write(usage);
    return 0;
  }
  const command = argv[0],
    options = {};
  const allowed = {
    list: ['project-dir', 'domain'],
    save: ['file'],
    delete: ['id'],
    default: ['project-dir', 'domain', 'id'],
  };
  if (!allowed[command]) throw Error('Unknown agents command. Use agents --help.');
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index].slice(2);
    if (
      !argv[index].startsWith('--') ||
      ![...allowed[command], 'config-dir'].includes(name) ||
      options[name] ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--')
    )
      throw Error('Invalid agents command arguments.');
    options[name] = argv[++index];
  }
  if (
    (command === 'save' && !options.file) ||
    (['default', 'delete'].includes(command) && !options.id)
  )
    throw Error('Missing agents command argument.');
  if (distributionDomain && options.domain && options.domain !== distributionDomain)
    throw Error('This CLI is fixed to its packaged domain.');
  const domain = options.domain || (options['project-dir'] ? distributionDomain : undefined);
  if (Boolean(options['project-dir']) !== Boolean(domain) || (command === 'default' && !domain))
    throw Error('Provide --project-dir and --domain together.');
  const project = domain
    ? { path: fs.realpathSync(path.resolve(options['project-dir'])), domain }
    : undefined;
  const tasks = new TaskService({
    environment,
    resourceDirectory: options['config-dir'] && path.resolve(options['config-dir']),
  });
  try {
    if (project && !tasks.registry().domains.some(item => item.id === domain))
      throw Error('Choose a valid project domain.');
    let result;
    if (command === 'list') result = tasks.agentCatalog(project);
    else if (command === 'save') {
      const file = path.resolve(options.file);
      if (fs.statSync(file).size > 128 * 1024) throw Error('Agent configuration exceeds 128 KiB.');
      result = { agent: tasks.saveAgent(JSON.parse(fs.readFileSync(file, 'utf8'))) };
    } else if (command === 'default') result = tasks.setProjectAgent(project, options.id);
    else {
      tasks.agents.remove(options.id);
      result = { deleted: options.id };
    }
    output.write(
      JSON.stringify({ schemaVersion: 1, type: 'agent_profiles', command, ...result }) + '\n',
    );
    return 0;
  } finally {
    await tasks.close();
  }
}

module.exports = { runAgents, usage };
