const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { startRemoteChatModelFixture } = require('../../scripts/remote-chat-model-fixture.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const CAD = 'cad.freecad.build';
async function conversation(t, options) {
  const fixture = await startRemoteChatModelFixture(options);
  t.after(() => fixture.close());
  const stateId = randomUUID();
  const messages = [
    { role: 'user', content: `Persisted actual DomainState: expectedStateId=${stateId}` },
  ];
  const tools = ['industrial_action_call', 'industrial_artifact_read'].map(name => ({
    type: 'function',
    function: { name: 'mcp__industrial__' + name },
  }));
  const body = () => ({ model: fixture.model, messages, tools, stream: false });
  const post = (value = body(), headers = {}) =>
    fetch(fixture.endpoint + '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + fixture.apiKey,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(value),
    });
  let pending;
  return {
    fixture,
    messages,
    stateId,
    body,
    post,
    async next(result, envelope = false) {
      if (result) {
        assert.ok(pending, 'The test must respond only to an actually issued call.');
        const raw = JSON.stringify(envelope === true ? { output: JSON.stringify(result) } : result);
        messages.push({
          role: 'tool',
          tool_call_id: pending.id,
          content: envelope === 'wall' ? 'Wall time: 0.123 seconds\n' + raw : raw,
        });
      }
      const response = await post();
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      const message = value.choices[0].message;
      messages.push(message);
      pending = message.tool_calls?.[0];
      return pending
        ? { name: pending.function.name, ...JSON.parse(pending.function.arguments) }
        : message.content;
    },
  };
}
function document(kind, value) {
  const content = JSON.stringify(value);
  const ref = { id: randomUUID(), kind, sha256: sha(content) };
  return {
    ref,
    page: {
      artifact: ref,
      content,
      offset: 0,
      totalBytes: Buffer.byteLength(content),
      hasMore: false,
    },
  };
}
function result(refs = [], status = 'not_run') {
  return {
    actionId: randomUUID(),
    actionStatus: 'completed',
    stateId: randomUUID(),
    artifactSet: refs,
    verification: { status },
    diagnostics: [],
  };
}
function inputs(call) {
  return JSON.parse(call.inputsJson);
}
test('controlled responses derive every subsequent state, input byte, review and report from tool results', async t => {
  const c = await conversation(t);
  const recipe = {
    recipe: { parameters: { L: 17 }, features: [], result: 'Fixture' },
    expect: { solids: 1 },
  };
  const source = JSON.stringify(recipe, null, 2) + '\n';
  const file = document('report.files', {
    path: 'recipe.json',
    content: source,
    sha256: sha(source),
  });
  const fileAction = result([file.ref]);
  let call = await c.next();
  assert.equal(call.toolId, 'project.files.read');
  assert.equal(call.expectedStateId, c.stateId);
  assert.deepEqual(inputs(call), { path: 'recipe.json' });
  call = await c.next(fileAction, 'wall');
  assert.equal(call.artifactId, file.ref.id);
  call = await c.next(file.page, 'wall');
  assert.equal(call.toolId, 'project.remote.plan');
  assert.equal(call.expectedStateId, fileAction.stateId);
  assert.deepEqual(inputs(call), { files: ['recipe.json'], tools: [CAD], remember: true });
  const reviewId = randomUUID();
  const plan = document('remote.preparation', {
    status: 'awaiting_batch_approval',
    reviewId,
    remember: true,
    tools: [CAD],
    files: [{ path: 'recipe.json', sha256: sha(source) }],
  });
  const planAction = result([plan.ref]);
  call = await c.next(planAction, true);
  assert.equal(call.artifactId, plan.ref.id);
  call = await c.next(plan.page);
  assert.equal(call.toolId, 'project.remote.prepare');
  assert.equal(call.expectedStateId, planAction.stateId);
  assert.deepEqual(inputs(call), { reviewId });
  const ready = document('remote.preparation', {
    status: 'ready',
    verification: 'not_run',
    tools: [CAD],
  });
  const prepareAction = result([ready.ref]);
  call = await c.next(prepareAction);
  assert.equal(call.artifactId, ready.ref.id);
  call = await c.next(ready.page);
  assert.equal(call.toolId, CAD);
  assert.equal(call.expectedStateId, prepareAction.stateId);
  assert.deepEqual(inputs(call), recipe);
  const report1 = document('report.cad.verify', { volume: 123, passed: true });
  const first = result([report1.ref], 'passed');
  call = await c.next(first);
  assert.equal(call.toolId, 'project.files.apply');
  assert.equal(call.expectedStateId, first.stateId);
  assert.deepEqual(inputs(call), {
    changes: [{ path: 'recipe.json', content: source + '\n', expectedSha256: sha(source) }],
  });
  const edited = result();
  call = await c.next(edited);
  assert.equal(call.toolId, CAD);
  assert.equal(call.expectedStateId, edited.stateId);
  assert.deepEqual(inputs(call), recipe);
  const report2 = document('report.cad.verify', {
    volume: 123,
    passed: true,
    independentlyMeasured: true,
  });
  const second = result([report2.ref], 'passed');
  call = await c.next(second);
  assert.equal(call.artifactId, report2.ref.id);
  const final = await c.next(report2.page);
  assert.ok(
    final.includes(first.actionId) &&
      final.includes(second.actionId) &&
      final.includes(report2.ref.id),
  );
  assert.equal(c.fixture.requests.filter(item => item.action === CAD).length, 2);
  assert.equal(c.fixture.failure, null);
});
test('tool failure stops the fixture rather than retrying, editing or inventing acceptance', async t => {
  const c = await conversation(t);
  await c.next();
  const failed = { ...result(), actionStatus: 'failed', diagnostics: ['Actual remote failure'] };
  c.messages.push({
    role: 'tool',
    tool_call_id: c.messages.at(-1).tool_calls[0].id,
    content: JSON.stringify(failed),
  });
  const response = await c.post();
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /did not complete/);
  assert.equal(c.fixture.requests.length, 1);
  assert.equal((await c.post()).status, 400);
});
test('wrong artifact bytes cannot feed a plan and unknown tool result identities stop the fixture', async t => {
  const c = await conversation(t);
  const file = document('report.files', {
    path: 'recipe.json',
    content: '{}\n',
    sha256: sha('{}\n'),
  });
  await c.next();
  await c.next(result([file.ref]));
  c.messages.push({
    role: 'tool',
    tool_call_id: c.messages.at(-1).tool_calls[0].id,
    content: JSON.stringify({ ...file.page, content: file.page.content + ' ' }),
  });
  assert.equal((await c.post()).status, 400);
  assert.equal(c.fixture.requests.length, 2);
  const other = await conversation(t);
  await other.next();
  other.messages.push({
    role: 'tool',
    tool_call_id: randomUUID(),
    content: JSON.stringify(result()),
  });
  assert.equal((await other.post()).status, 400);
  assert.match(other.fixture.failure, /Unknown tool result identity/);
});
test('only the pinned Kimi timing prefix is accepted; arbitrary logs and native error rendering stop', async t => {
  for (const prefix of [
    'Unrelated tool log\n',
    'Wall time: 0.1 seconds\n',
    'Wall time: 0.123 seconds\n<system>ERROR: Tool execution failed.</system>\n',
  ]) {
    const c = await conversation(t);
    await c.next();
    c.messages.push({
      role: 'tool',
      tool_call_id: c.messages.at(-1).tool_calls[0].id,
      content: prefix + JSON.stringify(result()),
    });
    assert.equal((await c.post()).status, 400);
    assert.equal(c.fixture.requests.length, 1);
  }
});
test('loopback endpoint enforces its random key, route and bounded body and serves OpenAI SSE', async t => {
  const c = await conversation(t, { maxBodyBytes: 2048 });
  assert.match(c.fixture.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(c.fixture.profile.provider, 'openai_legacy');
  assert.equal((await c.post(c.body(), { authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await fetch(c.fixture.endpoint + '/unknown')).status, 404);
  assert.equal((await fetch(c.fixture.endpoint + '/chat/completions')).status, 405);
  assert.equal((await c.post({ ...c.body(), padding: 'x'.repeat(4096) })).status, 413);
  const response = await c.post({ ...c.body(), stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  const chunks = stream
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)));
  assert.equal(
    chunks[0].choices[0].delta.tool_calls[0].function.name,
    'mcp__industrial__industrial_action_call',
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(stream.endsWith('data: [DONE]\n\n'));
  await c.fixture.close();
  await c.fixture.close();
});
