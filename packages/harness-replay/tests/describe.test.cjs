'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { describeBundle } = require('../src/describe.cjs');
const { loadBundle } = require('../../harness-recording/src/loader.cjs');
const { exportDemoBundle } = require('../../harness-recording/src/demo-export.cjs');
const fs = require('node:fs');
const os = require('node:os');

const FIXTURES = path.join(__dirname, '..', '..', 'harness-recording', 'fixtures');

test('a complete original bundle describes itself for the replay UI', () => {
  const description = describeBundle(loadBundle(path.join(FIXTURES, 'success-demo')));
  assert.equal(description.kind, 'recording-replay');
  assert.equal(description.status, 'complete');
  assert.equal(description.outcome, 'success');
  assert.equal(description.isDemo, false);
  assert.equal(description.gaps.incomplete, false);
  assert.deepEqual(description.gaps.missingAssets, []);
  assert.equal(description.events, 6);
});

test('an interrupted bundle surfaces its gaps explicitly', () => {
  const description = describeBundle(loadBundle(path.join(FIXTURES, 'interrupted-demo')));
  assert.equal(description.status, 'incomplete');
  assert.equal(description.gaps.incompleteReason, 'app-shutdown');
  assert.equal(description.interruptedUnmarked, true);
  assert.ok(description.gaps.warnings.some(warning => warning.includes('truncated')));
});

test('a demo bundle identifies itself with its review status', () => {
  const demo = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-describe-'));
  exportDemoBundle(path.join(FIXTURES, 'success-demo'), path.join(demo, 'bundle'), {});
  const description = describeBundle(loadBundle(path.join(demo, 'bundle')));
  assert.equal(description.isDemo, true);
  assert.equal(description.reviewStatus, 'unreviewed');
});
