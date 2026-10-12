#!/usr/bin/env node
// Opt-in real-network QA. Uses the production downloader with its default limits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const repositoryRoot = path.resolve(__dirname, '..');
const {
  RuntimeAssetManager,
  fileHash,
} = require('../packages/pack-manager/src/runtime-assets.cjs');
const { archiveDeclarations } = require('./prepare-ci-runtime-archives.cjs');

async function main() {
  const invocationStartedAt = new Date().toISOString();
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const selectedOutput = outputIndex < 0 ? undefined : args.splice(outputIndex, 2)[1];
  if (outputIndex >= 0 && (!selectedOutput || selectedOutput.startsWith('--')))
    throw Error('--output requires a new evidence directory.');
  const cancellationIndex = args.indexOf('--cancel-recover');
  const cancelRecover = cancellationIndex >= 0;
  if (cancelRecover) args.splice(cancellationIndex, 1);
  const ids = args;
  if (
    !ids.length ||
    ids.length > 2 ||
    new Set(ids).size !== ids.length ||
    ids.some(id => !['kicad', 'freecad', 'godot'].includes(id))
  )
    throw Error('Choose one or two distinct native asset IDs: kicad freecad godot.');
  if (cancelRecover && ids.length !== 1)
    throw Error('--cancel-recover requires exactly one asset.');
  const gitStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const snapshot = {
    schemaVersion: 1,
    startedAt: invocationStartedAt,
    repositoryRoot,
    entryWorkingDirectory: process.cwd(),
    hostCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim(),
    dirty: gitStatus.length > 0,
    gitStatus,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    script: path.relative(repositoryRoot, __filename),
    scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    ownerPin: require('../apps/cli/package.json').dependencies[
      '@zhiman-bj/industrial-domain-packs'
    ],
    assets: ids,
    cancelRecover,
  };
  const snapshotBytes = JSON.stringify(snapshot, null, 2) + '\n';
  const snapshotSha256 = crypto.createHash('sha256').update(snapshotBytes).digest('hex');
  const evidence = path.resolve(
    repositoryRoot,
    selectedOutput ||
      path.join(
        'dist',
        'qa-first-install-' +
          new Date().toISOString().replace(/[^0-9]/g, '') +
          '-' +
          crypto.randomUUID(),
        'downloads',
      ),
  );
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  try {
    // Reserve the leaf atomically: concurrent invocations must never share reports.
    fs.mkdirSync(evidence, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error('Evidence directory must be new; refusing existing or nonempty evidence.', {
        cause: error,
      });
    throw error;
  }
  fs.writeFileSync(path.join(evidence, 'invocation.json'), snapshotBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  const temporaryStore = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-first-download-'));
  const assets = archiveDeclarations(temporaryStore);
  const allReports = [];
  const context = new AsyncLocalStorage();
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const report = context.getStore();
    const url = new URL(typeof input === 'string' ? input : input.url || String(input));
    const event = { startedAt: new Date().toISOString(), origin: url.origin, path: url.pathname };
    report?.requests.push(event);
    try {
      const response = await originalFetch(input, options);
      Object.assign(event, {
        status: response.status,
        contentLength: response.headers.get('content-length'),
        completedHeadersAt: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      event.error = error.message;
      throw error;
    }
  };
  const save = report =>
    fs.writeFileSync(
      path.join(evidence, `${report.id}-${report.attempt}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
  try {
    const results = await Promise.all(
      ids.map(async id => {
        const asset = assets.find(asset => asset.id === id);
        const store = path.join(temporaryStore, id);
        const manager = new RuntimeAssetManager({ directory: store });
        const cache = path.join(manager.directory, 'cache');
        fs.mkdirSync(cache, { recursive: true });
        const target = path.join(
          cache,
          asset.sha256 + (asset.type === 'macos-app-zip' ? '.zip' : '.dmg'),
        );
        const attempt = async (name, cancelAfterProgress) => {
          const controller = new AbortController();
          const cancellationReason = Error(
            'QA user cancellation after first production download progress.',
          );
          const report = {
            id,
            attempt: name,
            startedAt: new Date().toISOString(),
            status: 'running',
            hostCommit: snapshot.hostCommit,
            ownerPin: snapshot.ownerPin,
            invocationSnapshot: 'invocation.json',
            invocationSnapshotSha256: snapshotSha256,
            mode: 'production-RuntimeAssetManager-fetchArchive-download-only',
            temporaryStore: store,
            initialCacheFiles: fs.readdirSync(cache),
            parallelDownloadsInThisInvocation: ids.length,
            externalTraffic: 'Not measured by this process; consult coordinated Desktop evidence.',
            url: asset.url,
            expectedSize: asset.size,
            expectedSha256: asset.sha256,
            downloaderOverrides: false,
            defaultStallMs: 60000,
            defaultTotalTimeoutMs: 1200000,
            requests: [],
            progress: [],
            retries: name === 'recovery' ? 1 : 0,
            userCancellationRequested: false,
          };
          allReports.push(report);
          const started = performance.now();
          let received = 0;
          const snapshot = () => {
            const partials = fs.readdirSync(cache).filter(name => name.endsWith('.partial'));
            report.progress.push({
              at: new Date().toISOString(),
              received,
              partialBytes: partials.reduce(
                (sum, name) => sum + fs.statSync(path.join(cache, name)).size,
                0,
              ),
            });
            save(report);
            console.log(
              JSON.stringify({
                id,
                status: report.status,
                seconds: Math.round((performance.now() - started) / 1000),
                received,
              }),
            );
          };
          snapshot();
          const heartbeat = setInterval(snapshot, 30000);
          try {
            await context.run(report, () =>
              manager.fetchArchive(asset, target, {
                signal: controller.signal,
                onProgress: progress => {
                  received = progress.received;
                  if (
                    cancelAfterProgress &&
                    received >= 1024 * 1024 &&
                    !controller.signal.aborted
                  ) {
                    report.userCancellationRequested = true;
                    report.cancellationRequestedAt = new Date().toISOString();
                    controller.abort(cancellationReason);
                  }
                },
              }),
            );
            report.actualSize = fs.statSync(target).size;
            report.actualSha256 = await fileHash(target);
            report.status =
              report.actualSize === asset.size && report.actualSha256 === asset.sha256
                ? 'download-verified'
                : 'failed';
          } catch (error) {
            report.status = error === cancellationReason ? 'cancelled' : 'failed';
            report.error = {
              name: error.name,
              message: error.message,
              code: error.code,
              cause: error.cause
                ? { name: error.cause.name, message: error.cause.message, code: error.cause.code }
                : undefined,
            };
          } finally {
            clearInterval(heartbeat);
            report.finishedAt = new Date().toISOString();
            report.elapsedSeconds = (performance.now() - started) / 1000;
            report.lastReportedReceived = received;
            report.remainingCacheFiles = fs.readdirSync(cache);
            report.partialFilesCleaned = !report.remainingCacheFiles.some(name =>
              name.endsWith('.partial'),
            );
            report.archiveRetained = fs.existsSync(target);
            report.appInstalled = false;
            report.runtimeReady = manager.status([asset])[0].ready;
            report.officialFallbackObserved = report.requests.some(
              request => request.origin !== 'https://harbor.pvg2.zhiman.tech',
            );
            save(report);
            console.log(
              JSON.stringify({
                id,
                status: report.status,
                seconds: report.elapsedSeconds,
                error: report.error?.message,
                partialFilesCleaned: report.partialFilesCleaned,
              }),
            );
          }
          return report;
        };
        if (cancelRecover) {
          const cancelled = await attempt('cancellation', true);
          if (
            cancelled.status !== 'cancelled' ||
            !cancelled.partialFilesCleaned ||
            cancelled.archiveRetained ||
            !cancelled.userCancellationRequested ||
            cancelled.officialFallbackObserved ||
            cancelled.runtimeReady ||
            cancelled.appInstalled ||
            cancelled.initialCacheFiles.length !== 0
          )
            return cancelled;
          const recovered = await attempt('recovery', false);
          recovered.cancellationValidated = true;
          save(recovered);
          return recovered;
        }
        return attempt('first-attempt', false);
      }),
    );
    for (const result of results) {
      result.qaPassed =
        result.status === 'download-verified' &&
        result.actualSize === result.expectedSize &&
        result.actualSha256 === result.expectedSha256 &&
        result.partialFilesCleaned &&
        !result.officialFallbackObserved &&
        result.requests.length > 0 &&
        result.requests.every(request => request.origin === new URL(result.url).origin) &&
        result.initialCacheFiles.length === 0 &&
        !result.runtimeReady &&
        !result.appInstalled &&
        (!cancelRecover || result.cancellationValidated === true);
      save(result);
    }
    // Only this invocation's own mkdtemp store is removed, after all attempts end.
    fs.rmSync(temporaryStore, { recursive: true, force: true });
    for (const result of allReports) {
      result.temporaryStoreCleaned = !fs.existsSync(temporaryStore);
      if (result.qaPassed !== undefined) result.qaPassed &&= result.temporaryStoreCleaned;
      save(result);
    }
    if (results.some(result => !result.qaPassed)) process.exitCode = 1;
  } finally {
    global.fetch = originalFetch;
  }
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
