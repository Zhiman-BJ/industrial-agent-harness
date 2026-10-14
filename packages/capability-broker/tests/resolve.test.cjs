const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve, discloseDetail, assertToolAllowed } = require('../src/index.cjs');
const registry = require('../../domain-skills/src/index.cjs').capabilities.filter(
  item =>
    item.tools.length > 0 && (!item.tools.some(tool => tool.risk) || item.id === 'pcb.native.task'),
);

test('progressive disclosure selects only matching domain and stage', () => {
  const result = resolve(
    { domain: 'chip', stage: 'rtl', task: 'Inspect the netlist signals' },
    registry,
  );
  assert.deepEqual(result.scope.capabilityIds, ['chip.rtl.netlist.inspect']);
  assert.deepEqual(result.scope.tools, ['eda.netlist.inspect']);
  assert.deepEqual(
    result.trace.map(item => item.level),
    ['L0', 'L1', 'L1', 'L2', 'L2', 'L2', 'L3'],
  );
  assert.equal(result.trace.find(item => item.event === 'detail.deferred').detail.toolSchemas, 1);
  assert.throws(() => assertToolAllowed(result.scope, 'pcb.board.inspect'), /outside/);
  assert.equal(
    discloseDetail(result.scope, registry, result.matches[0].id).tools[0].schema.artifactId,
    'string',
  );
});

test('scope changes replace old capabilities', () => {
  const first = resolve({ domain: 'chip', stage: 'rtl', task: 'netlist' }, registry);
  const next = resolve(
    { domain: 'pcb', stage: 'layout', task: 'Inspect PCB board' },
    registry,
    first.scope,
  );
  assert.deepEqual(next.scope.tools, ['pcb.kicad.edit', 'pcb.kicad.verify']);
  assert.equal(
    next.trace.find(item => item.event === 'scope.replace').detail.previous,
    first.scope.version,
  );
  assert.throws(() => discloseDetail(next.scope, registry, 'chip.rtl.netlist.inspect'), /outside/);
});

test('automatic context resolves from task or selected artifact', () => {
  const pcb = resolve({ task: 'Inspect the PCB board routing' }, registry);
  assert.equal(pcb.scope.domain, 'pcb');
  assert.equal(pcb.scope.stage, undefined);
  assert.deepEqual(pcb.scope.capabilityIds, ['pcb.native.task']);
  assert.ok(pcb.contexts.some(item => item.domain === 'chip' && item.stage === 'physical'));
  const waveform = resolve({ task: 'Inspect this artifact', artifactKind: 'waveform' }, registry);
  assert.deepEqual(waveform.scope.capabilityIds, ['chip.verification.waveform.inspect']);
  const unknown = resolve({ task: 'Plan an unrelated activity' }, registry);
  assert.deepEqual(unknown.scope.capabilityIds, []);
  assert.equal(unknown.scope.domain, null);
});

test('specific action phrase outranks multiple generic domain terms', () => {
  const candidates = [
    {
      id: 'pcb.inspect',
      domain: 'pcb',
      title: 'Inspect',
      stages: ['layout'],
      priority: 20,
      keywords: ['pcb', 'board'],
      skills: [],
      tools: [],
    },
    {
      id: 'pcb.design',
      domain: 'pcb',
      title: 'Design',
      stages: ['requirements'],
      priority: 20,
      keywords: ['design a kicad project'],
      skills: [],
      tools: [],
    },
  ];
  const result = resolve(
    { domain: 'pcb', task: 'Design a KiCad project and deliver a PCB board' },
    candidates,
  );
  assert.deepEqual(result.scope.capabilityIds, ['pcb.design']);
});

test('explicit tool names select the smallest capability that can perform the requested actions', () => {
  const candidates = [
    {
      id: 'pcb.viewer',
      domain: 'pcb',
      title: 'Viewer',
      stages: ['layout'],
      priority: 10,
      keywords: ['pcb', 'board', 'route'],
      skills: [],
      tools: [],
    },
    {
      id: 'pcb.place',
      domain: 'pcb',
      title: 'Place',
      stages: ['layout'],
      priority: 20,
      keywords: [],
      skills: [],
      tools: [{ id: 'pcb.design.place_component' }],
    },
    {
      id: 'pcb.complete',
      domain: 'pcb',
      title: 'Complete',
      stages: ['layout'],
      priority: 25,
      keywords: [],
      skills: [],
      tools: [{ id: 'pcb.design.place_component' }, { id: 'pcb.design.verify_design' }],
    },
  ];
  const one = resolve({ domain: 'pcb', task: 'Use place_component on the board' }, candidates);
  assert.deepEqual(one.scope.capabilityIds, ['pcb.place']);
  const both = resolve(
    { domain: 'pcb', task: 'Use place_component on the board, then verify_design' },
    candidates,
  );
  assert.deepEqual(both.scope.capabilityIds, ['pcb.complete']);
  assert.match(
    both.trace.find(row => row.event === 'capability.resolve').detail.selected[0].reason,
    /pcb\.design\.verify_design/,
  );
  assert.deepEqual(
    resolve({ domain: 'pcb', task: 'Use pcb.design.place_component' }, candidates).scope
      .capabilityIds,
    ['pcb.place'],
  );
  assert.deepEqual(
    resolve({ domain: 'pcb', task: 'Inspect pcbydesignyplace_component' }, candidates).scope
      .capabilityIds,
    ['pcb.viewer'],
  );
  assert.deepEqual(
    resolve({ domain: 'pcb', task: 'Inspect notplace_componentX' }, candidates).scope.capabilityIds,
    // No tool matched, but a domain-bound session keeps the primary capability.
    ['pcb.complete'],
  );
});

test('a domain-bound session falls back to the primary capability without a keyword match', () => {
  const native = [
    {
      id: 'godot.native.task',
      domain: 'godot',
      title: 'Native',
      stages: [],
      priority: 100,
      keywords: ['godot', 'gdscript', '游戏', '场景'],
      skills: [{ id: 'godot.game.develop' }, { id: 'godot.game.inspect' }],
      tools: [{ id: 'godot.scene.edit' }, { id: 'godot.scene.verify' }],
    },
  ];
  const colloquial = resolve(
    { domain: 'godot', task: '帮我把盒子的边长改成 8 8 8，挪到原点，然后跑一下看看改对了没' },
    native,
  );
  assert.equal(colloquial.scope.domain, 'godot');
  assert.deepEqual(colloquial.scope.capabilityIds, ['godot.native.task']);
  assert.deepEqual(colloquial.scope.tools, ['godot.scene.edit', 'godot.scene.verify']);
  assert.match(
    colloquial.trace.find(row => row.event === 'capability.resolve').detail.selected[0].reason,
    /domain-bound fallback/,
  );
  // The fallback selection scores zero; it must not also appear as excluded.
  assert.deepEqual(
    colloquial.trace.find(row => row.event === 'capability.resolve').detail.excluded,
    [],
  );
  assert.equal(
    colloquial.trace.find(row => row.event === 'context.infer').detail.source,
    'domain-fallback',
  );
  const inferred = resolve({ task: '帮我把盒子的边长改成 8 8 8' }, native);
  assert.deepEqual(inferred.scope.capabilityIds, []);
  assert.equal(inferred.scope.domain, null);
});

test('a domain-bound multi-capability fallback follows the declared priority', () => {
  const candidates = [
    {
      id: 'chip.eda.viewer',
      domain: 'chip',
      title: 'Viewer',
      stages: ['physical'],
      priority: 10,
      keywords: [],
      skills: [],
      tools: [],
    },
    {
      id: 'chip.eda.run',
      domain: 'chip',
      title: 'Run',
      stages: ['physical'],
      priority: 30,
      keywords: [],
      skills: [],
      tools: [],
    },
  ];
  const result = resolve({ domain: 'chip', stage: 'physical', task: 'make it nice' }, candidates);
  assert.deepEqual(result.scope.capabilityIds, ['chip.eda.run']);
});
