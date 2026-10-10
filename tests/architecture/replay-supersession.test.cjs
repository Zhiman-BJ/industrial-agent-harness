// Evidence for the separately approved architecture revision that supersedes
// the absolute trajectory-replay ban in AGENTS.md (PD-070, 2026-10-10, #101).
// This file is internal-only: it asserts the internal governance documents and
// the governance hash ledger in architecture/policy.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const decisions = fs.readFileSync(path.join(root, 'doc/product-decisions.md'), 'utf8');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'architecture/policy.json'), 'utf8'));

test('the superseding decision PD-070 is recorded and names the clause it replaces', () => {
  const section = decisions.slice(decisions.indexOf('## PD-070'));
  assert.ok(section.length > 0, 'PD-070 section exists');
  assert.ok(
    section.includes('Do not reintroduce trajectory replay into the MVP'),
    'quotes the superseded clause',
  );
  assert.ok(section.includes('内部 edition'), 'limits replay to the internal edition');
  assert.ok(
    section.includes('不替代 Core Vertical Slice'),
    'keeps the Core Vertical Slice boundary',
  );
});

test('AGENTS.md carries the qualified replay rule instead of the absolute ban', () => {
  assert.doesNotMatch(agents, /Do not reintroduce trajectory replay/);
  assert.match(agents, /PD-070/);
  assert.match(
    agents,
    /never substitutes for real execution, engineering verification, or the Core Vertical Slice/,
  );
});

test('the governance hash ledger matches the revised AGENTS.md bytes', () => {
  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'AGENTS.md')))
    .digest('hex');
  assert.equal(policy.governanceHashes['AGENTS.md'], digest);
});
