const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWorktreeList,
  isLockName,
  isEvidenceDirName,
  plan,
} = require('../../scripts/qa-cleanup.cjs');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-10T12:00:00Z');
const retention = { builds: 7, evidence: 14, worktree: 7, lockTtlHours: 6 };

function harness(overrides = {}) {
  const ignored = new Set(overrides.ignored || ['/w/dist/stage']);
  const active = new Set(overrides.active || []);
  const ages = overrides.ages || {}; // path -> days since last modification
  const newestOf = p => now - (ages[p] ?? 0) * DAY;
  return plan({
    builds: overrides.builds || [],
    evidences: overrides.evidences || [],
    locks: overrides.locks || [],
    worktrees: overrides.worktrees || [],
    now,
    retention,
    isIgnored: p => ignored.has(p),
    isActive: p => active.has(p),
    dirtyWorktrees: new Set(overrides.dirty || []),
    newestOf,
  });
}

test('selects aged, ignored build outputs and keeps recent or tracked ones', () => {
  const { selected, skipped } = harness({
    builds: [
      { path: '/w/dist/stage', kind: 'build-output' },
      { path: '/w/dist/fresh', kind: 'build-output' },
      { path: '/w/dist/tracked-thing', kind: 'build-output' },
    ],
    ignored: ['/w/dist/stage', '/w/dist/fresh'],
    ages: { '/w/dist/stage': 9, '/w/dist/fresh': 2, '/w/dist/tracked-thing': 30 },
  });
  assert.deepEqual(
    selected.map(item => item.path),
    ['/w/dist/stage'],
  );
  const reasons = Object.fromEntries(skipped.map(item => [item.path, item.reason]));
  assert.equal(reasons['/w/dist/fresh'], 'modified within retention');
  assert.equal(reasons['/w/dist/tracked-thing'], 'not ignored');
});

test('evidence directories rotate on their own longer retention window', () => {
  const { selected, skipped } = harness({
    evidences: [
      { path: '/w/dist/ci-reports/old-run', kind: 'evidence' },
      { path: '/w/dist/ci-reports/week-old', kind: 'evidence' },
    ],
    ages: { '/w/dist/ci-reports/old-run': 20, '/w/dist/ci-reports/week-old': 8 },
  });
  assert.deepEqual(
    selected.map(item => item.path),
    ['/w/dist/ci-reports/old-run'],
  );
  assert.equal(skipped[0].reason, 'modified within retention');
});

test('suite locks are reclaimed only after the ttl', () => {
  const ttl = 6 * 60 * 60 * 1000;
  const { selected, skipped } = harness({
    locks: [
      { path: '/w/dist/ci-reports/.lock.portable', kind: 'suite-lock', mtime: now - 2 * ttl },
      { path: '/w/dist/ci-reports/.lock.native', kind: 'suite-lock', mtime: now - ttl / 2 },
    ],
  });
  assert.deepEqual(
    selected.map(item => item.path),
    ['/w/dist/ci-reports/.lock.portable'],
  );
  assert.equal(skipped[0].reason, 'lock younger than ttl');
});

test('tmp worktrees need to be clean, inactive and idle', () => {
  const { selected, skipped } = harness({
    worktrees: [
      { path: '/tmp/qa-pr90', kind: 'tmp-worktree' },
      { path: '/tmp/qa-dirty', kind: 'tmp-worktree' },
      { path: '/tmp/qa-busy', kind: 'tmp-worktree' },
      { path: '/tmp/qa-fresh', kind: 'tmp-worktree' },
    ],
    dirty: ['/tmp/qa-dirty'],
    active: ['/tmp/qa-busy'],
    ages: { '/tmp/qa-pr90': 9, '/tmp/qa-dirty': 30, '/tmp/qa-busy': 30, '/tmp/qa-fresh': 1 },
  });
  assert.deepEqual(
    selected.map(item => item.path),
    ['/tmp/qa-pr90'],
  );
  const reasons = Object.fromEntries(skipped.map(item => [item.path, item.reason]));
  assert.equal(reasons['/tmp/qa-dirty'], 'uncommitted changes');
  assert.equal(reasons['/tmp/qa-busy'], 'in use by a running process');
  assert.equal(reasons['/tmp/qa-fresh'], 'modified within retention');
});

test('worktree porcelain parsing keeps only detached paths of interest', () => {
  const entries = parseWorktreeList(
    ['worktree /repo/main', 'branch refs/heads/main', 'worktree /tmp/qa-pr90', 'detached', ''].join(
      '\n',
    ),
  );
  assert.deepEqual(
    entries.map(entry => entry.path),
    ['/repo/main', '/tmp/qa-pr90'],
  );
  assert.equal(entries[0].branch, 'refs/heads/main');
});

test('name classifiers separate locks, cleanup logs and evidence directories', () => {
  assert.equal(isLockName('.lock.portable'), true);
  assert.equal(isLockName('20261009T123108Z-72e0954'), false);
  assert.equal(isEvidenceDirName('.lock.portable'), false);
  assert.equal(isEvidenceDirName('qa-cleanup-2026-10-10.json'), false);
  assert.equal(isEvidenceDirName('20261009T123108Z-72e0954'), true);
});
