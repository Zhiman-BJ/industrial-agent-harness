const fs = require('node:fs');
const path = require('node:path');
const {
  defaultPackDirectory,
  compareVersions,
  RuntimeEnvironmentManager,
} = require('@industrial-agent-harness/pack-manager');
const {
  PackCatalog,
  describeInstalled,
  InstallationJournal,
} = require('@industrial-agent-harness/pack-manager/src/catalog.cjs');

const usage = `industrial-harness domains list [--store DIR]
industrial-harness domains available --catalog HTTPS_URL --keys-file FILE [--store DIR]
industrial-harness domains install DOMAIN --catalog HTTPS_URL --keys-file FILE [--store DIR]
industrial-harness domains update --catalog HTTPS_URL --keys-file FILE [--store DIR]
industrial-harness domains remove DOMAIN [--store DIR]
industrial-harness domains repair DOMAIN [--profile ID] [--project-dir DIR] [--store DIR]
industrial-harness domains environments DOMAIN [--project-dir DIR] [--store DIR]
industrial-harness domains detect|associate DOMAIN --profile ID [--project-dir DIR] [--path ASSET=/abs/installed-path] [--store DIR]
industrial-harness domains prepare DOMAIN --profile CONTAINER_PROFILE [--project-dir DIR] [--store DIR]
industrial-harness domains unbind DOMAIN [--project-dir DIR] [--store DIR]
Prepare downloads container images only; install and start Docker yourself. Native software is installed externally, then detected and associated.
Use a trusted public-key JSON file: {"key-id":"-----BEGIN PUBLIC KEY-----..."}.
Set INDUSTRIAL_HARNESS_PACK_STORE to the same store for run and bench.\n`;

function parse(argv) {
  if (!argv.length || argv.includes('--help')) return { help: true };
  const command = argv[0];
  if (
    ![
      'list',
      'available',
      'install',
      'update',
      'remove',
      'repair',
      'environments',
      'detect',
      'associate',
      'prepare',
      'unbind',
    ].includes(command)
  )
    throw Error('Unknown domains command.');
  const options = { command };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--path') {
      const value = argv[++index],
        separator = value?.indexOf('=');
      if (!value || separator < 1) throw Error('Use --path ASSET=/absolute/installed-path.');
      const asset = value.slice(0, separator),
        appPath = value.slice(separator + 1);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(asset) || !path.isAbsolute(appPath))
        throw Error('Use a declared asset ID and absolute application path.');
      options.paths ||= {};
      if (Object.hasOwn(options.paths, asset)) throw Error('Duplicate asset path.');
      options.paths[asset] = appPath;
    } else if (
      ['--store', '--catalog', '--keys-file', '--profile', '--project-dir'].includes(token)
    ) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error(`Missing ${token} value.`);
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (options[key]) throw Error(`Duplicate ${token}.`);
      options[key] = value;
    } else if (!options.domain && !token.startsWith('--')) options.domain = token;
    else throw Error(`Unknown domains option: ${token}`);
  }
  if (
    [
      'install',
      'remove',
      'repair',
      'environments',
      'detect',
      'associate',
      'prepare',
      'unbind',
    ].includes(command) !== Boolean(options.domain)
  )
    throw Error('Specify one Domain ID for this command.');
  if (['detect', 'associate', 'prepare'].includes(command) && !options.profile)
    throw Error('Provide --profile.');
  if (options.paths && !['detect', 'associate', 'repair'].includes(command))
    throw Error('--path is only valid for detect, associate or repair.');
  if (
    ['available', 'install', 'update'].includes(command) &&
    (!options.catalog || !options.keysFile)
  )
    throw Error('Provide --catalog and --keys-file.');
  return options;
}

async function runDomains(argv, output = process.stdout) {
  const options = parse(argv);
  if (options.help) {
    output.write(usage);
    return 0;
  }
  const directory = path.resolve(options.store || defaultPackDirectory());
  const keys = options.keysFile
    ? JSON.parse(fs.readFileSync(path.resolve(options.keysFile), 'utf8'))
    : {};
  const catalog = new PackCatalog({
    directory,
    keys,
    url: options.catalog,
    channel: 'stable',
    declaredDomains: require('@zhiman-bj/industrial-domain-packs').consumerMetadata().domains,
  });
  const manager = catalog.manager;
  const environments = new RuntimeEnvironmentManager({ manager });
  const journal = new InstallationJournal(manager);
  const finish = (outcome, error) => {
    const receipt = journal.finish(outcome, error);
    if (receipt?.statusWarning)
      output.write(`${JSON.stringify({ warning: receipt.statusWarning })}\n`);
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(Error('Domain preparation cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    process.env.INDUSTRIAL_HARNESS_PACK_STORE = directory;
    if (options.command === 'list') {
      output.write(
        `${JSON.stringify({ store: directory, lastOperation: journal.snapshot(), installed: manager.list().map(item => ({ ...describeInstalled(manager, item), location: item.location })) }, null, 2)}\n`,
      );
      return 0;
    }
    if (options.command === 'remove') {
      journal.begin([options.domain], 'remove');
      manager.remove(options.domain);
      finish('completed');
      output.write(`${JSON.stringify({ removed: options.domain })}\n`);
      return 0;
    }
    const onProgress = progress => {
      journal.progress(progress);
      output.write(`${JSON.stringify({ type: 'runtime_progress', ...progress })}\n`);
    };
    if (
      ['environments', 'detect', 'associate', 'prepare', 'unbind', 'repair'].includes(
        options.command,
      )
    ) {
      const projectDir = options.projectDir && path.resolve(options.projectDir);
      const selected = {
        profileId: options.profile,
        projectDir,
        paths: options.paths,
        signal: controller.signal,
        onProgress,
      };
      let result;
      if (options.command === 'environments')
        result = environments.describe(options.domain, { projectDir });
      else if (options.command === 'unbind')
        result = environments.clear(options.domain, { projectDir });
      else if (options.command === 'repair') {
        const current = environments.describe(options.domain, { projectDir });
        const profileId = options.profile || current.binding?.profileId;
        if (!profileId)
          throw Error(
            'Choose --profile before checking an environment. Install dependencies externally, then detect and associate.',
          );
        const binding = current.binding;
        const paths =
          options.paths ||
          Object.fromEntries(
            Object.entries(binding?.assets || {}).map(([id, receipt]) => [id, receipt.appPath]),
          );
        result = await environments.detect(options.domain, { ...selected, profileId, paths });
      } else result = await environments[options.command](options.domain, selected);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      if (['environments', 'unbind'].includes(options.command)) return 0;
      return result.status === 'ready' ? 0 : 1;
    }
    const available = await catalog.available({ signal: controller.signal });
    if (catalog.snapshot().state === 'unavailable') throw Error(catalog.snapshot().message);
    if (options.command === 'available') {
      output.write(
        `${JSON.stringify({ channel: manager.channel, catalog: catalog.snapshot(), packs: catalog.summaries(available) }, null, 2)}\n`,
      );
      return 0;
    }
    if (options.command === 'install') {
      const item = available.find(pack => pack.domain === options.domain);
      if (!item) throw Error('Domain is unavailable for this platform.');
      journal.begin([item.domain]);
      const installed = await manager.install(item, {
        prepareRuntime: false,
        onProgress,
        signal: controller.signal,
      });
      finish('completed');
      output.write(
        `${JSON.stringify({ installed: installed.domain, version: installed.version })}\n`,
      );
      return 0;
    }
    const current = new Map(manager.list().map(item => [item.domain, item.version]));
    journal.begin(
      available
        .filter(
          item =>
            current.has(item.domain) && compareVersions(item.version, current.get(item.domain)) > 0,
        )
        .map(item => item.domain),
    );
    for (const item of available) {
      if (!current.has(item.domain) || compareVersions(item.version, current.get(item.domain)) <= 0)
        continue;
      const installed = await manager.install(item, {
        prepareRuntime: false,
        onProgress,
        signal: controller.signal,
      });
      output.write(
        `${JSON.stringify({ updated: installed.domain, version: installed.version })}\n`,
      );
    }
    finish('completed');
    return 0;
  } catch (error) {
    finish(controller.signal.aborted ? 'cancelled' : 'failed', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

module.exports = { runDomains, parse, usage };
