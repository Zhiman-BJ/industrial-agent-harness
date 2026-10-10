const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  fetchCandidate,
  materializeTree,
  entriesFromTree,
  git,
  limits,
} = require('../../scripts/fetch-architecture-candidate.cjs');
const { inspect, hash } = require('../../scripts/check-architecture-contract.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-fetch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'source');
  fs.mkdirSync(repository);
  const run = (...args) => execFileSync('git', args, { cwd: repository });
  run('init', '--quiet', '--template=');
  const write = (file, text) => {
    const target = path.join(repository, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const commit = () => {
    run('add', '.');
    run(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    return run('rev-parse', 'HEAD').toString().trim();
  };
  const destination = path.join(root, 'candidate');
  return { root, repository, write, commit, destination, run };
}

test('fork and same-repository PRs fetch only the canonical PR ref and verify exact SHA', t => {
  for (const headRepository of ['contributor/fork', 'owner/base']) {
    const f = fixture(t);
    f.write('package.json', '{}');
    f.write('.gitattributes', 'hidden.cjs export-ignore\nraw.txt export-subst\n');
    f.write('hidden.cjs', 'forbidden source is still inspected');
    f.write('raw.txt', '$Format:%H$');
    const sha = f.commit();
    const calls = [];
    const runGit = (args, directory, max) => {
      calls.push(args);
      if (args[0] === 'init' || args[0] === 'fetch') return Buffer.alloc(0);
      if (args[0] === 'rev-parse') return Buffer.from(sha);
      return git(args, path.join(f.repository, '.git'), max);
    };
    const report = fetchCandidate(
      {
        repository: 'owner/base',
        number: 84,
        sha,
        destination: f.destination,
        temp: f.root,
        headRepository,
      },
      runGit,
    );
    assert.equal(report.sha, sha);
    assert.equal(
      fs.readFileSync(path.join(f.destination, 'hidden.cjs'), 'utf8'),
      'forbidden source is still inspected',
    );
    assert.equal(fs.readFileSync(path.join(f.destination, 'raw.txt'), 'utf8'), '$Format:%H$');
    assert.deepEqual(
      calls.find(args => args[0] === 'fetch'),
      [
        'fetch',
        '--no-tags',
        '--depth=1',
        '--recurse-submodules=no',
        'https://github.com/owner/base.git',
        'refs/pull/84/head',
      ],
    );
    assert.ok(!fs.existsSync(path.join(f.destination, '.git')));
    assert.ok(!fs.readdirSync(f.root).some(name => name.startsWith('architecture-git-')));
  }
});

test('fetch failure, stale head, malformed identity and existing destination fail closed', t => {
  const f = fixture(t);
  f.write('package.json', '{}');
  const sha = f.commit();
  const input = {
    repository: 'owner/base',
    number: 1,
    sha,
    destination: f.destination,
    temp: f.root,
  };
  assert.throws(
    () =>
      fetchCandidate(input, args => {
        if (args[0] === 'fetch') throw Error('fetch failed');
        return Buffer.alloc(0);
      }),
    /fetch failed/,
  );
  assert.throws(
    () =>
      fetchCandidate(input, args =>
        args[0] === 'rev-parse' ? Buffer.from('b'.repeat(40)) : Buffer.alloc(0),
      ),
    /SHA mismatched/,
  );
  assert.ok(!fs.existsSync(f.destination));
  for (const item of [
    { repository: '-evil/repo' },
    { repository: 'owner/../../bad' },
    { number: '1;echo bad' },
    { sha: 'main' },
  ]) {
    assert.throws(() => fetchCandidate({ ...input, ...item }), /Invalid/);
  }
  fs.symlinkSync(f.repository, f.destination, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => materializeTree(path.join(f.repository, '.git'), sha, f.destination),
    /EEXIST/,
  );
  assert.equal(fs.readFileSync(path.join(f.repository, 'package.json'), 'utf8'), '{}');
});

test('raw Git paths, symlinks, gitlinks, duplicates and resource limits are rejected', () => {
  const oid = 'a'.repeat(40);
  const record = (file, mode = '100644', type = 'blob') => `${mode} ${type} ${oid}\t${file}\0`;
  for (const file of [
    '../escape',
    '/absolute',
    'a/../../b',
    '.git/config',
    'a/.GiT/config',
    'a\\b',
    'a//b',
    'a/./b',
    'a\nb',
    'a:b',
  ]) {
    assert.throws(() => entriesFromTree(Buffer.from(record(file))));
  }
  for (const [mode, type] of [
    ['120000', 'blob'],
    ['160000', 'commit'],
    ['040000', 'tree'],
  ]) {
    assert.throws(() => entriesFromTree(Buffer.from(record('link', mode, type))), /regular blobs/);
  }
  assert.throws(() => entriesFromTree(Buffer.from(record('a') + record('A'))), /Duplicate/);
  assert.throws(() => entriesFromTree(Buffer.from(record('a').slice(0, -1))), /Truncated/);
  assert.throws(() =>
    entriesFromTree(Buffer.concat([Buffer.from(record('a').slice(0, -1)), Buffer.from([0xff, 0])])),
  );
  assert.throws(
    () => entriesFromTree(Buffer.from(record('a') + record('b')), { ...limits, files: 1 }),
    /count limit/,
  );
});

test('failed materialization removes partial data and never overwrites a trusted sibling', t => {
  const f = fixture(t);
  f.write('a', 'a');
  f.write('b', 'large blob');
  const sha = f.commit();
  assert.throws(
    () =>
      materializeTree(path.join(f.repository, '.git'), sha, f.destination, git, {
        ...limits,
        blob: 2,
      }),
    /size limit/,
  );
  assert.ok(!fs.existsSync(f.destination));
  assert.throws(
    () =>
      materializeTree(path.join(f.repository, '.git'), sha, f.destination, git, {
        ...limits,
        total: 3,
      }),
    /size limit/,
  );
  assert.ok(!fs.existsSync(f.destination));
});

test('actual Git symlink and submodule entries are rejected without materialization', t => {
  for (const mode of ['120000', '160000']) {
    const f = fixture(t);
    f.write('payload', '../trusted');
    const sha = f.commit();
    const oid = mode === '160000' ? sha : f.run('rev-parse', 'HEAD:payload').toString().trim();
    f.run('update-index', '--add', '--cacheinfo', `${mode},${oid},linked`);
    const tree = f.run('write-tree').toString().trim();
    assert.throws(
      () => materializeTree(path.join(f.repository, '.git'), tree, f.destination),
      /regular blobs/,
    );
    assert.ok(!fs.existsSync(f.destination));
  }
});

test('Git subprocesses ignore inherited config and object-directory overrides', t => {
  const f = fixture(t);
  f.write('payload', 'raw');
  const sha = f.commit();
  const injected = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'test.candidate',
    GIT_CONFIG_VALUE_0: 'injected',
    GIT_DIR: path.join(f.root, 'missing'),
    GIT_OBJECT_DIRECTORY: path.join(f.root, 'missing-objects'),
  };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, injected);
  assert.equal(git(['rev-parse', 'HEAD'], path.join(f.repository, '.git')).toString().trim(), sha);
  assert.throws(() => git(['config', '--get', 'test.candidate'], path.join(f.repository, '.git')));
});

test('candidate scripts, checker, policy, attributes and Git hooks cannot authorize or execute a violation', t => {
  const f = fixture(t);
  const sentinel = path.join(f.root, 'executed');
  const payload = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');`;
  const trusted = {
    revision: 'IH-ARCH-001',
    role: 'harness',
    canonical: 'test',
    frozen: {},
    frozenPrefixes: [],
    domainAtoms: {},
    adapterCalls: {},
    governanceHashes: { 'scripts/check-architecture-contract.cjs': hash('trusted bytes') },
  };
  f.write(
    'package.json',
    JSON.stringify({ scripts: { postinstall: `node -e ${JSON.stringify(payload)}` } }),
  );
  f.write('scripts/check-architecture-contract.cjs', payload);
  f.write('tests/architecture/candidate-fetch.test.cjs', payload);
  f.write(
    'architecture/policy.json',
    JSON.stringify({
      ...trusted,
      governanceHashes: {},
      domainAtoms: { 'packages/harness-core/src/hidden.cjs#cad': 1 },
    }),
  );
  f.write('packages/harness-core/src/hidden.cjs', "const forbidden = 'cad';");
  f.write('.gitattributes', 'packages/harness-core/src/hidden.cjs export-ignore\n');
  f.write('.git/hooks/post-checkout', `#!/bin/sh\ntouch '${sentinel}'\n`);
  const sha = f.commit();
  materializeTree(path.join(f.repository, '.git'), sha, f.destination);
  const report = inspect(
    f.destination,
    JSON.parse(fs.readFileSync(path.join(f.destination, 'architecture/policy.json'))),
    trusted,
  );
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(message => message.includes('Protected architecture machinery changed')),
  );
  assert.ok(report.failures.some(message => message.includes('New domainAtoms')));
  assert.ok(!fs.existsSync(sentinel));
});

test('workflow separates read-only candidate inspection from status publishing and uses only trusted code', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/architecture-contract.yml'),
    'utf8',
  );
  const trusted = source.split('\n  trusted:')[1].split('\n  status:')[0];
  const status = source.split('\n  status:')[1];
  assert.equal((trusted.match(/actions\/checkout@/g) || []).length, 1);
  assert.match(trusted, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(trusted, /persist-credentials: false/);
  assert.doesNotMatch(
    trusted,
    /statuses: write|GH_TOKEN|head.repo|allow-unsafe-pr-checkout|continue-on-error/,
  );
  assert.match(trusted, /node trusted\/scripts\/fetch-architecture-candidate.cjs/);
  assert.match(trusted, /node trusted\/scripts\/check-architecture-contract.cjs/);
  assert.match(status, /needs: trusted/);
  assert.match(status, /if: always\(\) && github.event_name == 'pull_request_target'/);
  assert.match(status, /RESULT: \$\{\{ needs.trusted.result \}\}/);
  assert.match(status, /HEAD_SHA: \$\{\{ github.event.pull_request.head.sha \}\}/);
  assert.doesNotMatch(status, /checkout|download-artifact|candidate/);
  assert.match(status, /state=failure/);
  assert.match(status, /if \[ "\$RESULT" = success \]/);
});
