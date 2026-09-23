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
