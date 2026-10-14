const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function authDirectory(environment = process.env) {
  return path.join(
    environment.INDUSTRIAL_HARNESS_CONFIG_DIR ||
      path.join(os.homedir(), '.industrial-agent-harness'),
    'account',
  );
}

function trustedUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw Error('Use an HTTPS platform URL (loopback HTTP is allowed for local development).');
  return url.href.replace(/\/$/, '');
}

// Obol's model API is its built-in application obol-api: tokens for it are
// requested with the model base URL as RFC 8707 resource.
const MODEL_AUDIENCE = 'obol-api';

// The Zhiman platform, used until a deployment configures another. The native
// client ID is public: native clients have no secret; PKCE and the registered
// loopback redirect protect the sign-in. Zhiman's model API is the default only
// with Zhiman's issuer, so another platform's sign-in never pays for it.
const PLATFORM = Object.freeze({
  issuer: 'https://auth.zhiman.cn',
  clientId: 'harness-desktop-1',
  audience: 'harness-desktop',
  modelBaseUrl: 'https://api.zhiman.cn/v1',
});

function validateConfig(value) {
  const issuer = trustedUrl(value.issuer || PLATFORM.issuer);
  if (new URL(issuer).pathname !== '/') throw Error('Obol issuer must be an origin.');
  const clientId = value.clientId || PLATFORM.clientId;
  const audience = value.audience || (value.clientId ? '' : PLATFORM.audience);
  const remoteAudience = value.remoteAudience || '';
  for (const id of [clientId, audience, remoteAudience])
    if (typeof id !== 'string' || id.length > 128 || /[^a-zA-Z0-9._-]/.test(id))
      throw Error('Invalid platform application identifier.');
  if (clientId && clientId === audience)
    throw Error('Client ID must differ from the application audience.');
  const remoteOrigin = value.remoteOrigin ? trustedUrl(value.remoteOrigin) : '';
  if (remoteOrigin && new URL(remoteOrigin).pathname !== '/')
    throw Error('Remote service must be an origin.');
  const modelBaseUrl = value.modelBaseUrl
    ? trustedUrl(value.modelBaseUrl)
    : issuer === PLATFORM.issuer
      ? PLATFORM.modelBaseUrl
      : '';
  if (remoteOrigin && !remoteAudience)
    throw Error('Configure the remote service application audience before connecting it.');
  if (clientId && clientId === remoteAudience)
    throw Error('Client ID must differ from the remote service audience.');
  return { issuer, clientId, audience, remoteOrigin, remoteAudience, modelBaseUrl };
}

function readConfig(directory, environment = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('Cannot read platform account configuration.');
  }
  const names = {
    issuer: 'ISSUER',
    clientId: 'CLIENT_ID',
    audience: 'AUDIENCE',
    remoteOrigin: 'REMOTE_ORIGIN',
    remoteAudience: 'REMOTE_AUDIENCE',
    modelBaseUrl: 'MODEL_BASE_URL',
  };
  for (const [key, name] of Object.entries(names))
    if (environment['INDUSTRIAL_AUTH_' + name] !== undefined)
      saved[key] = environment['INDUSTRIAL_AUTH_' + name];
  return validateConfig(saved);
}
module.exports = {
  MODEL_AUDIENCE,
  PLATFORM,
  authDirectory,
  trustedUrl,
  validateConfig,
  readConfig,
};
