const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const SHA = /^sha256:[a-f0-9]{64}$/;
const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const text = bytes => bytes.toString('utf8').split('\0')[0];

// The owner publishes uncompressed OCI tar archives with compressed layer blobs.
// Read only bounded metadata, seeking over layers; never extract an archive or
// allocate a layer-sized Buffer. The caller has already checked the entire tar hash.
async function inspectOciArchive(file, { configDigest, platform, signal }) {
  const fd = await fs.open(file, 'r');
  try {
    const length = (await fd.stat()).size;
    const entries = new Map();
    const read = async (position, size) => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        signal?.throwIfAborted();
        const result = await fd.read(bytes, offset, size - offset, position + offset);
        if (!result.bytesRead) throw Error('Truncated OCI archive.');
        offset += result.bytesRead;
      }
      return bytes;
    };
    let position = 0,
      count = 0;
    while (position + 512 <= length) {
      if (++count > 20000) throw Error('OCI archive contains too many entries.');
      const header = await read(position, 512);
      if (header.every(byte => byte === 0)) break;
      const octal = bytes => {
        const value = text(bytes).trim();
        if (!/^[0-7]+$/.test(value)) throw Error('Invalid OCI tar numeric field.');
        return Number.parseInt(value, 8);
      };
      const checksum = octal(header.subarray(148, 156));
      const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== sum) throw Error('Invalid OCI tar header checksum.');
      const size = octal(header.subarray(124, 136));
      const prefix = text(header.subarray(345, 500));
      const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
      const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
      const type = header[156];
      const next = position + 512 + Math.ceil(size / 512) * 512;
      if (!Number.isSafeInteger(next) || next > length) throw Error('Truncated OCI archive entry.');
      if (![0, 48, 53].includes(type))
        throw Error('OCI archive contains an unsupported tar entry.');
      if (type !== 53) {
        if (
          !normalized ||
          normalized.split('/').some(p => !p || p === '.' || p === '..') ||
          normalized.includes('\\') ||
          entries.has(normalized)
        )
          throw Error('Invalid or duplicate OCI archive path.');
        entries.set(normalized, { position: position + 512, size });
      }
      position = next;
    }
    const json = async (name, descriptor) => {
      const entry = entries.get(name);
      if (!entry || entry.size > 4 * 1024 * 1024)
        throw Error(`Missing or oversized OCI metadata: ${name}`);
      const bytes = await read(entry.position, entry.size);
      if (descriptor && (entry.size !== descriptor.size || hash(bytes) !== descriptor.digest))
        throw Error('OCI metadata digest or size mismatch.');
      return JSON.parse(bytes.toString('utf8'));
    };
    const blob = descriptor => {
      if (
        !SHA.test(descriptor?.digest || '') ||
        !Number.isSafeInteger(descriptor.size) ||
        descriptor.size < 1
      )
        throw Error('Invalid OCI descriptor.');
      return json('blobs/sha256/' + descriptor.digest.slice(7), descriptor);
    };
    if ((await json('oci-layout')).imageLayoutVersion !== '1.0.0')
      throw Error('Unsupported OCI layout.');
    const index = await json('index.json');
    if (index.schemaVersion !== 2 || index.manifests?.length !== 1)
      throw Error('Release archive must contain exactly one image manifest.');
    const descriptor = index.manifests[0];
    const manifest = await blob(descriptor);
    if (
      manifest.schemaVersion !== 2 ||
      !Array.isArray(manifest.layers) ||
      manifest.config?.digest !== configDigest
    )
      throw Error('OCI image config digest does not match the distribution lock.');
    const config = await blob(manifest.config);
    const actualPlatform = [config.os, config.architecture, config.variant]
      .filter(Boolean)
      .join('/');
    if (actualPlatform !== platform)
      throw Error(`OCI image platform ${actualPlatform} does not match ${platform}.`);
    for (const layer of manifest.layers) {
      if (
        !SHA.test(layer?.digest || '') ||
        entries.get('blobs/sha256/' + layer.digest.slice(7))?.size !== layer.size
      )
        throw Error('Missing or invalid OCI layer.');
    }
    return { manifestDigest: descriptor.digest, configDigest, platform };
  } finally {
    await fd.close();
  }
}

module.exports = { inspectOciArchive };
