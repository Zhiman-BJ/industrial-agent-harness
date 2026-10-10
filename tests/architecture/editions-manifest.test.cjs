const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspect,
  validateSchema,
  resolveEntry,
  resolveImport,
} = require('../../scripts/check-editions-manifest.cjs');

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'architecture/editions.json'), 'utf8'));

function write(tree, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(tree))
    (fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }),
      fs.writeFileSync(path.join(directory, file), content));
}

function fixtureManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    manifestId: 'TEST-EDITIONS',
    recordedAt: '2026-10-10',
    basisSourceRef: '0'.repeat(40),
    policyRevision: 'IH-ARCH-001',
    release: {
      externalRepoName: '',
      externalRepoUrl: '',
      externalDefaultBranch: '',
      license: 'pending',
    },
    entries: [
      {
        id: 'demo.meta',
        edition: 'public',
        kind: 'meta',
        paths: ['README.md'],
        dependencyClass: 'meta',
        publicStatementSource: 'README.md#Demo',
        decisionStatus: 'decided',
      },
      {
        id: 'demo.public',
        edition: 'public',
        kind: 'package',
        paths: ['packages/demo'],
        dependencyClass: 'core-runtime',
        publicStatementSource: 'README.md#Demo',
        requiredTests: ['packages/demo/tests/demo.test.cjs'],
        decisionStatus: 'decided',
      },
      {
        id: 'demo.internal',
        edition: 'internal',
        kind: 'feature',
        paths: ['packages/demo/src/secret.cjs'],
        dependencyClass: 'diagnostics-internal',
        decisionStatus: 'decided',
        isolation: { status: 'planned', legacyReferences: 1, trackingIssue: 102 },
      },
    ],
    ...overrides,
  };
}

const fixtureTree = {
  'README.md': '# Demo\n\n## Demo heading\n',
  'packages/demo/src/index.cjs':
    "const { secret } = require('./secret.cjs');\nmodule.exports = { secret };\n",
  'packages/demo/src/secret.cjs': 'module.exports = { secret: true };\n',
  'packages/demo/tests/demo.test.cjs':
    "const assert = require('node:assert/strict');\nassert.ok(true);\n",
};

function withFixture(tree, manifestOverrides, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'editions-fixture-'));
  try {
    write(tree, directory);
    return run(directory, fixtureManifest(manifestOverrides));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('real repository: every module and resource is classified and the dev gate passes', () => {
  const report = inspect(root, manifest, { gate: 'dev' });
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
});

test('real repository: the release gate blocks on undecided external name, license and pending isolation', () => {
  const report = inspect(root, manifest, { gate: 'release' });
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(failure => failure.includes('externalRepoName')),
    report.failures.join('\n'),
  );
  assert.ok(
    report.failures.some(failure => failure.includes('license')),
    report.failures.join('\n'),
  );
  assert.ok(
    report.failures.some(failure => failure.includes('#102 isolation incomplete')),
    report.failures.join('\n'),
  );
});

test('a new unclassified repository path fails validation', () => {
  const report = withFixture(
    { ...fixtureTree, 'packages/newcomer/src/index.cjs': '' },
    {},
    directory => inspect(directory, fixtureManifest(), { gate: 'dev' }),
  );
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(failure =>
      failure.includes('Unclassified repository path: packages/newcomer'),
    ),
  );
});

test('longest declared path wins, so an internal file overrides its public package prefix', () => {
  assert.equal(
    resolveEntry(manifest, 'apps/desktop/src/components/AgentFlow.tsx').id,
    'apps.desktop',
  );
  assert.equal(
    resolveEntry(manifest, 'apps/desktop/src/components/AgentLogPanel.tsx').id,
    'internal.diagnostics.desktop-panel',
  );
});

test('relative and workspace-package imports resolve to repository paths', () => {
  assert.equal(
    resolveImport(root, 'packages/agent-kimi/src/index.cjs', './diagnostic-log.cjs'),
    'packages/agent-kimi/src/diagnostic-log.cjs',
  );
  assert.equal(
    resolveImport(
      root,
      'apps/desktop/electron/main.cjs',
      '@industrial-agent-harness/agent-kimi/src/diagnostic-reader.cjs',
    ),
    'packages/agent-kimi/src/diagnostic-reader.cjs',
  );
  assert.equal(
    resolveImport(root, 'apps/desktop/src/App.tsx', './components/AgentLogPanel'),
    'apps/desktop/src/components/AgentLogPanel.tsx',
  );
  assert.equal(resolveImport(root, 'apps/desktop/src/App.tsx', 'react'), null);
});

test('planned-internal reference budget may shrink but never grow', () => {
  const legacy = withFixture(fixtureTree, {}, directory =>
    inspect(directory, fixtureManifest(), { gate: 'dev' }),
  );
  assert.equal(legacy.ok, true, legacy.failures.join('\n'));
  const grown = withFixture(
    { ...fixtureTree, 'packages/demo/src/extra.cjs': "require('../src/secret.cjs');\n" },
    {},
    directory => inspect(directory, fixtureManifest(), { gate: 'dev' }),
  );
  assert.equal(grown.ok, false);
  assert.ok(grown.failures.some(failure => failure.includes('legacy reference budget exceeded')));
});

test('enforced-internal entries reject any public import', () => {
  const report = withFixture(fixtureTree, {}, directory => {
    const enforced = fixtureManifest();
    enforced.entries.find(entry => entry.id === 'demo.internal').isolation = {
      status: 'enforced',
      legacyReferences: 0,
    };
    return inspect(directory, enforced, { gate: 'dev' });
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some(failure => failure.includes('enforced-internal')));
});

test('a configured and fully isolated manifest passes the release gate', () => {
  const tree = { ...fixtureTree };
  delete tree['packages/demo/src/index.cjs'];
  tree['packages/demo/src/index.cjs'] = 'module.exports = {};\n';
  const report = withFixture(tree, {}, directory => {
    const decided = fixtureManifest({
      release: {
        externalRepoName: 'harness-oss',
        externalRepoUrl: 'https://github.com/example/harness-oss',
        externalDefaultBranch: 'main',
        license: 'MIT',
      },
    });
    decided.entries.find(entry => entry.id === 'demo.internal').isolation = {
      status: 'enforced',
      legacyReferences: 0,
    };
    return inspect(directory, decided, { gate: 'release' });
  });
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
});

test('schema validation rejects structural mistakes', () => {
  const failures = validateSchema({
    schemaVersion: 2,
    entries: [
      { id: 'x', edition: 'secret', paths: ['../escape'], decisionStatus: 'maybe' },
      { id: 'x', edition: 'public', paths: ['a'], decisionStatus: 'decided' },
    ],
  });
  assert.ok(failures.some(failure => failure.includes('schemaVersion')));
  assert.ok(failures.some(failure => failure.includes('edition must be public or internal')));
  assert.ok(failures.some(failure => failure.includes('unsafe path')));
  assert.ok(failures.some(failure => failure.includes('decisionStatus')));
  assert.ok(failures.some(failure => failure.includes('Duplicate entry id')));
  assert.ok(failures.some(failure => failure.includes('require publicStatementSource')));
});

test('public entries must cite an existing public statement with its anchor', () => {
  const report = withFixture(fixtureTree, {}, directory => {
    const cited = fixtureManifest();
    cited.entries[0].publicStatementSource = 'README.md#Missing heading';
    return inspect(directory, cited, { gate: 'dev' });
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some(failure => failure.includes('anchor not found')));
});

test('required tests must exist for every entry that declares them', () => {
  const report = withFixture(fixtureTree, {}, directory => {
    const declared = fixtureManifest();
    declared.entries[0].requiredTests = ['packages/demo/tests/absent.test.cjs'];
    return inspect(directory, declared, { gate: 'dev' });
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some(failure => failure.includes('required test missing')));
});
