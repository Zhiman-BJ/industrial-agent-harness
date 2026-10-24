'use strict';

// A native export is evidence, never an executable project. Read only bounded
// members, verify checksums, and never extract or evaluate archive contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { isSafeRelativePath } = require('./manifest.cjs');
const { loadBundle, RecordingError } = require('./loader.cjs');
const { projectNativeTrajectory } = require('./native-trajectory.cjs');
const { validateReplayStages } = require('./replay-assets.cjs');

const INPUT_LIMITS = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxMemberBytes: 128 * 1024 * 1024,
  maxEntries: 10000,
  maxCompressionRatio: 200,
  maxPaxBytes: 64 * 1024,
  maxPaxFields: 1024,
});
const NATIVE_FILES = new Set(['manifest.json', 'events.timeline.jsonl', 'diagnostics.json']);
function fail(code, message) {
  throw new RecordingError(`native:${code}`, message);
}
function safeName(name) {
  if (!isSafeRelativePath(name)) fail('unsafe-path', `Unsafe export member: ${name}`);
  return name;
}
function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function checkSums(checksumText, hashes, wanted) {
  if (!checksumText) fail('checksums-missing', 'Native exports require SHA256SUMS');
  const checked = new Set();
  for (const line of checksumText.trim().split('\n')) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    if (!match) fail('checksums-format', 'Malformed SHA256SUMS');
    const name = safeName(match[2]);
    if (checked.has(name)) fail('checksums-duplicate', `Duplicate checksum: ${name}`);
    if (hashes.get(name) !== match[1])
      fail('checksum-mismatch', `Checksum mismatch or absent file: ${name}`);
    checked.add(name);
  }
  for (const name of wanted)
    if (!checked.has(name)) fail('checksum-missing', `No checksum for ${name}`);
  for (const name of hashes.keys()) {
    if (name !== 'SHA256SUMS' && !checked.has(name))
      fail('checksum-missing', `Unverified export file: ${name}`);
  }
  return checked.size;
}

async function readDirectory(directory, limits) {
  const files = new Map();
  const hashes = new Map();
  let totalBytes = 0;
  let entries = 0;
  async function walk(relative = '') {
    for (const entry of await fs.promises.readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = safeName(relative ? `${relative}/${entry.name}` : entry.name);
      if (++entries > limits.maxEntries) fail('entry-limit', 'Too many export entries');
      const absolute = path.join(directory, name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) fail('unsafe-link', `Links are not permitted: ${name}`);
      if (stat.isDirectory()) {
        await walk(name);
        continue;
      }
      if (!stat.isFile()) fail('member-type', `Not a regular export file: ${name}`);
      totalBytes += stat.size;
      if (stat.size > limits.maxMemberBytes || totalBytes > limits.maxTotalBytes)
        fail('size-limit', 'Export exceeds byte limit');
      // O_NOFOLLOW prevents a final-component link swap during a read.
      const handle = await fs.promises.open(
        absolute,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        const content = await handle.readFile();
        if (content.length !== stat.size)
          fail('changed-input', `Export changed while reading: ${name}`);
        hashes.set(name, digest(content));
        if (NATIVE_FILES.has(name) || name === 'SHA256SUMS')
          files.set(name, content.toString('utf8'));
      } finally {
        await handle.close();
      }
    }
  }
  await walk();
  return { files, hashes, totalBytes };
}

function tarText(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString('utf8')
    .split('\0')[0];
}
function tarNumber(buffer, start, length) {
  const text = tarText(buffer, start, length).trim();
  if (!/^[0-7]+$/.test(text)) fail('tar-header', 'Invalid tar numeric header');
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail('tar-header', 'Oversize tar numeric header');
  return value;
}
function paxFields(buffer, limits) {
  const fields = {};
  let offset = 0;
  let count = 0;
  while (offset < buffer.length) {
    if (++count > limits.maxPaxFields) fail('tar-pax-limit', 'Too many PAX fields');
    const space = buffer.indexOf(32, offset);
    if (space < 0) fail('tar-pax', 'Malformed PAX record');
    const length = Number(buffer.subarray(offset, space).toString());
    if (
      !Number.isInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > buffer.length
    )
      fail('tar-pax', 'Malformed PAX length');
    if (buffer[offset + length - 1] !== 10) fail('tar-pax', 'PAX record must end with a newline');
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = record.indexOf('=');
    if (equal < 1) fail('tar-pax', 'Malformed PAX field');
    fields[record.slice(0, equal)] = record.slice(equal + 1);
    offset += length;
  }
  return fields;
}

async function readArchive(input, limits) {
  const stat = await fs.promises.lstat(input);
  if (!stat.isFile() || stat.size > limits.maxArchiveBytes)
    fail('archive-size', 'Archive exceeds compressed byte limit');
  const files = new Map();
  const hashes = new Map();
  const names = new Set();
  const relativeNames = new Set();
  let pending = Buffer.alloc(0);
  let member = null;
  let root = null;
  let pax = {};
  let globalPax = {};
  let entries = 0;
  let totalBytes = 0;
  let expandedBytes = 0;
  let ended = false;
  const source = fs.createReadStream(input);
  const unzip = zlib.createGunzip();
  source.on('error', error => unzip.destroy(error));
  source.pipe(unzip);
  try {
    for await (const chunk of unzip) {
      expandedBytes += chunk.length;
      if (expandedBytes > stat.size * limits.maxCompressionRatio)
        fail('compression-ratio', 'Archive exceeds decompression ratio limit');
      if (expandedBytes > limits.maxTotalBytes + limits.maxEntries * 2048)
        fail('size-limit', 'Archive exceeds decompression limit');
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (true) {
        if (!member) {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every(byte => byte === 0)) {
            ended = true;
            continue;
          }
          if (ended) fail('tar-trailing', 'Unexpected data after tar end marker');
          let sum = 0;
          for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
          if (sum !== tarNumber(header, 148, 8))
            fail('tar-checksum', 'Invalid tar header checksum');
          if (++entries > limits.maxEntries) fail('entry-limit', 'Too many archive entries');
          const size = tarNumber(header, 124, 12);
          if (size > limits.maxMemberBytes) fail('size-limit', 'Archive member exceeds byte limit');
          totalBytes += size;
          if (totalBytes > limits.maxTotalBytes) fail('size-limit', 'Archive exceeds byte limit');
          const type = String.fromCharCode(header[156]);
          if ((type === 'x' || type === 'g') && size > limits.maxPaxBytes)
            fail('tar-pax-limit', 'PAX metadata exceeds byte limit');
          const prefix = tarText(header, 345, 155);
          let name = (prefix ? `${prefix}/` : '') + tarText(header, 0, 100);
          const attributes = { ...globalPax, ...pax };
          if (type !== 'x' && type !== 'g') {
            name = attributes.path || name;
            pax = {};
          }
          name = name.replace(/\/$/, '');
          // PAX headers have conventional names such as ././@PaxHeader;
          // these are metadata, never files. Validate the effective file path.
          if (type !== 'x' && type !== 'g') safeName(name);
          if (!['0', '\0', '5', 'x', 'g'].includes(type))
            fail('member-type', `Unsupported archive member type ${type}: ${name}`);
          if (attributes.linkpath || attributes.size)
            fail('tar-pax', 'PAX link/size overrides are not supported');
          let relative = null;
          if (type !== 'x' && type !== 'g') {
            if (names.has(name)) fail('duplicate-member', `Duplicate archive member: ${name}`);
            names.add(name);
            const parts = name.split('/');
            if (root === null)
              root =
                parts.length === 1 && type === '5' ? parts[0] : parts.length > 1 ? parts[0] : '';
            if (root && parts[0] !== root)
              fail('archive-root', 'Archive must contain one export root');
            relative = root ? parts.slice(1).join('/') : name;
            if (relative) {
              safeName(relative);
              if (relativeNames.has(relative))
                fail('duplicate-member', `Duplicate normalized archive member: ${relative}`);
              relativeNames.add(relative);
            }
          }
          member = {
            type,
            size,
            remaining: size,
            padding: (512 - (size % 512)) % 512,
            relative,
            hash: crypto.createHash('sha256'),
            parts: [],
            retain:
              type === 'x' ||
              type === 'g' ||
              NATIVE_FILES.has(relative) ||
              relative === 'SHA256SUMS',
          };
        }
        if (member.remaining) {
          if (!pending.length) break;
          const length = Math.min(pending.length, member.remaining);
          const part = pending.subarray(0, length);
          member.hash.update(part);
          if (member.retain) member.parts.push(Buffer.from(part));
          member.remaining -= length;
          pending = pending.subarray(length);
          if (member.remaining) break;
        }
        if (pending.length < member.padding) break;
        pending = pending.subarray(member.padding);
        if (member.type === 'x') pax = paxFields(Buffer.concat(member.parts), limits);
        else if (member.type === 'g') {
          globalPax = { ...globalPax, ...paxFields(Buffer.concat(member.parts), limits) };
          if (Object.keys(globalPax).length > limits.maxPaxFields)
            fail('tar-pax-limit', 'Too many global PAX fields');
        } else if (member.type !== '5' && member.relative) {
          hashes.set(member.relative, member.hash.digest('hex'));
          if (member.retain)
            files.set(member.relative, Buffer.concat(member.parts).toString('utf8'));
        }
        member = null;
      }
    }
    if (member || pending.some(byte => byte !== 0) || !ended)
      fail('tar-truncated', 'Incomplete tar archive');
  } finally {
    source.destroy();
    unzip.destroy();
  }
  return { files, hashes, totalBytes };
}

async function loadReplayInput(input, options = {}) {
  const limits = { ...INPUT_LIMITS, ...options.limits };
  const stat = await fs.promises.lstat(input);
  if (stat.isSymbolicLink()) fail('unsafe-link', 'Replay input must not be a link');
  if (stat.isDirectory() && fs.existsSync(path.join(input, 'recording.json'))) {
    const bundle = loadBundle(input);
    const errors = validateReplayStages(bundle.manifest);
    if (errors.length) throw new RecordingError(errors[0], 'Invalid replay snapshot stages');
    bundle.sourceDirectory = path.resolve(input);
    return bundle;
  }
  const data = stat.isDirectory()
    ? await readDirectory(input, limits)
    : await readArchive(input, limits);
  const verifiedFiles = checkSums(data.files.get('SHA256SUMS'), data.hashes, NATIVE_FILES);
  const bundle = projectNativeTrajectory(data.files);
  bundle.native.verifiedFiles = verifiedFiles;
  bundle.native.sourceBytes = data.totalBytes;
  return bundle;
}

module.exports = { loadReplayInput, INPUT_LIMITS };
