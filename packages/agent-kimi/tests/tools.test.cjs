const test = require('node:test');
const assert = require('node:assert/strict');
const { externalTools, industrialContext } = require('../src/index.cjs');

test('Kimi receives only current Broker tools and stale calls are rejected', async () => {
  let scope = { capabilityIds: ['chip.rtl.netlist.inspect'], tools: ['eda.netlist.inspect'] };
  const tools = externalTools(
    () => scope,
    async id => ({ id, kind: 'netlist' }),
    id => ({ capability: id }),
  );
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['industrial_capability_detail', 'eda_netlist_inspect'],
  );
  const result = await tools[1].handler({ artifactId: 'sample' });
  assert.match(result.output, /sample/);
  scope = {
    capabilityIds: ['chip.verification.waveform.inspect'],
    tools: ['eda.waveform.inspect'],
  };
  await assert.rejects(tools[1].handler({ artifactId: 'sample' }), /outside/);
});

test('general project tasks receive no industrial tools', () => {
  const tools = externalTools(
    () => ({ capabilityIds: [], tools: [] }),
    async () => null,
    () => null,
  );
  assert.deepEqual(tools, []);
});

test('capability scope errors disclose current IDs for recovery without reading rejected details', async () => {
  let scope = {
    version: 'initial-scope',
    capabilityIds: ['allowed.initial'],
    tools: [],
  };
  const disclosed = [];
  const [tool] = externalTools(
    () => scope,
    async () => null,
    id => {
      disclosed.push(id);
      return { capability: id, tools: [] };
    },
  );
  // A call may wait for approval while the host replaces its Broker scope.
  scope = { version: 'current-scope', capabilityIds: ['allowed.current'], tools: [] };
  for (const capabilityId of ['unknown.capability', 'allowed.initial']) {
    const result = await tool.handler({ capabilityId });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.output);
    assert.equal(error.code, 'CAPABILITY_OUT_OF_SCOPE');
    assert.equal(error.requestedCapabilityId, capabilityId);
    assert.deepEqual(error.allowedCapabilityIds, ['allowed.current']);
    assert.equal(error.scopeVersion, 'current-scope');
    assert.match(error.message, /outside the current Broker scope/);
    assert.match(error.nextStep, /allowedCapabilityIds/);
    assert.deepEqual(disclosed, []);
    assert.deepEqual(scope.capabilityIds, ['allowed.current']);
  }
  const allowed = await tool.handler({ capabilityId: 'allowed.current', section: 'tools' });
  assert.ok(!allowed.isError);
  assert.deepEqual(JSON.parse(allowed.output), { capability: 'allowed.current', tools: [] });
  assert.deepEqual(disclosed, ['allowed.current']);

  // Revocation, including removal of the scope itself, remains fail-closed.
  for (const revoked of [{ version: 'revoked-scope', capabilityIds: [], tools: [] }, undefined]) {
    scope = revoked;
    const result = await tool.handler({ capabilityId: 'allowed.current' });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.output);
    assert.deepEqual(error.allowedCapabilityIds, []);
    assert.equal(error.scopeVersion, scope?.version ?? null);
    assert.deepEqual(disclosed, ['allowed.current']);
  }
});

test('capability detail still validates required IDs and section before scope recovery', async () => {
  const [tool] = externalTools(
    () => ({ capabilityIds: ['allowed'], tools: [] }),
    async () => null,
    () => assert.fail('invalid parameters must not reach disclosure'),
  );
  for (const args of [{}, { capabilityId: 1 }, { capabilityId: 'allowed', section: 'unknown' }])
    await assert.rejects(tool.handler(args), error => Array.isArray(error.issues));
});

test('agent context reports current-user permissions without promising OS write isolation', () => {
  const context = industrialContext({
    domain: 'general',
    stage: 'workspace',
    capabilityIds: [],
    skills: [],
    tools: [],
  });
  assert.match(context, /current user's permissions/);
  assert.match(context, /can modify files accessible to that user/);
  assert.match(context, /approvals do not provide OS write isolation/);
  assert.match(context, /Broker scope, caller approval and engineering verification/);
  assert.doesNotMatch(context, /cannot modify the project|cannot.*host Docker|Windows runs/);
});

test('capability detail can be narrowed and stale capability calls are rejected', async () => {
  let scope = { capabilityIds: ['chip.rtl.netlist.inspect'], tools: [] };
  const tools = externalTools(
    () => scope,
    async () => null,
    () => ({
      capability: 'chip.rtl.netlist.inspect',
      skills: [{ id: 'skill', reference: 'x'.repeat(20000) }],
      tools: [{ id: 'tool' }],
      verification: [],
    }),
  );
  await assert.rejects(
    tools[0].handler({ capabilityId: 'chip.rtl.netlist.inspect' }),
    /above the 16384-byte limit/,
  );
  assert.deepEqual(
    JSON.parse(
      (await tools[0].handler({ capabilityId: 'chip.rtl.netlist.inspect', section: 'tools' }))
        .output,
    ),
    { capability: 'chip.rtl.netlist.inspect', tools: [{ id: 'tool' }] },
  );
  scope = { capabilityIds: [], tools: [] };
  const revoked = await tools[0].handler({ capabilityId: 'chip.rtl.netlist.inspect' });
  assert.equal(revoked.isError, true);
  assert.equal(JSON.parse(revoked.output).code, 'CAPABILITY_OUT_OF_SCOPE');
  assert.deepEqual(JSON.parse(revoked.output).allowedCapabilityIds, []);
});

test('artifact metadata and injected scope reject oversized responses without silent truncation', async () => {
  const scope = {
    domain: 'chip',
    stage: 'rtl',
    capabilityIds: ['chip.rtl.netlist.inspect'],
    skills: [],
    tools: ['eda.netlist.inspect'],
  };
  const tools = externalTools(
    () => scope,
    async id => ({ id, kind: 'netlist', payload: '中'.repeat(6000) }),
    () => null,
  );
  await assert.rejects(tools[1].handler({ artifactId: 'large' }), /above the 16384-byte limit/);
  assert.throws(
    () =>
      industrialContext({
        ...scope,
        tools: Array.from({ length: 1000 }, (_, index) => `tool-${index}`),
      }),
    /Industrial Context limit/,
  );
});

test('typed artifact kinds like waveform.vcd match their eda inspect tool category', async () => {
  const scope = {
    domain: 'chip',
    stage: 'rtl',
    capabilityIds: ['chip.verification.waveform.inspect'],
    skills: [],
    tools: ['eda.waveform.inspect'],
  };
  const tools = externalTools(
    () => scope,
    async id => ({ id, kind: 'waveform.vcd' }),
    () => null,
  );
  const inspect = tools.find(tool => tool.name === 'eda_waveform_inspect');
  const result = await inspect.handler({ artifactId: 'evidence' });
  assert.match(result.output, /waveform\.vcd/);

  // Unrelated kinds stay rejected.
  const mismatched = externalTools(
    () => scope,
    async id => ({ id, kind: 'report.simulation' }),
    () => null,
  );
  await assert.rejects(
    mismatched.find(tool => tool.name === 'eda_waveform_inspect').handler({ artifactId: 'x' }),
    /unavailable for this tool/,
  );
});
