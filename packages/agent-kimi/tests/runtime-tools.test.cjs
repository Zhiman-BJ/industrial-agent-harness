const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { runtimeTools } = require('../src/runtime-tools.cjs');

test('JSON input transport preserves nested engineering types without coercion or bypassing Runtime', async () => {
  const received = [];
  const approvalInputs = [];
  const runtime = {
    descriptors: () => [{ id: 'example.edit', risk: 'mutating' }],
    execute: async (request, policy) => {
      received.push({ request, policy });
      return {
        run: { id: randomUUID() },
        action: { id: randomUUID(), status: 'completed', diagnostics: [] },
        artifacts: [],
        verification: { status: 'passed', reason: 'Fixture accepted' },
        state: { id: randomUUID(), status: 'verified' },
        checkpoint: { id: randomUUID() },
      };
    },
  };
  const scope = { tools: ['example.edit'] };
  const action = runtimeTools(
    runtime,
    () => scope,
    async (_descriptor, request) => {
      approvalInputs.push(request.inputs);
      return true;
    },
  ).find(tool => tool.name === 'industrial_action_call');
  const inputs = {
    changes: { parameters: { Width: 30 }, features: [{ id: 'A', origin: [0, 1, 2] }] },
    expect: { bounds: [40, 30, 5], enabled: false },
  };
  const request = {
    toolId: 'example.edit',
    expectedStateId: randomUUID(),
    inputsJson: JSON.stringify(inputs),
  };
  await action.handler(request);
  assert.deepEqual(received[0], {
    request: { toolId: request.toolId, expectedStateId: request.expectedStateId, inputs },
    policy: { scope, approval: true, ownerId: 'project' },
  });
  assert.deepEqual(approvalInputs[0], inputs);
  await action.handler({ ...request, inputsJson: JSON.stringify({ value: '30' }) });
  assert.equal(received[1].request.inputs.value, '30');
  for (const bad of [
    { inputs: {}, inputsJson: '{}' },
    {},
    { inputsJson: '[1,2]' },
    { inputsJson: '{bad' },
    { inputsJson: 'x'.repeat(262145) },
  ])
    await assert.rejects(
      action.handler({ toolId: request.toolId, expectedStateId: request.expectedStateId, ...bad }),
      /inputs|JSON|Supply/,
    );
  assert.equal(received.length, 2);
});

test('approval reviews a separate snapshot; changes while awaiting approval cannot change the executed request', async () => {
  let received;
  const runtime = {
    descriptors: () => [{ id: 'example.edit', risk: 'mutating' }],
    execute: async request => {
      received = request;
      return {
        run: { id: randomUUID() },
        action: { id: randomUUID(), status: 'completed', diagnostics: [] },
        artifacts: [],
        verification: {},
        state: {},
        checkpoint: {},
      };
    },
  };
  const input = { value: 'approved' },
    request = { toolId: 'example.edit', expectedStateId: randomUUID(), inputs: input };
  const tool = runtimeTools(
    runtime,
    () => ({ tools: ['example.edit'] }),
    async (_, preview) => {
      input.value = 'changed by caller';
      preview.inputs.value = 'changed by callback';
      return true;
    },
  ).find(tool => tool.name === 'industrial_action_call');
  await tool.handler(request);
  assert.deepEqual(received.inputs, { value: 'approved' });
});

test('industrial image observations reach image-capable models with unchanged action evidence', async () => {
  const runtime = {
    descriptors: () => [{ id: 'example.view', risk: 'read-only' }],
    execute: async () => ({
      run: { id: randomUUID() },
      action: { id: randomUUID(), status: 'completed', diagnostics: [] },
      artifacts: [],
      verification: { status: 'not_run', reason: 'Observation only' },
      state: { id: randomUUID(), status: 'unverified' },
      checkpoint: { id: randomUUID() },
      images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    }),
  };
  const scope = { tools: ['example.view'] };
  const action = runtimeTools(
    runtime,
    () => scope,
    async () => true,
    () => {},
    { imageInput: true },
  ).find(tool => tool.name === 'industrial_action_call');
  const result = await action.handler({
    toolId: 'example.view',
    expectedStateId: randomUUID(),
    inputs: {},
  });
  assert.equal(result.output[0].type, 'text');
  assert.equal(JSON.parse(result.output[0].text).verification.status, 'not_run');
  assert.deepEqual(result.output[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
  });
});
