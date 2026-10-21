const { PackManager } = require('@industrial-agent-harness/pack-manager');
const { domainPacks } = require('@industrial-agent-harness/domain-skills');

// Developer convenience entry over the same pinned, private installer used by
// Domain installation and repair. It neither discovers nor changes host Python.
async function main() {
  const declarations = domainPacks
    .flatMap(pack => pack.pythonEnvironments || [])
    .filter(environment => environment.purpose === 'viewer' && environment.viewer === 'layout');
  if (!declarations.length)
    throw Error('The installed Domain Pack does not declare a layout runtime.');
  const manager = new PackManager();
  await manager.pythonEnvironments.ensure(declarations, {
    recheck: true,
    onProgress: progress =>
      process.stdout.write(`${progress.label || progress.asset || 'Viewer'}: ${progress.phase}\n`),
  });
  const python = manager.pythonEnvironments.resolve(declarations, 'layout');
  if (!python) throw Error('The layout Viewer dependency is not ready.');
  process.stdout.write(`Managed layout Viewer Python is ready: ${python}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
