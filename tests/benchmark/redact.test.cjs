const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamRedactor, environmentSecrets } = require('../../scripts/lib/benchmark-redact.cjs');

test('stream redaction handles every byte split, Unicode, repeated and overlapping credential values', () => {
  const secret = '密钥.a+b[$](private)';
  const input = Buffer.from('😀prefix ' + secret + ' mid ' + secret + ' suffix 中文');
  const expected = '😀prefix [REDACTED] mid [REDACTED] suffix 中文';
  for (let split = 0; split <= input.length; split++) {
    const redactor = new StreamRedactor([secret, 'private']);
    const value =
      redactor.write(input.subarray(0, split)) +
      redactor.write(input.subarray(split)) +
      redactor.end();
    assert.equal(value, expected, `split ${split}`);
  }
  const redactor = new StreamRedactor([secret]);
  let actual = '';
  for (const byte of input) actual += redactor.write(Buffer.from([byte]));
  actual += redactor.end();
  assert.equal(actual, expected);
});

test('token limits are configuration, while API keys and auth tokens are redacted', () => {
  assert.deepEqual(
    environmentSecrets({
      KIMI_MODEL_MAX_COMPLETION_TOKENS: '65536',
      OPENAI_API_KEY: 'private-key',
      ACCESS_TOKEN: 'private-token',
    }),
    ['private-key', 'private-token'],
  );
});
