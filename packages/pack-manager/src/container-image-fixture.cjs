const fs = require('node:fs');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function header(name, size) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100);
  b.write('0000644\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write('00000000000\0', 136);
  b.fill(32, 148, 156);
  b[156] = 48;
  b.write('ustar\0', 257);
  b.write('00', 263);
  b.write(
    b
      .reduce((sum, v) => sum + v, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return b;
}
async function writeOciFixture(
  file,
  { layerBytes = 0, tagged = false, configExtra = {}, badConfig = false } = {},
) {
  const chunk = Buffer.alloc(65536, 90);
  const layerHash = crypto.createHash('sha256');
  for (let remaining = layerBytes; remaining > 0; remaining -= chunk.length)
    layerHash.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
  const layerDigest = 'sha256:' + layerHash.digest('hex');
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: { Labels: { fixture: crypto.randomUUID() } },
      rootfs: { type: 'layers', diff_ids: [] },
      history: [],
      ...configExtra,
    }),
  );
  const configDigest = 'sha256:' + hash(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: config.length,
      },
      layers: layerBytes
        ? [
            {
              mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
              digest: layerDigest,
              size: layerBytes,
            },
          ]
        : [],
    }),
  );
  const manifestDigest = 'sha256:' + hash(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: manifestDigest,
          size: manifest.length,
          ...(tagged
            ? {
                annotations: {
                  'io.containerd.image.name': 'docker.io/library/review-image:v1',
                  'org.opencontainers.image.ref.name': 'v1',
                },
              }
            : {}),
        },
      ],
    }),
  );
  const fd = fs.openSync(file, 'wx');
  const archiveHash = crypto.createHash('sha256');
  let size = 0;
  const write = b => {
    fs.writeFileSync(fd, b);
    archiveHash.update(b);
    size += b.length;
  };
  const entry = (name, bytes) => {
    write(header(name, bytes.length));
    write(bytes);
    if (bytes.length % 512) write(Buffer.alloc(512 - (bytes.length % 512)));
  };
  try {
    if (layerBytes) {
      write(header('blobs/sha256/' + layerDigest.slice(7), layerBytes));
      for (let remaining = layerBytes; remaining > 0; remaining -= chunk.length)
        write(chunk.subarray(0, Math.min(remaining, chunk.length)));
      if (layerBytes % 512) write(Buffer.alloc(512 - (layerBytes % 512)));
    }
    entry('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}'));
    entry('index.json', index);
    entry('blobs/sha256/' + manifestDigest.slice(7), manifest);
    entry(
      'blobs/sha256/' + configDigest.slice(7),
      badConfig ? Buffer.alloc(config.length, 32) : config,
    );
    write(Buffer.alloc(1024));
  } finally {
    fs.closeSync(fd);
  }
  const lock = {
    schemaVersion: 1,
    registry: 'ghcr.io',
    imageNamespace: 'example',
    releaseAssetUrlTemplate: 'https://release.example/{tag}/{archive}',
    images: [
      {
        id: 'review-image',
        pack: 'review',
        repository: 'review-image',
        platform: 'linux/amd64',
        current: {
          tag: 'v1',
          imageDigest: 'sha256:' + 'e'.repeat(64),
          configDigest,
          ociArchive: 'review-v1.tar',
          ociArchiveSha256: archiveHash.digest('hex'),
          ociArchiveBytes: size,
        },
      },
      {
        id: 'unreleased',
        pack: 'review',
        repository: 'unreleased',
        platform: 'linux/amd64',
        current: null,
      },
    ],
  };
  return { lock, manifestDigest, configDigest, file, bytes: size };
}
function dockerFixture(identity, { classic = false, failAt } = {}) {
  const calls = [];
  let loaded = false,
    tagged = false;
  const imageId = classic ? identity.configDigest : identity.manifestDigest;
  const command = async (_docker, args, { signal } = {}) => {
    signal?.throwIfAborted();
    calls.push(args);
    const operation = args.slice(0, 2).join(' ');
    if (operation === failAt || args[0] === failAt)
      throw Error('fixture Docker failure at ' + failAt);
    if (args[0] === 'info') return 'linux';
    if (args[0] === 'load') {
      loaded = true;
      return 'Loaded image ID: ' + imageId;
    }
    if (args[1] === 'inspect') {
      const reference = args.at(-1);
      if (!loaded || (reference !== imageId && !(tagged && reference === 'review-image:v1')))
        throw Error('No such image');
      return imageId;
    }
    if (args[1] === 'tag' && args[2] === imageId) {
      tagged = true;
      return '';
    }
    throw Error('Unexpected Docker command: ' + args.join(' '));
  };
  return { command, calls };
}
module.exports = { writeOciFixture, dockerFixture, header };
