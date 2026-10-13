const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transfer, TransferProgress } = require('./transfer.cjs');

// Allow steady large downloads at 64 KiB/s, plus connection overhead. Inactivity
// remains independently bounded by Transfer; the absolute cap prevents runaway jobs.
const runtimeDownloadTimeout = size =>
  Math.min(
    24 * 60 * 60 * 1000,
    Math.max(30 * 60 * 1000, Math.ceil(size / (64 * 1024)) * 1000 + 5 * 60 * 1000),
  );
const strongETag = value =>
  typeof value === 'string' && value.length <= 512 && /^"[\x21\x23-\x7e]+"$/.test(value);
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function ordinary(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe runtime download cache file.');
  return stat;
}
function resumableRuntimeBytes(asset, target) {
  try {
    ordinary(target + '.partial.json');
    const saved = JSON.parse(fs.readFileSync(target + '.partial.json', 'utf8'));
    const stat = ordinary(target + '.partial');
    const final = new URL(saved.finalUrl);
    if (
      saved.url !== asset.url ||
      saved.sha256 !== asset.sha256 ||
      saved.size !== asset.size ||
      !strongETag(saved.etag) ||
      final.protocol !== 'https:' ||
      final.username ||
      final.password ||
      stat.size > asset.size
    )
      return 0;
    return stat.size;
  } catch {
    return 0;
  }
}
async function downloadRuntimeArchive(
  asset,
  target,
  { signal, onProgress = () => {}, transferOptions = {} } = {},
) {
  const partial = target + '.partial',
    metadata = partial + '.json';
  const discard = () => {
    fs.rmSync(partial, { force: true });
    fs.rmSync(metadata, { force: true });
  };
  let received = resumableRuntimeBytes(asset, target);
  const saved = received ? JSON.parse(fs.readFileSync(metadata, 'utf8')) : undefined;
  if (!received) discard();
  const transfer = new Transfer({
    timeoutMs: runtimeDownloadTimeout(asset.size),
    ...transferOptions,
    signal,
  });
  return transfer.run(async () => {
    transfer.signal.throwIfAborted();
    // A cancelled run may already have received the complete object.
    if (received === asset.size) {
      if ((await digest(partial)) !== asset.sha256) {
        discard();
        throw Error('Runtime download hash mismatch.');
      }
      transfer.signal.throwIfAborted();
      fs.renameSync(partial, target);
      fs.rmSync(metadata, { force: true });
      return;
    }
    let response = await transfer.response(asset.url, {
      'accept-encoding': 'identity',
      ...(received ? { range: `bytes=${received}-`, 'if-range': saved.etag } : {}),
    });
    const fail = async message => {
      await response.body?.cancel();
      discard();
      throw Error(message);
    };
    if (
      response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity'
    )
      await fail('Runtime download must not be content encoded.');
    const etag = response.headers.get('etag');
    if (received && response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (
        !range ||
        Number(range[1]) !== received ||
        Number(range[2]) !== asset.size - 1 ||
        Number(range[3]) !== asset.size ||
        etag !== saved.etag ||
        response.transferUrl !== saved.finalUrl
      )
        await fail('Runtime download resume identity or range mismatch.');
    } else if (response.status === 200) {
      // If-Range failed or the server ignores Range: never append a whole object.
      received = 0;
      discard();
    } else await fail('Unexpected runtime download response.');
    const length = response.headers.get('content-length');
    if (length != null && (!/^\d+$/.test(length) || Number(length) !== asset.size - received))
      await fail('Runtime download size mismatch.');
    if (strongETag(etag)) {
      fs.writeFileSync(
        metadata,
        JSON.stringify({
          url: asset.url,
          finalUrl: response.transferUrl,
          sha256: asset.sha256,
          size: asset.size,
          etag,
        }),
        { mode: 0o600, flag: 'w' },
      );
    }
    const fd = fs.openSync(partial, received ? 'a' : 'wx', 0o600);
    const initial = received,
      progress = new TransferProgress(asset.size);
    let reported = received;
    try {
      onProgress({ phase: 'downloading', received, total: asset.size });
      for await (const chunk of response.body) {
        transfer.signal.throwIfAborted();
        transfer.touch();
        received += chunk.length;
        if (received > asset.size) {
          discard();
          throw Error('Runtime download size mismatch.');
        }
        fs.writeFileSync(fd, chunk);
        if (received - reported >= 1024 * 1024 || received === asset.size) {
          // Measure only newly transferred bytes, not cached bytes, for rate/ETA.
          const state = progress.update(received - initial);
          onProgress({
            ...state,
            received,
            etaSeconds: state.bytesPerSecond
              ? Math.max(0, (asset.size - received) / state.bytesPerSecond)
              : undefined,
          });
          reported = received;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    if (received !== asset.size)
      throw Error('Runtime download interrupted before declared size. Retry to resume.');
    if ((await digest(partial)) !== asset.sha256) {
      discard();
      throw Error('Runtime download hash mismatch.');
    }
    transfer.signal.throwIfAborted();
    fs.renameSync(partial, target);
    fs.rmSync(metadata, { force: true });
  });
}
module.exports = { downloadRuntimeArchive, runtimeDownloadTimeout, resumableRuntimeBytes };
