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
  if ((remoteOrigin || modelBaseUrl) && !audience)
    throw Error('Configure the platform application audience before connecting a service.');
  const result = { issuer, clientId, audience, remoteOrigin, modelBaseUrl };
  if (value.resource) result.resource = trustedUrl(value.resource);
  // Registered public identifiers are not credentials. Keep the two grants
  // below the existing account UI, and preserve custom single-app deployments.
  const profiles =
    value.services ||
    (issuer === 'https://auth.zhiman.cn' &&
    clientId === 'harness-desktop-1' &&
    audience === 'harness-desktop'
      ? {
          model: { clientId, audience: 'obol-api', resource: 'https://api.zhiman.cn' },
          remote: { clientId: 'industrial-agent-harness', audience: 'industrial-mcp-remote' },
        }
      : null);
  if (profiles) {
    if (
      !profiles.model ||
      !profiles.remote ||
      Object.keys(profiles).some(key => !['model', 'remote'].includes(key))
    )
      throw Error('Configure both platform service authorizations.');
    result.services = {};
    for (const service of ['model', 'remote']) {
      const profile = profiles[service];
      for (const id of [profile.clientId, profile.audience])
        if (typeof id !== 'string' || !id || id.length > 128 || /[^a-zA-Z0-9._-]/.test(id))
          throw Error('Invalid platform service identifier.');
      if (profile.clientId === profile.audience)
        throw Error('Client ID must differ from the application audience.');
      result.services[service] = { clientId: profile.clientId, audience: profile.audience };
      if (profile.resource) result.services[service].resource = trustedUrl(profile.resource);
    }
  }
  return result;
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
    modelBaseUrl: 'MODEL_BASE_URL',
  };
  for (const [key, name] of Object.entries(names))
    if (environment['INDUSTRIAL_AUTH_' + name] !== undefined)
      saved[key] = environment['INDUSTRIAL_AUTH_' + name];
  return validateConfig(saved);
}
module.exports = { authDirectory, trustedUrl, validateConfig, readConfig };
