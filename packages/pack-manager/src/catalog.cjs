const fs = require('node:fs');
const { InstallationJournal } = require('./installation-journal.cjs');
const { PackManager, compareVersions } = require('./index.cjs');

// Both adapters use the same catalog and readiness descriptions. Catalog entries
// passed to install remain the exact objects authenticated by PackManager.
class PackCatalog {
  constructor({
    directory,
    url,
    keys = {},
    channel = 'beta',
    bundledDirectory,
    declaredDomains = [],
    platform = `${process.platform}-${process.arch}`,
  } = {}) {
    this.manager = new PackManager({ directory, keys, channel });
    this.url = url;
    this.keys = keys;
    this.bundledDirectory = bundledDirectory;
    this.platform = platform;
    this.declaredDomains = declaredDomains;
    this.state = { state: url ? 'not-checked' : 'unconfigured', bundledDomains: 0 };
  }
  snapshot() {
    return { ...this.state };
  }
  async available(options = {}) {
    let packs =
      this.bundledDirectory && fs.existsSync(this.bundledDirectory)
        ? this.manager.bundledCatalog(this.bundledDirectory).packs
        : [];
    this.state = {
      state: this.url ? 'not-checked' : 'unconfigured',
      bundledDomains: packs.filter(item => item.platforms.includes(this.platform)).length,
    };
    if (this.url) {
      try {
        if (!Object.keys(this.keys).length)
          throw Error('The online catalog verification key is not configured.');
        const remote = (await this.manager.catalog(this.url, options)).packs;
        const byDomain = new Map(packs.map(item => [item.domain, item]));
        for (const item of remote) {
          if (!item.platforms.includes(this.platform)) continue;
          const bundled = byDomain.get(item.domain);
          if (
            !bundled ||
            !bundled.platforms.includes(this.platform) ||
            compareVersions(item.version, bundled.version) >= 0
          )
            byDomain.set(item.domain, item);
        }
        packs = [...byDomain.values()];
        this.state.state = 'connected';
      } catch (error) {
        options.signal?.throwIfAborted();
        this.state.state = 'unavailable';
        this.state.message = error.message;
      }
    }
    packs = packs.filter(item => item.platforms.includes(this.platform));
    this.state.compatibleDomains = packs.length;
    const visible = new Set([...packs, ...this.manager.list()].map(item => item.domain));
    this.state.unavailableDomains = this.declaredDomains
      .filter(item => !visible.has(item.id))
      .map(item => ({
        domain: item.id,
        label: item.label,
        emoji: item.emoji,
        summary: item.summary,
        prerequisites: item.prerequisites,
        version: item.version,
        reason:
          item.qualifiedBundlePlatforms?.length === 0
            ? 'not-distributed'
            : item.qualifiedBundlePlatforms &&
                !item.qualifiedBundlePlatforms.includes(this.platform)
              ? 'platform-unsupported'
              : 'catalog-unavailable',
      }));
    return packs;
  }
  summaries(packs) {
    const installed = new Map(this.manager.list().map(item => [item.domain, item.version]));
    return packs.map(entry => ({
      domain: entry.domain,
      label: entry.label,
      emoji: entry.emoji,
      summary: entry.summary,
      prerequisites: entry.prerequisites,
      version: entry.version,
      size: entry.size,
      platforms: entry.platforms,
      runtimeDownloadSize: entry.runtimeDownloadSize,
      runtimeInstalledSize: entry.runtimeInstalledSize,
      viewerAvailable: (entry.pythonEnvironments || []).some(
        asset => asset.purpose === 'viewer' && Boolean(asset.platforms?.[this.platform]),
      ),
      updateAvailable:
        installed.has(entry.domain) &&
        compareVersions(entry.version, installed.get(entry.domain)) > 0,
      ...(this.manager.estimate ? { installation: this.manager.estimate(entry) } : {}),
    }));
  }
}

function describeInstalled(manager, bundle) {
  const allAssets = manager.runtimeStatus(bundle);
  const assets = allAssets.filter(asset => asset.purpose !== 'viewer');
  const viewerAssets = allAssets.filter(asset => asset.purpose === 'viewer');
  return {
    domain: bundle.domain,
    version: bundle.version,
    label: bundle.label,
    emoji: bundle.emoji,
    summary: bundle.summary,
    prerequisites: bundle.prerequisites,
    runtimeState: assets.length
      ? assets.every(asset => asset.ready)
        ? 'ready'
        : 'needs-preparation'
      : bundle.prerequisites?.length
        ? 'external-dependencies'
        : 'installed',
    runtimeAssets: assets,
    viewerState: viewerAssets.length
      ? viewerAssets.every(asset => asset.ready)
        ? 'ready'
        : 'needs-preparation'
      : undefined,
    viewerAssets,
  };
}

module.exports = { PackCatalog, describeInstalled, InstallationJournal };
