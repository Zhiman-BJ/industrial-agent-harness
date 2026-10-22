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

function validateConfig(value) {
  const issuer = trustedUrl(value.issuer || 'https://auth.zhiman.cn');
  if (new URL(issuer).pathname !== '/') throw Error('Obol issuer must be an origin.');
  const clientId = value.clientId || '';
  const audience = value.audience || '';
  for (const id of [clientId, audience])
    if (typeof id !== 'string' || id.length > 128 || /[^a-zA-Z0-9._-]/.test(id))
      throw Error('Invalid platform application identifier.');
  if (clientId && clientId === audience)
    throw Error('Client ID must differ from the application audience.');
  const remoteOrigin = value.remoteOrigin ? trustedUrl(value.remoteOrigin) : '';
  if (remoteOrigin && new URL(remoteOrigin).pathname !== '/')
    throw Error('Remote service must be an origin.');
  const modelBaseUrl = value.modelBaseUrl ? trustedUrl(value.modelBaseUrl) : '';
  const remoteAudience = value.remoteAudience || 'industrial-mcp-remote';
  if (
    typeof remoteAudience !== 'string' ||
    remoteAudience.length > 128 ||
    /[^a-zA-Z0-9._-]/.test(remoteAudience) ||
    remoteAudience === clientId
  )
    throw Error('Invalid remote service application audience.');
  if ((remoteOrigin || modelBaseUrl) && !audience)
    throw Error('Configure the platform application audience before connecting a service.');
  return { issuer, clientId, audience, remoteOrigin, modelBaseUrl, remoteAudience };
}

function readConfig(directory, environment = process.env, defaults = {}) {
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
  // A configured identity keeps its complete binding, including empty service URLs.
  // Bootstrap only an unconfigured account for the application's default issuer.
  if (
    !saved.clientId &&
    !saved.audience &&
    environment.INDUSTRIAL_AUTH_CLIENT_ID === undefined &&
    environment.INDUSTRIAL_AUTH_AUDIENCE === undefined &&
    (!saved.issuer || saved.issuer === defaults.issuer)
  ) {
    saved = {
      ...defaults,
      ...saved,
      issuer: saved.issuer || defaults.issuer,
      clientId: defaults.clientId,
      audience: defaults.audience,
    };
  }
  return validateConfig(saved);
}
module.exports = { authDirectory, trustedUrl, validateConfig, readConfig };
