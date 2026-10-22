'use strict';

// Passive, hash-bound replay snapshots only. An asset reference never resolves
// a historical project path or activates a document/browser/industrial runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RecordingError } = require('./loader.cjs');
const { isSafeRelativePath, uuidLike } = require('./manifest.cjs');
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
function fail(code, message) {
  throw new RecordingError(`replay-asset:${code}`, message);
}

function validateReplayStages(manifest) {
  if (manifest.replayStages === undefined) return [];
  if (!Array.isArray(manifest.replayStages) || manifest.replayStages.length > 100)
    return ['replay-asset:stages'];
  const ids = new Set();
  let previousSeq = 0;
  for (const stage of manifest.replayStages) {
    if (!stage || !uuidLike(stage.id)) return ['replay-asset:stage'];
    const asset = manifest.assets?.find(asset => asset.id === stage.assetId);
    if (
      ids.has(stage.id) ||
      !Number.isInteger(stage.atSeq) ||
      stage.atSeq <= previousSeq ||
      stage.atSeq > manifest.events.count ||
      typeof stage.title !== 'string' ||
      stage.title.length > 256 ||
      (stage.description !== undefined &&
        (typeof stage.description !== 'string' || stage.description.length > 4000)) ||
      !asset ||
      asset.type !== 'image' ||
      asset.status !== 'present'
    )
      return ['replay-asset:stage'];
    ids.add(stage.id);
    previousSeq = stage.atSeq;
  }
  return [];
}

function readReplayImage(bundle, assetId) {
  const asset = bundle.manifest.assets?.find(asset => asset.id === assetId);
  if (!asset || asset.type !== 'image' || asset.status !== 'present')
    fail('unknown', 'Image is not a declared present replay asset');
  if (!bundle.sourceDirectory || !isSafeRelativePath(asset.relativePath))
    fail('path', 'Replay image has no bounded directory source');
  const root = path.resolve(bundle.sourceDirectory);
  let current = root;
  for (const part of ['', ...asset.relativePath.split('/')]) {
    current = part ? path.join(current, part) : current;
    if (fs.lstatSync(current).isSymbolicLink())
      fail('link', 'Replay image paths must not contain links');
  }
  const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size !== asset.bytes ||
      stat.size > MAX_IMAGE_BYTES ||
      stat.size < 24
    )
      fail('size', 'Replay image size mismatch or limit exceeded');
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== asset.sha256)
    fail('hash', 'Replay image digest differs from the recorded snapshot');
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(12, 16).toString() !== 'IHDR'
  )
    fail('format', 'Only passive PNG snapshots are supported');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024)
    fail('dimensions', 'Replay image dimensions exceed bounds');
  return {
    mime: 'image/png',
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    sha256,
    bytes: bytes.length,
    width,
    height,
  };
}

module.exports = { readReplayImage, validateReplayStages, MAX_IMAGE_BYTES };
