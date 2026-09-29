const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {defaults, validateProfile, configToml, sessionEnv, saveProfile, readProfile, writeCliConfig} = require('./model-config.cjs');

test('model config keeps the key out of files and passes it only to the session', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-model-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  saveProfile(dir, defaults);
  const shareDir = writeCliConfig(dir, defaults);
  assert.deepEqual(readProfile(dir), defaults);
  assert.match(fs.readFileSync(path.join(shareDir, 'config.toml'), 'utf8'), /default_model = "industrial"/);
  assert.ok(!fs.readFileSync(path.join(shareDir, 'config.toml'), 'utf8').includes('secret-token'));
  assert.equal(sessionEnv(defaults, 'secret-token').KIMI_API_KEY, 'secret-token');
  assert.ok(!JSON.stringify(readProfile(dir)).includes('secret-token'));
  assert.match(configToml(defaults), /capabilities = \["thinking"\]/);
});

test('endpoint validation rejects remote plaintext and embedded credentials', () => {
  assert.throws(() => validateProfile({...defaults, endpoint: 'http://example.com/v1'}), /HTTPS/);
  assert.throws(() => validateProfile({...defaults, endpoint: 'https://key@example.com/v1'}), /credentials/);
  assert.equal(validateProfile({...defaults, endpoint: 'http://127.0.0.1:8000/v1'}).endpoint, 'http://127.0.0.1:8000/v1');
});

test('model image capability is conservative in Auto and explicitly overridable', () => {
  const m3 = {provider: 'openai_legacy', endpoint: 'https://api.minimaxi.com/v1', model: 'Minimax-M3', contextSize: 1000000, thinking: true};
  assert.equal(validateProfile(m3).imageInput, true, 'legacy official M3 profile acquires known capability');
  assert.match(configToml(m3), /"thinking","image_in"/);
  assert.equal(validateProfile({...m3, model: 'MiniMax-M2.7'}).imageInput, false);
  assert.equal(validateProfile({...m3, endpoint: 'https://custom.example/v1'}).imageInput, false);
  assert.equal(validateProfile({...m3, imageInputMode: 'disabled'}).imageInput, false);
  assert.equal(validateProfile({...defaults, model: 'custom-vision', imageInputMode: 'enabled'}).imageInput, true);
  assert.throws(() => validateProfile({...m3, imageInputMode: 'unknown'}), /Choose Auto/);
  assert.throws(() => validateProfile({...m3, imageInput: 'true'}), /enabled or disabled/);
  assert.doesNotMatch(configToml({...m3, imageInputMode: 'disabled'}), /image_in/);
});

test('HARNESS_TRUSTED_PLAINTEXT_HOSTS allows explicit self-hosted plaintext endpoints', t => {
  const previous = process.env.HARNESS_TRUSTED_PLAINTEXT_HOSTS;
  t.after(() => {if (previous === undefined) delete process.env.HARNESS_TRUSTED_PLAINTEXT_HOSTS; else process.env.HARNESS_TRUSTED_PLAINTEXT_HOSTS = previous;});
  process.env.HARNESS_TRUSTED_PLAINTEXT_HOSTS = '192.168.1.50, gpu.local:48000';
  assert.equal(validateProfile({...defaults, endpoint: 'http://192.168.1.50:48000/v1'}).endpoint, 'http://192.168.1.50:48000/v1');
  assert.equal(validateProfile({...defaults, endpoint: 'http://gpu.local:48000/v1'}).endpoint, 'http://gpu.local:48000/v1');
  assert.throws(() => validateProfile({...defaults, endpoint: 'http://gpu.local:9999/v1'}), /HTTPS/);
  assert.throws(() => validateProfile({...defaults, endpoint: 'http://example.com/v1'}), /HTTPS/);
});
