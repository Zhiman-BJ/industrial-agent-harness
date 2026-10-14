const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  listToolProviders,
  listMcpServers,
  selectMcpServers,
  writeMcpConfig,
} = require('./index.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-provider-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'pack');
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'runtime.cjs'),
    `module.exports.createRuntimePlugin = () => ({
      tools: [{
        descriptor: { id: 'fixture.live', risk: 'read-only' },
        execute() { throw Error('Catalog must not execute tools.'); }
      }]
    });`,
  );
  const registry = {
    providerPacks: [
      {
        id: 'fixture-pack',
        domain: 'fixture-domain',
        provider: {
          id: 'fixture.runtime',
          title: 'Fixture Runtime',
          domain: 'fixture-domain',
          transport: 'runtime',
          version: '1',
          config: { env: { PRIVATE_KEY: 'not-public' } },
          sourceFiles: { 'runtime.cjs': 'private-source-digest' },
          tools: [
            { id: 'fixture.live', name: 'Live tool', summary: 'Read real project facts.' },
            { id: 'fixture.retired', name: 'Old manifest tool' },
          ],
        },
      },
    ],
    runtimePacks: [{ id: 'fixture-pack', directory, runtime: { entry: 'runtime.cjs' } }],
  };
  return { root, directory, registry };
}

test('Runtime catalog uses executable registrations, merges display metadata, and keeps configuration private', t => {
  const { registry } = fixture(t);
  const [provider] = listToolProviders('fixture-domain', [], { registry });
  assert.deepEqual(provider.toolIds, ['fixture.live']);
  assert.deepEqual(provider.tools, [
    {
      id: 'fixture.live',
      title: 'Live tool',
      description: 'Read real project facts.',
      risk: 'read-only',
    },
  ]);
  assert.equal(provider.catalogSource, 'runtime-descriptors');
  assert.equal(provider.transport, 'runtime');
  assert.equal(provider.enabledByDefault, true);
  assert.equal(provider.config, undefined);
  assert.equal(provider.sourceFiles, undefined);
  assert.deepEqual(listToolProviders('another-domain', [], { registry }), []);
});

test('loaded local and remote bundles provide the actual project descriptors without loading another Runtime', t => {
  const { registry, directory } = fixture(t);
  fs.rmSync(path.join(directory, 'runtime.cjs'));
  const descriptor = { id: 'fixture.project-profile', risk: 'mutating' };
  const local = listToolProviders('fixture-domain', [], {
    registry,
    runtimeBundle: {
      packId: 'fixture-pack',
      runtime: {},
      domainTools: [
        {
          descriptor,
          guide: { title: 'Project profile', description: 'Current project Runtime.' },
        },
      ],
    },
  });
  assert.deepEqual(local[0].toolIds, [descriptor.id]);
  assert.equal(local[0].tools[0].description, 'Current project Runtime.');
  const remote = listToolProviders('fixture-domain', [], {
    registry,
    runtimeBundle: {
      runtime: { hostRuntimeOnly: true, domain: 'fixture-domain', remoteTools: [descriptor] },
    },
  });
  assert.deepEqual(remote[0].toolIds, [descriptor.id]);
});

test('older gateway manifests keep their standalone declarations separate from actual Runtime tools', t => {
  const { registry } = fixture(t);
  registry.providerPacks[0].provider.transport = 'gateway';
  const [provider] = listToolProviders(undefined, [], { registry });
  assert.equal(provider.transport, 'runtime');
  assert.deepEqual(provider.toolIds, ['fixture.live']);
  assert.deepEqual(
    provider.standaloneMcp.tools.map(tool => tool.id),
    ['fixture.live', 'fixture.retired'],
  );
  assert.equal(provider.standaloneMcp.transport, 'gateway');
});

test('a verified Pack repair refreshes the descriptors at the same entry path', t => {
  const { registry, directory } = fixture(t);
  assert.deepEqual(listToolProviders(undefined, [], { registry })[0].toolIds, ['fixture.live']);
  const entry = path.join(directory, 'runtime.cjs');
  fs.writeFileSync(
    entry,
    fs.readFileSync(entry, 'utf8').replace('fixture.live', 'fixture.repaired'),
  );
  assert.deepEqual(listToolProviders(undefined, [], { registry })[0].toolIds, ['fixture.repaired']);
});

test('unavailable or escaped Runtime entries remain visible without hiding other domains', t => {
  const { root, directory, registry } = fixture(t);
  const entry = path.join(directory, 'runtime.cjs');
  fs.rmSync(entry);
  assert.match(listToolProviders(undefined, [], { registry })[0].catalogError, /Could not load/);
  const outside = path.join(root, 'outside.cjs');
  fs.writeFileSync(outside, 'throw Error("must not load escaped entry");');
  fs.symlinkSync(outside, entry);
  const [provider] = listToolProviders(undefined, [], { registry });
  assert.match(provider.catalogError, /Could not load/);
  assert.deepEqual(provider.tools, []);
  const external = [
    {
      id: 'external.fixture',
      title: 'Unaffected external',
      domain: '*',
      config: { command: 'private' },
      tools: [{ id: 'external.live' }],
    },
  ];
  assert.deepEqual(listToolProviders(undefined, external, { registry })[1].toolIds, [
    'external.live',
  ]);
});

test('Runtime catalog entries never become standalone MCP servers or generated configuration', t => {
  const { root, registry } = fixture(t);
  const catalog = listToolProviders('fixture-domain', [], { registry });
  assert.deepEqual(
    selectMcpServers({ domain: 'fixture-domain', tools: catalog[0].toolIds }, [], catalog),
    [],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(writeMcpConfig(root, catalog), 'utf8')), {
    mcpServers: {},
  });
});

test('every bundled Runtime provider is catalogued without launching native processes', () => {
  const originals = Object.fromEntries(
    ['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync'].map(name => [
      name,
      childProcess[name],
    ]),
  );
  for (const name of Object.keys(originals))
    childProcess[name] = () => {
      throw Error('Catalog launched a process.');
    };
  try {
    const providers = listToolProviders().filter(provider => provider.transport === 'runtime');
    assert.ok(providers.length > 0);
    for (const provider of providers) {
      assert.ok(Array.isArray(provider.toolIds), provider.id);
      assert.deepEqual(
        listToolProviders(provider.domain).map(item => item.id),
        providers.filter(item => item.domain === provider.domain).map(item => item.id),
      );
      assert.deepEqual(
        provider.toolIds,
        provider.tools.map(tool => tool.id),
      );
    }
    assert.ok(listMcpServers().every(provider => provider.transport !== 'runtime'));
  } finally {
    Object.assign(childProcess, originals);
  }
});
