const fs = require('node:fs');
const path = require('node:path');

const defaults = Object.freeze({provider: 'kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-thinking-turbo', contextSize: 262144, thinking: true});

function validateProfile(value) {
  if (!value || !['kimi', 'openai_legacy'].includes(value.provider)) throw Error('Choose Kimi API or OpenAI-compatible API.');
  const endpoint = new URL(String(value.endpoint));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('API endpoint cannot include credentials, query, or fragment.');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw Error('API endpoint must use HTTPS, except on localhost.');
  const model = String(value.model || '').trim();
  if (!model || model.length > 128 || /[\r\n]/.test(model)) throw Error('Enter a valid model name.');
  const contextSize = Number(value.contextSize);
  if (!Number.isInteger(contextSize) || contextSize < 8192 || contextSize > 2000000) throw Error('Context size must be between 8192 and 2000000.');
  return {provider: value.provider, endpoint: endpoint.toString().replace(/\/$/, ''), model, contextSize, thinking: Boolean(value.thinking)};
}

function configToml(profile) {
  const value = validateProfile(profile);
  const quote = JSON.stringify;
  return `default_model = "industrial"\ndefault_thinking = ${value.thinking}\ndefault_yolo = false\nshow_thinking_stream = true\ntelemetry = false\n\n[providers.industrial]\ntype = ${quote(value.provider)}\nbase_url = ${quote(value.endpoint)}\napi_key = "provided-by-harness-session"\n\n[models.industrial]\nprovider = "industrial"\nmodel = ${quote(value.model)}\nmax_context_size = ${value.contextSize}\ncapabilities = ${value.thinking ? '["thinking"]' : '[]'}\n`;
}

function sessionEnv(profile, apiKey) {
  const value = validateProfile(profile);
  if (!apiKey) throw Error('Configure an API key in Settings.');
  return value.provider === 'kimi'
    ? {KIMI_BASE_URL: value.endpoint, KIMI_API_KEY: apiKey, KIMI_MODEL_NAME: value.model, KIMI_CLI_NO_AUTO_UPDATE: '1'}
    : {OPENAI_BASE_URL: value.endpoint, OPENAI_API_KEY: apiKey, KIMI_CLI_NO_AUTO_UPDATE: '1'};
}

function saveProfile(directory, profile) {
  const value = validateProfile(profile);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, 'model-profile.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2), {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return value;
}

function readProfile(directory) {
  try {return validateProfile(JSON.parse(fs.readFileSync(path.join(directory, 'model-profile.json'), 'utf8')));}
  catch {return {...defaults};}
}

function writeCliConfig(directory, profile) {
  const shareDir = path.join(directory, 'kimi-share');
  fs.mkdirSync(shareDir, {recursive: true, mode: 0o700});
  const file = path.join(shareDir, 'config.toml');
  fs.writeFileSync(file, configToml(profile), {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return shareDir;
}

module.exports = {defaults, validateProfile, configToml, sessionEnv, saveProfile, readProfile, writeCliConfig};
