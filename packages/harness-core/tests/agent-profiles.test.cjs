const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AgentProfiles } = require('../src/agent-profiles.cjs');

const registry = {
  domains: [{ id: 'review' }, { id: 'other' }],
  skills: [
    { id: 'global.inspect', title: 'Inspect', domain: '*' },
    { id: 'review.inspect', title: 'Review', domain: 'review' },
  ],
  agents: [],
};
const input = {
  name: 'Reviewer',
  description: 'Review with evidence',
  instructions: 'Inspect first.',
  domain: '*',
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new AgentProfiles(directory) };
}

test('global references are checked with zero or one installed domain', t => {
  const { store } = fixture(t);
  assert.throws(
    () => store.save({ ...registry, domains: [] }, { ...input, subagents: ['missing'] }),
    /unavailable/,
  );
  assert.throws(
    () =>
      store.save(
        { ...registry, domains: [{ id: 'review' }] },
        { ...input, skills: ['review.inspect'] },
      ),
    /unavailable skill/,
  );
  const saved = store.save(registry, { ...input, skills: ['global.inspect'] });
  assert.equal(store.snapshot(registry, { domain: 'other' }, saved.id).id, saved.id);
  assert.equal(store.read().agents.length, 1);
});

test('editing a child validates existing ancestors and rejected saves leave the catalogue intact', t => {
  const { store } = fixture(t);
  const child = store.save(registry, input);
  const parent = store.save(registry, { ...input, domain: 'other', subagents: [child.id] });
  assert.throws(
    () => store.save(registry, { ...input, id: child.id, domain: 'review' }),
    /unavailable/,
  );
  assert.equal(store.snapshot(registry, { domain: 'other' }, parent.id).profiles[1].domain, '*');
  store.save(registry, { ...input, id: child.id, instructions: 'New instruction.' });
  assert.equal(
    store.snapshot(registry, { domain: 'other' }, parent.id).profiles[1].instructions,
    'New instruction.',
  );
});

test('simultaneous CLI and Desktop stores preserve every save, removal and project default', async t => {
  const { directory, store } = fixture(t);
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const { AgentProfiles } = require(process.argv[1]);
    const store = new AgentProfiles(process.argv[2]);
    const registry = JSON.parse(process.argv[3]), input = JSON.parse(process.argv[4]);
    const project = { path: path.join(process.argv[2], process.argv[5]), domain: 'review' };
    fs.mkdirSync(project.path);
    for (let i = 0; i < 4; i++) {
      const agent = store.save(registry, { ...input, name: process.argv[5] + '-' + i });
      store.setDefault(registry, project, agent.id);
      const temporary = store.save(registry, input);
      store.remove(temporary.id);
    }
  `;
  await Promise.all(
    Array.from(
      { length: 6 },
      (_, index) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '-e',
              script,
              require.resolve('../src/agent-profiles.cjs'),
              directory,
              JSON.stringify(registry),
              JSON.stringify(input),
              `writer-${index}`,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let errors = '';
          child.stderr.on('data', data => {
            errors += data;
          });
          child.on('error', reject);
          child.on('exit', code => (code === 0 ? resolve() : reject(Error(errors))));
        }),
    ),
  );
  assert.equal(store.read().agents.length, 24);
  assert.equal(Object.keys(store.read().defaults).length, 6);
  for (let index = 0; index < 6; index++) {
    const project = { path: path.join(directory, `writer-${index}`), domain: 'review' };
    assert.equal(store.snapshot(registry, project).name, `writer-${index}-3`);
  }
});
