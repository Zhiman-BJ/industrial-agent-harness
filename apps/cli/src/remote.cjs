const {
  RemoteSettings,
  defaultResourceDirectory,
} = require('@industrial-agent-harness/harness-core');
const path = require('node:path');

const usage = `industrial-harness remote status|connect
industrial-harness remote use --project-dir DIR --domain DOMAIN --location local|remote
industrial-harness remote rebind --project-dir DIR --domain DOMAIN [--confirm-new-project]
industrial-harness remote sync --project-dir DIR --domain DOMAIN --file PATH [--file PATH ...] [--confirm-upload]
industrial-harness remote session|task --project-dir DIR --domain DOMAIN --chat-id UUID
industrial-harness remote terminate --project-dir DIR --domain DOMAIN --chat-id UUID --session-id UUID
industrial-harness remote artifacts --project-dir DIR --domain DOMAIN
industrial-harness remote download --project-dir DIR --domain DOMAIN --artifact-id UUID --destination PATH

The built-in service is configured by the app/operator. No service name or URL is needed.
Sync without --confirm-upload only previews the selected files; nothing is uploaded.
Upload changed files explicitly before the next remote task. Downloads never replace existing files.
Rebind creates a new remote project; old bindings and engineering facts stay in history. Upload files explicitly afterward.
Rebind without --confirm-new-project only shows this intent and does not contact the service.
Stopping the local wait does not cancel remote computation. Termination ends an idle application session.
`;
async function runRemote(argv, output = process.stdout, environment = process.env) {
  if (!argv.length || ['--help', '-h'].includes(argv[0])) {
    output.write(usage);
    return 0;
  }
  const command = argv[0],
    options = { files: [] };
  if (
    ![
      'status',
      'connect',
      'use',
      'rebind',
      'sync',
      'task',
      'session',
      'terminate',
      'artifacts',
      'download',
    ].includes(command)
  )
    throw Error('Unknown remote command.');
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--confirm-upload') {
      options.confirm = true;
      continue;
    }
    if (flag === '--confirm-new-project') {
      if (command !== 'rebind' || options.confirmNewProject)
        throw Error('Invalid new-project confirmation.');
      options.confirmNewProject = true;
      continue;
    }
    if (
      ![
        '--project-dir',
        '--domain',
        '--location',
        '--file',
        '--chat-id',
        '--session-id',
        '--artifact-id',
        '--destination',
      ].includes(flag) ||
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
  const settings = new RemoteSettings({
    directory: defaultResourceDirectory(environment),
    environment,
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
  } else if (command === 'rebind') {
    send(settings.rebindIntent(directory, options.domain));
    if (options.confirmNewProject) {
      const binding = await settings.rebind(directory, options.domain);
      send({
        type: 'rebound',
        remoteProjectId: binding.remoteProjectId,
        protocol: binding.protocol,
        requiresExplicitUpload: true,
        historicalFacts: 'retained_without_migration',
      });
    }
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
  } else if (command === 'artifacts') send(await settings.artifacts(directory, options.domain));
  else if (command === 'download') {
    if (!options.artifactId || !options.destination)
      throw Error('Provide --artifact-id and --destination.');
    send(
      await settings.download(directory, options.domain, options.artifactId, options.destination),
    );
  } else {
    if (!options.chatId) throw Error('Provide --chat-id.');
    if (command === 'terminate') {
      if (!options.sessionId) throw Error('Provide --session-id from remote session.');
      send(
        await settings.terminateSession(
          directory,
          options.domain,
          options.chatId,
          options.sessionId,
        ),
      );
    } else
      send(
        command === 'task'
          ? await settings.refreshTask(directory, options.domain, options.chatId)
          : await settings.session(directory, options.domain, options.chatId),
      );
  }
  return 0;
}
module.exports = { runRemote, usage };
