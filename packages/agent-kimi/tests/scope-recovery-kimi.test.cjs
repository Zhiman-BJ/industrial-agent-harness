const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KimiSession } = require('../src/index.cjs');
const { validateProfile, writeCliConfig, sessionEnv } = require('../src/model-config.cjs');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');

function modelToolOutput(message) {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n');
  // The native MCP tool prefixes its text result with timing metadata.
  return JSON.parse(text.slice(text.indexOf('{')));
}

async function recoverScope(t, replaceWhileAwaitingApproval) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scope-recovery-'));
  let scope = {
    domain: 'test',
    stage: 'test',
    version: 'scope-before-approval',
    capabilityIds: ['controlled.initial'],
    skills: [],
    tools: [],
  };
  const initialId = replaceWhileAwaitingApproval ? scope.capabilityIds[0] : 'controlled.unknown';
  const disclosed = [];
  const observed = [];
  const events = [];
  const approvals = [];
  const call = capabilityId => ({
    name: 'industrial_capability_detail',
    arguments: { capabilityId, section: 'tools' },
  });
  const model = await startModel({
    stopOnRejection: false,
    calls: body => {
      const results = body.messages.filter(message => message.role === 'tool');
      if (!results.length) return [call(initialId)];
      if (results.length === 1) {
        const result = modelToolOutput(results[0]);
        observed.push({ result, disclosed: [...disclosed] });
        // The retry is selected from the actual error returned to the model,
        // rather than from test-side knowledge of the host's scope.
        return [null, call(result.allowedCapabilityIds?.[0] || 'controlled.no-recovery-id')];
      }
      return [];
    },
    success: 'SCOPE_RECOVERY_COMPLETE',
  });
  const profile = validateProfile({
    provider: 'openai_legacy',
    endpoint: model.endpoint,
    model: 'controlled',
    contextSize: 32768,
    thinking: false,
  });
  const runtime = {
    profile,
    apiKey: 'controlled-local-key',
    shareDir: writeCliConfig(root, profile),
    env: sessionEnv(profile, 'controlled-local-key'),
    revision: 0,
  };
  const session = new KimiSession(
    root,
    () => scope,
    async () => null,
    capabilityId => {
      disclosed.push(capabilityId);
      return { capability: capabilityId, tools: [{ id: 'controlled.read' }] };
    },
    event => {
      events.push(event);
      if (event.type !== 'approval') return;
      if (replaceWhileAwaitingApproval && approvals.length === 0) {
        scope = {
          ...scope,
          version: 'scope-during-approval',
          capabilityIds: ['controlled.replacement'],
        };
      }
      approvals.push(session.approve(event.id, 'approve'));
    },
    () => runtime,
    undefined,
    { directory: path.join(root, 'logs') },
  );
  t.after(async () => {
    try {
      await session.close();
    } finally {
      model.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await session.run('Read the selected capability details.');
  await Promise.all(approvals);

  assert.deepEqual(
    events.filter(event => event.type === 'error'),
    [],
  );
  assert.equal(events.find(event => event.type === 'done')?.result.status, 'finished');
  assert.equal(model.requests.length, 3);
  assert.equal(approvals.length, 2, 'both attempts retain the native approval boundary');
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].disclosed, [], 'the rejected call never reads capability details');
  const failure = observed[0].result;
  assert.equal(failure.code, 'CAPABILITY_OUT_OF_SCOPE');
  assert.match(failure.message, /outside the current Broker scope/);
  assert.equal(failure.requestedCapabilityId, initialId);
  assert.deepEqual(failure.allowedCapabilityIds, scope.capabilityIds);
  assert.equal(failure.scopeVersion, scope.version);
  assert.match(failure.nextStep, /allowedCapabilityIds/);
  assert.deepEqual(disclosed, [scope.capabilityIds[0]]);

  const results = events.filter(event => event.type === 'tool-result');
  assert.equal(results.length, 2);
  assert.equal(results[0].error, true, 'MCP and Harness preserve the scope rejection error flag');
  assert.deepEqual(modelToolOutput({ content: results[0].output }), failure);
  assert.equal(results[1].error, false);
  assert.deepEqual(modelToolOutput({ content: results[1].output }), {
    capability: scope.capabilityIds[0],
    tools: [{ id: 'controlled.read' }],
  });
  assert.equal(
    events
      .filter(event => event.type === 'text')
      .map(event => event.text)
      .join(''),
    'SCOPE_RECOVERY_COMPLETE',
  );
}

test(
  'pinned Kimi recovers an unknown capability ID from the current Broker IDs without disclosing the rejected capability',
  { timeout: 30000 },
  t => recoverScope(t, false),
);

test(
  'pinned Kimi rechecks scope after approval and recovers using the replacement IDs and version',
  { timeout: 30000 },
  t => recoverScope(t, true),
);
