'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileRules, redactEvent, redactString } = require('../src/redact.cjs');

const rules = compileRules();

test('home paths lose the username but stay readable', () => {
  assert.equal(
    redactString('读取 /Users/roger/Documents/layout.gds 后继续', rules),
    '读取 ~/Documents/layout.gds 后继续',
  );
  assert.equal(redactString('/home/alice/outputs/board.gds', rules), '~/outputs/board.gds');
});

test('credential-carrying URLs are masked before the endpoint rule', () => {
  assert.equal(
    redactString('POST https://ci:pw123@192.168.1.10/api/run', rules),
    'POST https://[REDACTED]@[REDACTED_ENDPOINT]/api/run',
  );
});

test('bearer tokens and common api-key literals are removed', () => {
  assert.equal(
    redactString('Authorization: Bearer abcdef1234567890', rules),
    'Authorization: Bearer [REDACTED]',
  );
  assert.equal(
    redactString('key was sk-AbCdEf1234567890GhIj', rules),
    'key was [REDACTED_API_KEY]',
  );
});

test('private endpoints are masked; public hosts are not', () => {
  assert.equal(
    redactString('connect to 10.0.0.5:8080', rules),
    'connect to [REDACTED_ENDPOINT]:8080',
  );
  assert.equal(
    redactString('fetch https://example.com/doc', rules),
    'fetch https://example.com/doc',
  );
});

test('secret-sounding keys lose their values in structured events', () => {
  const event = {
    type: 'tool',
    id: 't1',
    name: 'http_request',
    arguments: JSON.stringify({
      url: 'https://api.internal/x',
      api_key: 'super-secret-1',
      password: 'hunter2',
    }),
  };
  const redacted = redactEvent(event, rules);
  const parsed = JSON.parse(redacted.arguments);
  assert.equal(parsed.api_key, '[REDACTED]');
  assert.equal(parsed.password, '[REDACTED]');
  // Structural identity survives: replay keys off these.
  assert.equal(redacted.id, 't1');
  assert.equal(redacted.type, 'tool');
});

test('nested structures and arrays are walked, numbers untouched', () => {
  const event = {
    type: 'tool-result',
    id: 't2',
    output: 'paths: [/Users/bob/a.gds, /home/carol/b.gds]',
    nested: { deep: [{ token: 'xyz', note: 'see 127.0.0.1' }], count: 3 },
  };
  const redacted = redactEvent(event, rules);
  assert.equal(redacted.output, 'paths: [~/a.gds, ~/b.gds]');
  assert.equal(redacted.nested.deep[0].token, '[REDACTED]');
  assert.equal(redacted.nested.deep[0].note, 'see [REDACTED_ENDPOINT]');
  assert.equal(redacted.nested.count, 3);
});

test('caller-selected literals are redacted everywhere', () => {
  const custom = compileRules({ literals: ['Acme 供应链', '客户甲'] });
  assert.equal(
    redactEvent({ type: 'text', text: '客户甲的 Acme 供应链 数据已处理' }, custom).text,
    '[REDACTED]的 [REDACTED] 数据已处理',
  );
});

test('ordinary CJK conversation text passes through unchanged', () => {
  const text = '布局检查完成，电源网络全部连通，共 214 个器件。';
  assert.equal(redactEvent({ type: 'text', text }, rules).text, text);
});
