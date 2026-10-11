'use strict';

// Guards the committed synthetic fixtures (#104 acceptance): each sample
// must keep its documented loader behavior, so replay development (#105) can
// rely on them. If this test fails after regenerating fixtures, the generator
// or the loader changed semantics — reconcile before merging.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadBundle, validateBundle, RecordingError } = require('../src/index.cjs');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

test('success-demo loads complete with a present asset', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'success-demo'));
  assert.equal(bundle.manifest.status, 'complete');
  assert.equal(bundle.manifest.outcome, 'success');
  assert.equal(bundle.events.length, 6);
  assert.deepEqual(bundle.missingAssets, []);
  assert.equal(bundle.manifest.assets[0].status, 'present');
  assert.deepEqual(validateBundle(path.join(FIXTURES, 'success-demo')), []);
});

test('tool-failure-demo records the failing tool-result without failing the bundle', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'tool-failure-demo'));
  const toolResult = bundle.events.find(record => record.event.type === 'tool-result');
  assert.equal(toolResult.event.error, true);
  assert.equal(bundle.manifest.status, 'complete');
});

test('cancelled-demo carries a cancelled outcome', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'cancelled-demo'));
  assert.equal(bundle.manifest.outcome, 'cancelled');
  assert.equal(bundle.manifest.status, 'complete');
});

test('interrupted-demo loads as explicit incomplete evidence', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'interrupted-demo'));
  assert.equal(bundle.manifest.status, 'incomplete');
  assert.equal(bundle.manifest.incompleteReason, 'app-shutdown');
  assert.equal(bundle.manifest.interruptedUnmarked, true);
  assert.equal(bundle.events.length, 2);
  assert.ok(bundle.warnings.some(warning => warning.startsWith('events:truncated')));
  // The strict validator still reports the damage — tolerance is a loader
  // policy for interrupted bundles, not a claim the bundle is healthy.
  const codes = validateBundle(path.join(FIXTURES, 'interrupted-demo')).map(error => error.code);
  assert.ok(codes.includes('events:truncated'));
});

test('corrupted-seq is rejected deterministically', () => {
  assert.throws(
    () => loadBundle(path.join(FIXTURES, 'corrupted-seq')),
    error => {
      assert.ok(error instanceof RecordingError);
      assert.equal(error.code, 'events:seq');
      return true;
    },
  );
});

test('unknown-event is rejected by type name', () => {
  assert.throws(
    () => loadBundle(path.join(FIXTURES, 'unknown-event')),
    error => {
      assert.ok(error instanceof RecordingError);
      assert.equal(error.code, 'events:unknown-type');
      return true;
    },
  );
});

test('missing-asset loads with an explicit gap', () => {
  const bundle = loadBundle(path.join(FIXTURES, 'missing-asset'));
  assert.equal(bundle.manifest.status, 'complete');
  assert.deepEqual(bundle.missingAssets, ['lost-image']);
});
