const {
  RemoteSettings,
  defaultResourceDirectory,
} = require('@industrial-agent-harness/harness-core');
const path = require('node:path');
const { createCliAccount } = require('./account.cjs');

const usage = `industrial-harness remote status|connect
industrial-harness remote use --project-dir DIR --domain DOMAIN --location local|remote
industrial-harness remote sync --project-dir DIR --domain DOMAIN --file PATH [--file PATH ...] [--confirm-upload]
industrial-harness remote task|cancel --project-dir DIR --domain DOMAIN

--platform-account uses the saved platform session created with account login --allow-file-store.
The built-in service is configured by the app/operator. No service name or URL is needed.
Sync without --confirm-upload only previews the selected files; nothing is uploaded.
Confirmed file paths may sync updated contents before subsequent tasks.
`;
async function runRemote(argv, output = process.stdout, environment = process.env) {
  if (!argv.length || ['--help', '-h'].includes(argv[0])) {
    output.write(usage);
    return 0;
  }
  const command = argv[0],
    options = { files: [] };
  if (!['status', 'connect', 'use', 'sync', 'task', 'cancel'].includes(command))
    throw Error('Unknown remote command.');
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--platform-account') {
      options.platformAccount = true;
      continue;
    }
    if (flag === '--confirm-upload') {
      options.confirm = true;
      continue;
    }
    if (
      !['--project-dir', '--domain', '--location', '--file'].includes(flag) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw Error('Invalid remote option.');
    if (flag === '--file') options.files.push(argv[++i]);
    else {
      const name = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (options[name]) throw Error('Duplicate remote option.');
      options[name] = argv[++i];
    }
  }
  const account = options.platformAccount ? createCliAccount(environment, true) : null;
  try {
    if (account) await account.restore();
    const settings = new RemoteSettings({
      directory: defaultResourceDirectory(environment),
      environment,
      account,
    });
    const send = value => output.write(JSON.stringify(value) + '\n');
    if (command === 'status' || command === 'connect') {
      send(command === 'connect' ? await settings.check() : settings.view());
      return 0;
    }
    if (!options.projectDir || !options.domain) throw Error('Provide --project-dir and --domain.');
    const directory = path.resolve(options.projectDir);
    if (command === 'use') {
      settings.setLocation(directory, options.domain, options.location);
      send({ location: options.location });
    } else if (command === 'sync') {
      const review = await settings.review(directory, options.domain, options.files);
      send({ type: 'sync_review', ...review });
      if (options.confirm) {
        const binding = await settings.sync(directory, options.domain, review.id);
        send({
          type: 'synced',
          location: binding.location,
          files: binding.files,
          syncedAt: binding.syncedAt,
        });
      }
    } else
      send(
        command === 'task'
          ? await settings.refreshTask(directory, options.domain)
          : await settings.cancelTask(directory, options.domain),
      );
    return 0;
  } finally {
    account?.close();
  }
}
module.exports = { runRemote, usage };
