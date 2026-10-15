const fs = require('node:fs');
const path = require('node:path');
const { defaultPackDirectory, compareVersions } = require('@industrial-agent-harness/pack-manager');
const {
  PackCatalog,
  describeInstalled,
  InstallationJournal,
} = require('@industrial-agent-harness/pack-manager/src/catalog.cjs');

const usage = `industrial-harness domains list [--store DIR]
industrial-harness domains available --catalog HTTPS_URL --keys-file FILE [--store DIR]
industrial-harness domains install DOMAIN --catalog HTTPS_URL --keys-file FILE [--store DIR]
industrial-harness domains import DOMAIN --file PATH --catalog HTTPS_URL --keys-file FILE [--asset ID] [--store DIR]
industrial-harness domains update --catalog HTTPS_URL --keys-file FILE [--store DIR]
industrial-harness domains remove DOMAIN [--store DIR]
industrial-harness domains repair DOMAIN [--store DIR]
Use a trusted public-key JSON file: {"key-id":"-----BEGIN PUBLIC KEY-----..."}.
Runtime archives are never downloaded by this tool: download the pinned official
release yourself, then register it with domains import.
Set INDUSTRIAL_HARNESS_PACK_STORE to the same store for run and bench.\n`;

function parse(argv) {
  if (!argv.length || argv.includes('--help')) return { help: true };
  const command = argv[0];
  if (!['list', 'available', 'install', 'import', 'update', 'remove', 'repair'].includes(command))
    throw Error('Unknown domains command.');
  const options = { command };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (['--store', '--catalog', '--keys-file', '--file', '--asset'].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error(`Missing ${token} value.`);
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (options[key]) throw Error(`Duplicate ${token}.`);
      options[key] = value;
    } else if (!options.domain && !token.startsWith('--')) options.domain = token;
    else throw Error(`Unknown domains option: ${token}`);
  }
  if (['install', 'import', 'remove', 'repair'].includes(command) !== Boolean(options.domain))
    throw Error('Specify one Domain ID for install, import or remove.');
  if (
    ['available', 'install', 'import', 'update'].includes(command) &&
    (!options.catalog || !options.keysFile)
  )
    throw Error('Provide --catalog and --keys-file.');
  if (command === 'import' && !options.file) throw Error('Provide --file for the archive import.');
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
    if (options.command === 'repair') {
      journal.begin([options.domain], 'repair');
      const bundle = manager.list().find(item => item.domain === options.domain);
      if (!bundle) throw Error('Domain is not installed.');
      await manager.prepareRuntime(bundle, {
        recheck: true,
        onProgress,
        signal: controller.signal,
      });
      finish('completed');
      output.write(`${JSON.stringify({ repaired: options.domain })}\n`);
      return 0;
    }
    const available = await catalog.available({ signal: controller.signal });
    if (catalog.snapshot().state === 'unavailable') throw Error(catalog.snapshot().message);
    if (options.command === 'available') {
      output.write(
        `${JSON.stringify({ channel: manager.channel, catalog: catalog.snapshot(), packs: catalog.summaries(available) }, null, 2)}\n`,
      );
      return 0;
    }
    if (options.command === 'import') {
      const item = available.find(pack => pack.domain === options.domain);
      if (!item) throw Error('Domain is unavailable for this platform.');
      const assets = item.runtimeAssets || [];
      const asset = options.asset
        ? assets.find(entry => entry.id === options.asset)
        : assets.length === 1
          ? assets[0]
          : undefined;
      if (!asset)
        throw Error(
          assets.length
            ? `Specify --asset as one of: ${assets.map(entry => entry.id).join(', ')}.`
            : `Domain ${item.domain} declares no runtime archives.`,
        );
      const result = await manager.importRuntimeArchive(asset, path.resolve(options.file));
      output.write(`${JSON.stringify({ imported: item.domain, ...result })}\n`);
      return 0;
    }
    if (options.command === 'install') {
      const item = available.find(pack => pack.domain === options.domain);
      if (!item) throw Error('Domain is unavailable for this platform.');
      journal.begin([item.domain]);
      const installed = await manager.install(item, {
        prepareRuntime: true,
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
        prepareRuntime: true,
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
