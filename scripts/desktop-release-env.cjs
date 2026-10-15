#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const version = require('../apps/desktop/package.json').version;
if (process.env.GITHUB_REF_NAME !== `desktop-v${version}`)
  throw Error('Desktop release tag must match apps/desktop/package.json version.');
const channel = version.includes('-beta.') ? 'beta' : 'stable';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPOSITORY || ''))
  throw Error('Invalid GitHub repository.');
const feed = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/desktop-${channel}-feed`;
// A platform without complete signing credentials builds an unsigned internal
// installer instead of failing the release: the same pipeline upgrades to
// signed, notarized installers once the secrets are configured.
const macSigning = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_P8_B64',
].every(name => process.env[name]);
const winSigning = Boolean(process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD);
const signing = process.platform === 'win32' ? winSigning : macSigning;
const environment = {
  HARNESS_RELEASE_BUILD: signing ? '1' : '',
  HARNESS_DESKTOP_SIGNING: signing ? 'signed' : 'unsigned',
  HARNESS_RELEASE_CHANNEL: channel,
  HARNESS_PACK_CHANNEL: channel,
  HARNESS_PACK_CATALOG_URL: `${feed}/catalog.json`,
  HARNESS_CORE_UPDATE_URL: signing ? feed : '',
};
const temp = process.env.RUNNER_TEMP;
if (!temp) throw Error('RUNNER_TEMP is required.');
for (const [key, filename] of [
  ['HARNESS_PACK_PUBLIC_KEYS_JSON_B64', 'pack-public-keys.json'],
  ['HARNESS_PACK_SIGNING_KEY_PEM_B64', 'pack-signing-key.pem'],
]) {
  if (!process.env[key]) continue;
  const file = path.join(temp, filename);
  fs.writeFileSync(file, Buffer.from(process.env[key], 'base64'), { mode: 0o600 });
  environment[
    key === 'HARNESS_PACK_PUBLIC_KEYS_JSON_B64'
      ? 'HARNESS_PACK_PUBLIC_KEYS_FILE'
      : 'HARNESS_PACK_SIGNING_KEY_FILE'
  ] = file;
}
if (process.env.APPLE_API_KEY_P8_B64) {
  const file = path.join(temp, 'apple-api-key.p8');
  fs.writeFileSync(file, Buffer.from(process.env.APPLE_API_KEY_P8_B64, 'base64'), { mode: 0o600 });
  environment.APPLE_API_KEY = file;
}
if (!environment.HARNESS_PACK_PUBLIC_KEYS_FILE) throw Error('Pack public keys are required.');
const keys = JSON.parse(fs.readFileSync(environment.HARNESS_PACK_PUBLIC_KEYS_FILE, 'utf8'));
if (!Object.keys(keys).length) throw Error('Pack public keys are empty.');
if (environment.HARNESS_PACK_SIGNING_KEY_FILE) {
  const id = process.env.HARNESS_PACK_SIGNING_KEY_ID;
  if (!id || !keys[id]) throw Error('Pack signing key ID must have a matching public key.');
  const { signCatalog, verifyCatalog } = require('../packages/pack-manager/src/index.cjs');
  verifyCatalog(
    signCatalog(
      { schemaVersion: 1, channel, packs: [] },
      id,
      fs.readFileSync(environment.HARNESS_PACK_SIGNING_KEY_FILE),
    ),
    keys,
  );
  environment.HARNESS_PACK_SIGNING_KEY_ID = id;
}
fs.appendFileSync(
  process.env.GITHUB_ENV,
  Object.entries(environment)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
);
process.stdout.write(`Desktop ${version} ${channel} release environment prepared.\n`);
