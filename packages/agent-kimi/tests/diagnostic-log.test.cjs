const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createDiagnosticLog} = require('../src/diagnostic-log.cjs');

test('diagnostic log preserves full payloads while redacting known credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-diagnostic-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const log = createDiagnosticLog(root, {directory: path.join(root, 'logs'), apiKey: 'secret-value'});
  log.record('sdk.event', {output: 'a'.repeat(25000), message: 'secret-value', authorization: 'Bearer another-secret'});
  log.close();
  const row = JSON.parse(fs.readFileSync(log.file, 'utf8'));
  assert.equal(row.payload.output.length, 25000);
  assert.equal(row.payload.message, '[REDACTED_API_KEY]');
  assert.equal(row.payload.authorization, '[REDACTED]');
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(log.file)).mode & 0o777, 0o700);
});
