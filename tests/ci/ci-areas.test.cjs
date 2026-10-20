const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { classify, plan, failedJobs } = require('../../scripts/ci-areas.cjs');

const files = (...names) => names.map(filename => ({ filename }));

test('plain documentation keeps the structure-only gating', () => {
  for (const group of [
    ['README.md'],
    ['doc/qa-runbook.md'],
    ['LICENSE'],
    ['architecture/decision.md', 'README.zh-CN.md'],
    ['apps/desktop/DESIGN.md'],
  ]) {
    assert.deepEqual(
      classify(files(...group)),
      { docsOnly: true, sharedChanged: false },
      group.join(', '),
    );
  }
});

test('runtime skill resources are never documentation even though they end in .md', () => {
  for (const group of [
    ['packages/domain-skills/skills/project-work/SKILL.md'],
    ['packages/computer-use-bridge/skills/computer-use/SKILL.md'],
    ['packages/domain-skills/skills/project-work/SKILL.md', 'doc/notes.md'],
  ]) {
    assert.deepEqual(
      classify(files(...group)),
      { docsOnly: false, sharedChanged: true },
      group.join(', '),
    );
  }
});

test('desktop-only and shared code keep their layer gating', () => {
  assert.deepEqual(classify(files('apps/desktop/src/App.tsx')), {
    docsOnly: false,
    sharedChanged: false,
  });
  assert.deepEqual(classify(files('apps/desktop/src/App.tsx', 'README.md')), {
    docsOnly: false,
    sharedChanged: false,
  });
  assert.deepEqual(classify(files('packages/capability-broker/src/index.cjs')), {
    docsOnly: false,
    sharedChanged: true,
  });
});

test('renamed files gate on both the new and the previous path', () => {
  // A source file moved into doc/ must not become documentation.
  assert.deepEqual(
    classify([{ filename: 'doc/edit.md', previous_filename: 'packages/domain-mcp/src/edit.cjs' }]),
    { docsOnly: false, sharedChanged: true },
  );
  // Documentation renamed within documentation stays documentation.
  assert.deepEqual(classify([{ filename: 'doc/new.md', previous_filename: 'doc/old.md' }]), {
    docsOnly: true,
    sharedChanged: false,
  });
  assert.deepEqual(
    classify([
      { filename: 'apps/desktop/src/new.tsx', previous_filename: 'packages/viewer/src/old.tsx' },
    ]),
    { docsOnly: false, sharedChanged: true },
  );
});

test('an empty change set fails safe to the full net and entries are validated', () => {
  assert.deepEqual(classify([]), { docsOnly: false, sharedChanged: true });
  assert.throws(() => classify([{}]));
  assert.throws(() => classify([null]));
  assert.throws(() => classify(['README.md']));
});

test('code PRs retain all core platforms while main and requested full runs qualify installations', () => {
  const pr = { eventName: 'pull_request' };
  for (const names of [
    ['apps/desktop/electron/account.test.cjs'],
    ['packages/harness-core/src/index.cjs'],
    ['packages/domain-skills/skills/project-work/SKILL.md'],
    ['pnpm-lock.yaml'],
    [],
  ])
    assert.deepEqual(plan(files(...names), pr), { core: true, full: false });
  assert.deepEqual(plan(files('README.md'), pr), { core: false, full: false });
  assert.deepEqual(
    plan([{ filename: 'doc/old.md', previous_filename: 'apps/desktop/electron/old.cjs' }], pr),
    { core: true, full: false },
  );
  for (const options of [
    { eventName: 'push' },
    { eventName: 'workflow_dispatch', full: true },
    { eventName: 'pull_request', full: true },
    { eventName: 'unknown' },
  ])
    assert.deepEqual(plan(files('README.md'), options), { core: true, full: true });
  assert.deepEqual(plan([], { eventName: 'workflow_dispatch', full: false }), {
    core: true,
    full: false,
  });
  assert.throws(() => plan([], { eventName: 'workflow_dispatch', full: 'false' }), /boolean/);
});

function jobResults(core, full) {
  return {
    changes: { result: 'success', outputs: { core: String(core), full: String(full) } },
    repository: { result: 'success' },
    portable: { result: core ? 'success' : 'skipped' },
    desktop: { result: core ? 'success' : 'skipped' },
    'industrial-linux': { result: core ? 'success' : 'skipped' },
    industrial: { result: full ? 'success' : 'skipped' },
  };
}

test('CI summary permits only planned omissions and rejects missing, failed or cancelled checks', () => {
  for (const [core, full] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const passing = jobResults(core, full);
    assert.deepEqual(failedJobs(passing), []);
    for (const name of Object.keys(passing)) {
      for (const result of ['failure', 'cancelled'])
        assert.deepEqual(failedJobs({ ...passing, [name]: { ...passing[name], result } }), [name]);
      const missing = { ...passing };
      delete missing[name];
      assert.deepEqual(failedJobs(missing), [name]);
      if (passing[name].result === 'success')
        assert.deepEqual(
          failedJobs({ ...passing, [name]: { ...passing[name], result: 'skipped' } }),
          [name],
        );
    }
  }
  for (const outputs of [{}, { core: 'false', full: 'true' }, { core: true, full: false }])
    assert.deepEqual(
      failedJobs({ ...jobResults(true, false), changes: { result: 'success', outputs } }),
      ['changes'],
    );
});

test('workflow selection handles manual booleans, pagination and file-list errors', async () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const script = workflow.match(/ {10}script: \|\n([\s\S]*?)\n {2}repository:/)[1];
  async function select(eventName, entries, inputs = {}, error) {
    const outputs = {};
    await vm.runInNewContext(`(async () => {${script}})()`, {
      require: createRequire(path.join(root, 'package.json')),
      core: {
        info() {},
        setOutput: (name, value) => {
          outputs[name] = value;
        },
      },
      context: { eventName, payload: { inputs }, repo: {}, issue: { number: 151 } },
      github: {
        rest: {
          pulls: {
            listFiles: async ({ page, per_page }) => {
              if (error) throw error;
              assert.equal(eventName, 'pull_request');
              return { data: entries.slice((page - 1) * per_page, page * per_page) };
            },
          },
        },
      },
    });
    return outputs;
  }
  assert.deepEqual(await select('pull_request', files('README.md')), {
    core: 'false',
    full: 'false',
  });
  assert.deepEqual(await select('pull_request', files('apps/desktop/src/App.tsx')), {
    core: 'true',
    full: 'false',
  });
  const many = Array.from({ length: 100 }, () => ({ filename: 'README.md' }));
  assert.deepEqual(
    await select('pull_request', [...many, ...files('packages/harness-core/src/index.cjs')]),
    { core: 'true', full: 'false' },
  );
  assert.deepEqual(
    await select(
      'pull_request',
      Array.from({ length: 3000 }, () => ({ filename: 'README.md' })),
    ),
    { core: 'true', full: 'true' },
  );
  for (const full of [true, 'true'])
    assert.deepEqual(await select('workflow_dispatch', [], { full }), {
      core: 'true',
      full: 'true',
    });
  for (const full of [false, 'false', undefined])
    assert.deepEqual(await select('workflow_dispatch', [], { full }), {
      core: 'true',
      full: 'false',
    });
  assert.deepEqual(await select('push', []), { core: 'true', full: 'true' });
  await assert.rejects(
    select('pull_request', [], {}, Error('file listing failed')),
    /file listing failed/,
  );
});

test('workflow jobs use the selected core/full plan and reusable workflows keep full acceptance by default', () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = name => workflow.split(`  ${name}:\n`)[1].split(/\n {2}[a-z][\w-]*:/)[0];
  for (const name of ['portable', 'desktop', 'industrial-linux'])
    assert.match(job(name), /if: needs.changes.outputs.core == 'true'/);
  assert.match(job('industrial'), /if: needs.changes.outputs.full == 'true'/);
  for (const name of ['desktop', 'industrial-linux'])
    assert.match(job(name), /full: \$\{\{ needs.changes.outputs.full == 'true' \}\}/);
  assert.match(
    job('all-checks-passed'),
    /require\('\.\/scripts\/ci-areas.cjs'\)\.failedJobs\(jobs\)/,
  );

  for (const name of ['desktop-package', 'industrial-linux']) {
    const reusable = fs.readFileSync(path.join(root, `.github/workflows/${name}.yml`), 'utf8');
    assert.match(reusable, /full:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: true/);
    const step = title => reusable.split(`      - name: ${title}\n`)[1].split(/\n {6}- /)[0];
    const expensive =
      name === 'desktop-package'
        ? [
            'Verify full Domain installation',
            'Verify clean Apple Silicon CAD installation and real native tasks',
          ]
        : [
            'Install the previous public preview before upgrading',
            'Build clean immutable installer and verify actual installed consumer',
            'Verify installed host Docker execution alongside the current-user Agent',
          ];
    for (const title of expensive) assert.match(step(title), /if: inputs.full/);
    const core =
      name === 'desktop-package'
        ? ['Verify installed application first run', 'Verify workbench UI and language switching']
        : [
            'Native Agent, project discovery, real RTL and recovery',
            'Verify packaged headless Agent through its current-user launcher',
          ];
    for (const title of core) assert.doesNotMatch(step(title), /if:/);
  }
});
