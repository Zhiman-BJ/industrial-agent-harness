const fs = require('node:fs');
const crypto = require('node:crypto');
const { projectFile } = require('./workspace-files.cjs');

// A read-only, request-scoped observation of the exact recorded input files.
// It does not run a Pack, acquire a remote lease, or alter historical facts.
// Matching files are not a claim that a producer declared every dependency.
function createEvidenceInspector(projectDir) {
  const cache = new Map();
  let bytesRead = 0;
  const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  function currentHash(name) {
    if (cache.has(name)) return cache.get(name);
    if (cache.size >= 4096) return { status: 'unavailable' };
    let value;
    try {
      const file = projectFile(projectDir, name);
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
      );
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink > 1n) throw Error('Expected an ordinary input file.');
        if (
          before.size > 64n * 1024n * 1024n ||
          bytesRead + Number(before.size) > 256 * 1024 * 1024
        )
          throw Error('Evidence inputs exceed the inspection budget.');
        const digest = crypto.createHash('sha256');
        const buffer = Buffer.alloc(65536);
        let count = 0;
        while (count < Number(before.size)) {
          const read = fs.readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, Number(before.size) - count),
          );
          if (!read) break;
          count += read;
          bytesRead += read;
          digest.update(buffer.subarray(0, read));
        }
        if (
          count !== Number(before.size) ||
          identity(before) !== identity(fs.fstatSync(fd, { bigint: true })) ||
          identity(before) !==
            identity(fs.statSync(projectFile(projectDir, name), { bigint: true }))
        )
          throw Error('Input changed while inspecting evidence.');
        value = { hash: digest.digest('hex') };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      value = { status: error.code === 'ENOENT' ? 'changed' : 'unavailable' };
    }
    cache.set(name, value);
    return value;
  }
  return inputHashes => {
    const entries = Object.entries(inputHashes || {});
    if (!entries.length) return { status: 'unchecked', changedPaths: [] };
    const changedPaths = [];
    let unavailable = false;
    for (const [name, expected] of entries) {
      const current = currentHash(name);
      if (current.status === 'unavailable' || !/^[a-f0-9]{64}$/.test(expected)) unavailable = true;
      else if (current.status === 'changed' || current.hash !== expected) {
        if (changedPaths.length < 20) changedPaths.push(name);
      }
    }
    return {
      status: changedPaths.length ? 'changed' : unavailable ? 'unavailable' : 'matches',
      changedPaths,
    };
  };
}

// Only trusted producer code can bind a result to bytes captured before work.
// JSON/tool arguments cannot assert this guarantee. The binding is per Action.
const snapshotResults = new WeakMap();
function bindSnapshotResult(result, action) {
  snapshotResults.set(result, {
    actionId: action.id,
    inputs: JSON.stringify(Object.entries(action.inputHashes).sort()),
  });
  return result;
}
function hasSnapshotBinding(result, action) {
  const binding = result && snapshotResults.get(result);
  return (
    binding?.actionId === action.id &&
    binding.inputs === JSON.stringify(Object.entries(action.inputHashes).sort())
  );
}

module.exports = { createEvidenceInspector, bindSnapshotResult, hasSnapshotBinding };
