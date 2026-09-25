const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCase} = require('./evaluate-27b-context.cjs');

test('long-context fixture has one exact target at each requested position', () => {
  for (const position of ['start', 'middle', 'end']) {
    const result = buildCase(8000, position);
    assert.equal((result.content.match(/artifact_id=critical-/g) || []).length, 1);
    const ratio = result.targetIndex / result.recordCount;
    assert.ok(Math.abs(ratio - {start: 0.05, middle: 0.5, end: 0.95}[position]) < 0.02);
    assert.match(result.expected, /^[a-f0-9]{64} not_run$/);
  }
});
