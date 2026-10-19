const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ResourceSettings,
  effectiveResourcePolicy,
  resourceCatalog,
  resolveProjectTask,
} = require('../src/index.cjs');
const { selectMcpServers } = require('@industrial-agent-harness/domain-mcp');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'),
    b = path.join(root, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  return { store: new ResourceSettings(root), root, a, b };
}
test('global defaults, project overrides and inherit persist and affect actual Broker scope', t => {
  const { store, root, a, b } = fixture(t);
  const catalog = resourceCatalog('chip');
  const setting = { kind: 'skill', id: 'chip.netlist.inspect' };
  store.set(catalog, { ...setting, mode: 'disabled' });
  assert.deepEqual(store.snapshot(catalog, a).effective.skills, [setting.id]);
  store.set(catalog, { ...setting, mode: 'enabled' }, a);
  assert.deepEqual(store.snapshot(catalog, a).effective.skills, []);
  assert.deepEqual(store.snapshot(catalog, b).effective.skills, [setting.id]);
  const restarted = new ResourceSettings(root);
  assert.deepEqual(
    resolveProjectTask(
      'chip',
      { task: 'Inspect netlist' },
      undefined,
      undefined,
      restarted.snapshot(catalog, a).effective,
    ).scope.skills,
    [setting.id],
  );
  restarted.set(catalog, { ...setting, mode: 'inherit' }, a);
  assert.deepEqual(
    resolveProjectTask(
      'chip',
      { task: 'Inspect netlist' },
      undefined,
      undefined,
      restarted.snapshot(catalog, a).effective,
    ).scope.skills,
    [],
  );
  restarted.set(catalog, { ...setting, mode: 'enabled' });
  assert.deepEqual(restarted.snapshot(catalog, a).effective.skills, []);
  restarted.set(catalog, { ...setting, mode: 'disabled' }, a);
  assert.deepEqual(restarted.snapshot(catalog, a).effective.skills, [setting.id]);
  // POSIX permission bits are not represented by Windows stat().
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.throws(() => store.set(catalog, { ...setting, mode: 'inherit' }), /Global resources/);
  assert.throws(
    () => store.set(catalog, { ...setting, id: 'missing', mode: 'enabled' }, a),
    /Unknown resource/,
  );
  assert.throws(
    () => store.set(resourceCatalog('pcb'), { ...setting, mode: 'enabled' }, a),
    /Unknown resource/,
  );
});
test('legacy disabled IDs migrate once; resetting inheritance does not resurrect them', t => {
  const { store, a, root } = fixture(t);
  const legacy = [{ path: a, disabledSkills: ['chip.netlist.inspect'] }];
  store.migrate(legacy);
  const catalog = resourceCatalog('chip');
  assert.equal(store.snapshot(catalog, a).overrides.skills['chip.netlist.inspect'], false);
  store.set(catalog, { kind: 'skill', id: 'chip.netlist.inspect', mode: 'inherit' }, a);
  store.migrate(legacy);
  assert.deepEqual(store.snapshot(catalog, a).overrides.skills, {});
  const alias = path.join(root, 'alias');
  fs.symlinkSync(a, alias);
  assert.deepEqual(store.snapshot(catalog, alias), store.snapshot(catalog, a));
  fs.writeFileSync(store.file, '{broken');
  assert.throws(() => store.snapshot(catalog, a), /Cannot read/);
  assert.throws(
    () => store.set(catalog, { kind: 'skill', id: 'chip.netlist.inspect', mode: 'disabled' }, a),
    /Cannot read/,
  );
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});
test('MCP effective policy feeds scope filtering and still withholds out-of-scope providers', t => {
  const { store, a } = fixture(t);
  const server = {
    id: 'test-provider',
    domain: 'test-domain',
    enabledByDefault: true,
    toolIds: ['test.read'],
  };
  const catalog = { skills: [], mcpServers: [server] };
  const scope = { domain: 'test-domain', tools: ['test.read'] };
  store.set(catalog, { kind: 'mcp', id: server.id, mode: 'disabled' });
  assert.deepEqual(
    selectMcpServers(scope, store.snapshot(catalog, a).effective.mcpServers, [server]),
    [],
  );
  store.set(catalog, { kind: 'mcp', id: server.id, mode: 'enabled' }, a);
  assert.deepEqual(
    selectMcpServers(scope, store.snapshot(catalog, a).effective.mcpServers, [server]),
    [server],
  );
  assert.deepEqual(
    selectMcpServers({ ...scope, tools: [] }, store.snapshot(catalog, a).effective.mcpServers, [
      server,
    ]),
    [],
  );
  assert.deepEqual(
    effectiveResourcePolicy({ skills: [], mcpServers: [] }, { mcpServers: [server.id] }).mcpServers,
    [],
  );
});

test('Runtime provider global defaults and project inheritance filter actual Broker tool scope', t => {
  const { store, a, b } = fixture(t);
  const descriptor = { id: 'fixture.live', risk: 'read-only' };
  const registry = {
    skills: [],
    providerPacks: [
      {
        id: 'fixture-pack',
        domain: 'fixture-domain',
        provider: {
          id: 'fixture.runtime',
          domain: 'fixture-domain',
          title: 'Fixture Runtime',
          transport: 'runtime',
          tools: [{ id: descriptor.id, summary: 'Live tool' }, { id: 'fixture.retired' }],
        },
      },
    ],
  };
  const runtimeBundle = { packId: 'fixture-pack', runtime: {}, domainTools: [{ descriptor }] };
  const catalog = resourceCatalog('fixture-domain', [], { registry, runtimeBundle });
  const capabilities = [
    {
      id: 'fixture.capability',
      domain: 'fixture-domain',
      title: 'Fixture capability',
      stages: [],
      keywords: ['fixture'],
      priority: 1,
      skills: [],
      tools: [{ id: descriptor.id, summary: 'Live tool' }],
      verification: [],
    },
  ];
  const resolve = directory =>
    resolveProjectTask(
      'fixture-domain',
      { task: 'fixture' },
      undefined,
      capabilities,
      store.snapshot(catalog, directory).effective,
      [],
      [{ id: 'fixture-domain' }],
      catalog.mcpServers,
    ).scope.tools;
  assert.deepEqual(catalog.mcpServers[0].toolIds, [descriptor.id]);
  assert.deepEqual(resolve(a), [descriptor.id]);
  store.set(catalog, { kind: 'mcp', id: 'fixture.runtime', mode: 'disabled' });
  assert.deepEqual(
    resolveProjectTask(
      'fixture-domain',
      { task: 'fixture' },
      undefined,
      [
        {
          ...capabilities[0],
          tools: [{ id: 'fixture.retired', summary: 'Unavailable profile declaration' }],
        },
      ],
      store.snapshot(catalog, a).effective,
      [],
      [{ id: 'fixture-domain' }],
      catalog.mcpServers,
    ).scope.tools,
    [],
    'disabled providers also withhold declarations absent from the current Runtime profile',
  );
  assert.deepEqual(resolve(a), []);
  assert.deepEqual(resolve(b), []);
  store.set(catalog, { kind: 'mcp', id: 'fixture.runtime', mode: 'enabled' }, a);
  assert.deepEqual(resolve(a), [descriptor.id]);
  assert.deepEqual(resolve(b), []);
  store.set(catalog, { kind: 'mcp', id: 'fixture.runtime', mode: 'inherit' }, a);
  assert.deepEqual(resolve(a), []);
  store.set(catalog, { kind: 'mcp', id: 'fixture.runtime', mode: 'enabled' });
  assert.deepEqual(resolve(a), [descriptor.id]);
  // A new remote profile descriptor obeys the same provider policy.
  const remoteDescriptor = { id: 'fixture.remote', risk: 'mutating' };
  const remoteCatalog = resourceCatalog('fixture-domain', [], {
    registry,
    runtimeBundle: {
      runtime: { domain: 'fixture-domain', hostRuntimeOnly: true, remoteTools: [remoteDescriptor] },
    },
  });
  store.set(remoteCatalog, { kind: 'mcp', id: 'fixture.runtime', mode: 'disabled' }, a);
  assert.deepEqual(
    resolveProjectTask(
      'fixture-domain',
      { task: 'fixture' },
      undefined,
      [{ ...capabilities[0], tools: [{ id: remoteDescriptor.id }] }],
      store.snapshot(remoteCatalog, a).effective,
      [],
      [{ id: 'fixture-domain' }],
      remoteCatalog.mcpServers,
    ).scope.tools,
    [],
  );
});
