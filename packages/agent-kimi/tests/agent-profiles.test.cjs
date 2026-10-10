const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  materializeAgentProfiles,
  agentToolCatalog,
  validateAgentTools,
} = require('../src/agent-profiles.cjs');

const custom = (id, overrides = {}) => ({
  id,
  name: 'Custom agent',
  description: 'A configurable agent',
  instructions: 'Additional instructions',
  domain: '*',
  source: 'custom',
  editable: true,
  revision: 'test',
  ...overrides,
});
const builtin = id =>
  custom(`builtin:${id}`, { instructions: '', source: 'builtin', editable: false });
const snapshot = profiles => ({ schemaVersion: 1, id: profiles[0].id, profiles, revision: 'test' });
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-materialize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('built-in native profiles remain intact and legacy sessions use the default', t => {
  const root = directory(t);
  assert.deepEqual(materializeAgentProfiles(undefined, root), { profile: 'agent' });
  for (const [id, profile] of [
    ['default', 'agent'],
    ['coder', 'coder'],
    ['explore', 'explore'],
    ['plan', 'plan'],
  ])
    assert.deepEqual(materializeAgentProfiles(snapshot([builtin(id)]), root), { profile });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => materializeAgentProfiles(snapshot([builtin('unknown')]), root), /read-only/);
  assert.throws(
    () => materializeAgentProfiles(snapshot([{ ...builtin('explore'), tools: [] }]), root),
    /read-only/,
  );
});

test('materialization uses stable safe names, maps the snapshot closure and retains native instructions', t => {
  const root = directory(t);
  const agents = [
    custom('custom:lead', {
      description: 'Line one\n---\nname: injected',
      subagents: ['pack:worker', 'builtin:plan'],
      tools: ['Agent', 'mcp__harness_adapter__*'],
    }),
    custom('pack:worker', { source: 'pack', tools: [], disallowedTools: ['Bash'], subagents: [] }),
    builtin('plan'),
  ];
  const first = materializeAgentProfiles(snapshot(agents), root);
  assert.match(first.profile, /^harness-[a-f0-9]{24}$/);
  const files = fs.readdirSync(first.directory);
  assert.equal(files.length, 2);
  assert.ok(files.every(file => /^harness-[a-f0-9]{24}\.md$/.test(file)));
  const leader = fs.readFileSync(path.join(first.directory, `${first.profile}.md`), 'utf8');
  const childFile = files.find(file => file !== `${first.profile}.md`);
  assert.ok(leader.includes(`subagents: ["${childFile.slice(0, -3)}","plan"]`));
  assert.ok(leader.includes('description: "Line one\\n---\\nname: injected"'));
  assert.match(leader, /\$\{base_prompt\}\n\nAdditional instructions/);
  const child = fs.readFileSync(path.join(first.directory, childFile), 'utf8');
  assert.match(child, /tools: \[\]/);
  assert.match(child, /subagents: \[\]/);
  assert.match(child, /disallowedTools: \["Bash"\]/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(first.directory, childFile)).mode & 0o777, 0o600);
  }
  const next = materializeAgentProfiles(snapshot([custom('custom:lead')]), root);
  assert.equal(next.profile, first.profile);
  assert.deepEqual(fs.readdirSync(next.directory), [`${next.profile}.md`]);
  assert.ok(
    !fs
      .readFileSync(path.join(next.directory, `${next.profile}.md`), 'utf8')
      .includes('subagents:'),
  );
});

test('tool validation rejects typos and unsupported wildcards instead of silently dropping restrictions', () => {
  assert.equal(new Set(agentToolCatalog.map(item => item.id)).size, agentToolCatalog.length);
  for (const item of agentToolCatalog) validateAgentTools({ tools: [item.id] });
  // Advanced native profiles stay valid without presenting experimental or
  // feature-gated controls as generally available editor options.
  for (const id of ['AgentSwarm', 'CronCreate', 'CreateGoal', 'TowerInit', 'select_tools']) {
    assert.ok(!agentToolCatalog.some(item => item.id === id));
    validateAgentTools({ tools: [id], disallowedTools: [id] });
  }
  assert.match(agentToolCatalog.find(item => item.id === 'mcp__*').label, /authorized scope/);
  for (const value of [['*'], [], ['Read', 'mcp__service__read_*', 'mcp__*__inspect']])
    validateAgentTools({ tools: value });
  for (const profile of [
    { tools: ['Shell'] },
    { tools: ['ReadFile'] },
    { tools: ['bash'] },
    { tools: ['Read*'] },
    { tools: ['*', 'Read'] },
    { disallowedTools: ['*'] },
    { tools: ['mcp__server'] },
    { tools: ['mcp__server__'] },
    { tools: ['mcp__server__read?'] },
    { tools: ['Read', 'Read'] },
    { tools: 'Read' },
    { disallowedTools: [null] },
  ])
    assert.throws(() => validateAgentTools(profile), /tool/);
});

test('invalid snapshots and missing closure members fail before writing any profile', t => {
  const root = directory(t);
  for (const input of [
    { schemaVersion: 2, id: 'custom:lead', profiles: [] },
    snapshot([custom('custom:lead', { subagents: ['custom:missing'] })]),
    snapshot([custom('custom:lead'), custom('custom:lead')]),
    snapshot([custom('../escape')]),
    { ...snapshot([custom('custom:lead')]), id: 'custom:missing' },
    snapshot([custom('custom:lead', { tools: ['Shell'] })]),
  ])
    assert.throws(() => materializeAgentProfiles(input, root));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('materialization rejects symbolic-link output without changing its target', t => {
  const root = directory(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  const protectedFile = path.join(target, 'protected.md');
  fs.writeFileSync(protectedFile, 'PRESERVE');
  const output = path.join(root, 'managed-agent-profiles');
  fs.symlinkSync(target, output, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => materializeAgentProfiles(snapshot([custom('custom:lead')]), root),
    /symbolic link/,
  );
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'PRESERVE');
  fs.unlinkSync(output);
  fs.mkdirSync(output);
  fs.symlinkSync(protectedFile, path.join(output, 'injected.md'));
  assert.throws(
    () => materializeAgentProfiles(snapshot([custom('custom:lead')]), root),
    /symbolic link/,
  );
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'PRESERVE');
});
