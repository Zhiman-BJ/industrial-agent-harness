#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const [archive, output, releaseTag, ...extra] = process.argv.slice(2);
if (
  !archive ||
  !output ||
  !/^chip-linux-installer-v\d+\.\d+\.\d+-preview\.\d+$/.test(releaseTag || '') ||
  extra.length
) {
  console.error(
    'Usage: node scripts/package-linux-chip-installer.cjs CHIP_ARCHIVE OUTPUT.run chip-linux-installer-vVERSION-preview.N',
  );
  process.exit(64);
}
const bootstrapOutput = path.join(path.dirname(path.resolve(output)), 'install-chip-linux.sh');
if (fs.existsSync(output) || fs.existsSync(output + '.sha256') || fs.existsSync(bootstrapOutput))
  throw Error('Installer output already exists.');
const inspect = args => {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw Error(result.stderr || 'Cannot inspect archive.');
  return result.stdout;
};
const entries = inspect(['-tzf', archive]).trim().split('\n');
const roots = [...new Set(entries.map(name => name.replace(/^\.\//, '').split('/')[0]))];
if (
  roots.length !== 1 ||
  !/^[a-zA-Z0-9_-]+$/.test(roots[0]) ||
  entries.some(name => path.posix.isAbsolute(name) || name.split('/').includes('..'))
)
  throw Error('Archive needs one safe top-level directory.');
const top = roots[0];
const metadata = JSON.parse(inspect(['-xOzf', archive, `${top}/HARNESS-PACKAGE.json`]));
if (!entries.includes(`${top}/scripts/verify-kimi-launcher.cjs`))
  throw Error('Chip archive does not contain the current-user launcher verification script.');
if (metadata.domain !== 'chip') throw Error('Installer requires a Chip-only CLI package.');
if (metadata.sourceDirty !== false || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit || ''))
  throw Error('Installer requires a clean committed CLI package.');
const execution = inspect([
  '-xOzf',
  archive,
  `${top}/domain-packs/chip/eda-harness/src/eda_harness/runtimes/execution.py`,
]);
if (!execution.includes('sys.platform.startswith("linux")') || !execution.includes('os.getuid()'))
  throw Error('Chip archive does not contain the native Linux UID/GID fix.');
const payload = fs.readFileSync(archive);
const digest = crypto.createHash('sha256').update(payload).digest('hex');
const header = fs
  .readFileSync(path.join(__dirname, 'installers/linux-installer-header.sh'), 'utf8')
  .replace('@PAYLOAD_SHA256@', digest)
  .replace('@PAYLOAD_DIRECTORY@', top)
  .replaceAll('@RELEASE_TAG@', releaseTag);
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
const file = Buffer.concat([
  Buffer.from(header.replace(/\n?$/, '\n') + '__HARNESS_ARCHIVE_BELOW__\n'),
  payload,
]);
fs.writeFileSync(output, file, { mode: 0o755, flag: 'wx' });
const checksum = crypto.createHash('sha256').update(file).digest('hex');
fs.writeFileSync(output + '.sha256', `${checksum}  ${path.basename(output)}\n`, { flag: 'wx' });
const bootstrap = fs
  .readFileSync(path.join(__dirname, 'installers/linux-bootstrap.sh'), 'utf8')
  .replace('@INSTALLER_SHA256@', checksum)
  .replace(
    '@INSTALLER_URL@',
    `https://github.com/Zhiman-BJ/industrial-agent-harness/releases/download/${releaseTag}/industrial-harness-chip-linux-install.run`,
  );
fs.writeFileSync(bootstrapOutput, bootstrap, { mode: 0o755, flag: 'wx' });
const bootstrapDigest = crypto.createHash('sha256').update(bootstrap).digest('hex');
fs.writeFileSync(
  bootstrapOutput + '.sha256',
  `${bootstrapDigest}  ${path.basename(bootstrapOutput)}\n`,
  { flag: 'wx' },
);
console.log(
  JSON.stringify(
    {
      output: path.resolve(output),
      bytes: file.length,
      sha256: checksum,
      payloadSha256: digest,
      bootstrap: bootstrapOutput,
      bootstrapSha256: bootstrapDigest,
      package: metadata,
      releaseTag,
      published: false,
    },
    null,
    2,
  ),
);
