'use strict';
// Acceptance-only model fixture. Kimi, Runtime and remote execution remain real;
// every identity and result below is taken from the tools' actual responses.
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const FILE = 'recipe.json';
const CAD = 'cad.freecad.build';
const ACTION = 'industrial_action_call';
const ARTIFACT = 'industrial_artifact_read';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
function error(status, message) {
  return Object.assign(Error(message), { status });
}
function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(part => part.type === 'text'))
    return content.map(part => part.text).join('\n');
  throw Error('Expected a text-only model message.');
}
function object(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.');
  return value;
}
function toolValue(message) {
  // Pinned Kimi 2.1.1 toolResultRender.ts prepends exactly this timing line to
  // MCP output. Its successful renderStatus leaves the following JSON intact.
  // Do not search for an arbitrary JSON substring or accept the error renderer.
  const rendered = text(message.content).replace(/^Wall time: \d+\.\d{3} seconds\n/, '');
  assert.ok(!rendered.startsWith('<system>ERROR:'), 'The actual Kimi tool failed.');
  let value = JSON.parse(rendered);
  for (let i = 0; i < 3; i++) {
    object(value);
    assert.ok(value.is_error !== true && value.isError !== true, 'The actual tool failed.');
    if (typeof value.output === 'string') value = JSON.parse(value.output);
    else return value;
  }
  throw Error('Unknown tool response envelope.');
}
function reference(result, kind) {
  assert.ok(Array.isArray(result.artifactSet), 'Actual action artifacts are missing.');
  const ref = result.artifactSet.find(item =>
    kind ? item.kind === kind : item.kind.startsWith('report.'),
  );
  assert.ok(
    ref && UUID.test(ref.id) && /^[a-f0-9]{64}$/.test(ref.sha256),
    'Actual report reference missing.',
  );
  return ref;
}
function page(result, ref) {
  assert.equal(result.artifact?.id, ref.id, 'Artifact identity changed.');
  assert.equal(result.artifact?.kind, ref.kind, 'Artifact kind changed.');
  assert.equal(result.artifact?.sha256, ref.sha256, 'Artifact digest changed.');
  assert.equal(result.offset, 0);
  assert.equal(result.hasMore, false, 'Acceptance report exceeds the bounded read.');
  assert.equal(typeof result.content, 'string');
  assert.equal(Buffer.byteLength(result.content), result.totalBytes);
  assert.equal(
    sha(result.content),
    ref.sha256,
    'Artifact bytes do not match the actual reference.',
  );
  return object(JSON.parse(result.content));
}
function action(result, data, engineering = false) {
  assert.equal(
    result.actionStatus,
    'completed',
    'Actual action did not complete; do not retry it.',
  );
  assert.ok(
    UUID.test(result.actionId) && UUID.test(result.stateId),
    'Actual action/state identities missing.',
  );
  assert.ok(
    ['not_run', 'passed'].includes(result.verification?.status),
    'Actual action verification failed or is unknown.',
  );
  if (engineering) {
    assert.equal(result.verification?.status, 'passed', 'Actual remote verification did not pass.');
    assert.ok(result.artifactSet?.length, 'Actual remote evidence is missing.');
  }
  data.stateId = result.stateId;
}
function consume(stage, result, data) {
  if ([0, 2, 4, 6, 7, 8].includes(stage)) action(result, data, stage === 6 || stage === 8);
  if (stage === 0) data.fileReport = reference(result, 'report.files');
  else if (stage === 1) {
    const file = page(result, data.fileReport);
    assert.equal(file.path, FILE);
    assert.equal(typeof file.content, 'string');
    assert.equal(file.sha256, sha(file.content), 'Input content/hash mismatch.');
    const inputs = object(JSON.parse(file.content));
    object(inputs.recipe);
    object(inputs.expect);
    assert.deepEqual(Object.keys(inputs).sort(), ['expect', 'recipe']);
    data.source = file.content;
    data.inputHash = file.sha256;
    data.inputs = inputs;
  } else if (stage === 2) data.planReport = reference(result, 'remote.preparation');
  else if (stage === 3) {
    const plan = page(result, data.planReport);
    assert.equal(plan.status, 'awaiting_batch_approval');
    assert.ok(UUID.test(plan.reviewId), 'Actual plan reviewId is missing.');
    assert.equal(plan.remember, true);
    assert.deepEqual(plan.tools, [CAD]);
    assert.deepEqual(
      plan.files.map(file => ({ path: file.path, sha256: file.sha256 })),
      [{ path: FILE, sha256: data.inputHash }],
    );
    data.reviewId = plan.reviewId;
  } else if (stage === 4) {
    assert.equal(
      result.verification?.status,
      'not_run',
      'Ready must not claim engineering acceptance.',
    );
    data.readyReport = reference(result, 'remote.preparation');
  } else if (stage === 5) {
    const ready = page(result, data.readyReport);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.verification, 'not_run');
    assert.deepEqual(ready.tools, [CAD]);
  } else if (stage === 6) data.first = result;
  else if (stage === 8) {
    assert.notEqual(result.actionId, data.first.actionId, 'The two CAD actions must be distinct.');
    data.second = result;
    data.remoteReport = reference(result);
  } else if (stage === 9) {
    page(result, data.remoteReport);
    data.reportRead = true;
  }
}
function requestFor(stage, data) {
  const call = (toolId, inputs) => ({
    tool: ACTION,
    args: { toolId, inputsJson: JSON.stringify(inputs), expectedStateId: data.stateId },
  });
  const read = ref => ({ tool: ARTIFACT, args: { artifactId: ref.id, limit: 65536 } });
  switch (stage) {
    case 0:
      return call('project.files.read', { path: FILE });
    case 1:
      return read(data.fileReport);
    case 2:
      return call('project.remote.plan', { files: [FILE], tools: [CAD], remember: true });
    case 3:
      return read(data.planReport);
    case 4:
      return call('project.remote.prepare', { reviewId: data.reviewId });
    case 5:
      return read(data.readyReport);
    case 6:
      return call(CAD, data.inputs);
    case 7:
      return call('project.files.apply', {
        changes: [{ path: FILE, content: data.source + '\n', expectedSha256: data.inputHash }],
      });
    case 8:
      return call(CAD, data.inputs);
    case 9:
      return read(data.remoteReport);
    case 10:
      assert.ok(data.reportRead && data.first && data.second);
      return {
        content: `两次真实远端 CAD 验证均为 passed。actionId：${data.first.actionId}、${data.second.actionId}。已读取实际报告 artifact ${data.remoteReport.id}（${data.remoteReport.kind}）。`,
      };
    default:
      throw Error('This acceptance is complete; no third CAD call is allowed.');
  }
}
function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        request.pause();
        reject(error(413, 'Model fixture request body exceeds its limit.'));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(error(400, 'Invalid JSON model request.'));
      }
    });
    request.once('error', reject);
  });
}
async function startRemoteChatModelFixture({ maxBodyBytes = 2 * 1024 * 1024 } = {}) {
  assert.ok(
    Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 && maxBodyBytes <= 16 * 1024 * 1024,
  );
  const apiKey = 'local-model-' + randomBytes(32).toString('hex');
  const model = 'remote-chat-controlled-fixture';
  const issued = [],
    requests = [],
    data = {};
  let previous, fatal, closed;
  function completion(body) {
    object(body);
    if (fatal) throw fatal;
    assert.equal(body.model, model, 'Unexpected model.');
    assert.ok(Array.isArray(body.messages) && body.messages.length, 'Model messages are missing.');
    const digest = sha(JSON.stringify(body));
    if (previous?.digest === digest) return previous.response;
    const results = body.messages.filter(message => message.role === 'tool');
    const calls = body.messages.flatMap(message =>
      message.role === 'assistant' ? message.tool_calls || [] : [],
    );
    assert.equal(results.length, issued.length, 'Missing, unexpected or repeated tool responses.');
    assert.equal(calls.length, issued.length, 'Unknown or repeated assistant tool calls.');
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].tool_call_id, issued[i].id, 'Unknown tool result identity.');
      const call = calls.filter(item => item.id === issued[i].id);
      assert.equal(call.length, 1, 'Issued tool call is missing or duplicated.');
      assert.equal(call[0].function.name, issued[i].name);
      assert.deepEqual(JSON.parse(call[0].function.arguments), issued[i].args);
    }
    if (!issued.length) {
      const matches = body.messages.flatMap(message => [
        ...text(message.content || '').matchAll(/expectedStateId=([a-f0-9-]{36})/gi),
      ]);
      data.stateId = matches.at(-1)?.[1];
      assert.ok(UUID.test(data.stateId || ''), 'Initial actual DomainState identity is missing.');
    } else consume(issued.length - 1, toolValue(results.at(-1)), data);
    const next = requestFor(issued.length, data);
    let message;
    if (next.tool) {
      const names = (body.tools || []).map(tool => tool.function?.name).filter(Boolean);
      const matches = names.filter(name => name === next.tool || name.endsWith('__' + next.tool));
      assert.equal(
        matches.length,
        1,
        'Required actual Kimi industrial tool is not uniquely available.',
      );
      const call = { id: 'remote-chat-' + randomUUID(), name: matches[0], args: next.args };
      issued.push(call);
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      };
    } else message = { role: 'assistant', content: next.content };
    requests.push({
      step: requests.length,
      tool: next.tool || null,
      action: next.args?.toolId || null,
    });
    const response = {
      id: 'completion-' + randomUUID(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: next.tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
    previous = { digest, response };
    return response;
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url !== '/v1/chat/completions') throw error(404, 'Unknown model fixture route.');
      if (request.method !== 'POST') throw error(405, 'Only POST chat completions are supported.');
      if (request.headers.authorization !== 'Bearer ' + apiKey)
        throw error(401, 'Invalid model fixture credential.');
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))
        throw error(415, 'Expected application/json.');
      const length = request.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes))
        throw error(413, 'Model fixture request body exceeds its limit.');
      const body = await readBody(request, maxBodyBytes);
      let result;
      try {
        result = completion(body);
      } catch (failure) {
        fatal ||= failure;
        throw error(400, failure.message);
      }
      if (body.stream) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        });
        const { message, finish_reason } = result.choices[0];
        const delta = message.tool_calls
          ? {
              role: 'assistant',
              tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
            }
          : message;
        const chunk = {
          id: result.id,
          object: 'chat.completion.chunk',
          created: result.created,
          model,
        };
        response.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason }], usage: result.usage })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(result));
      }
    } catch (failure) {
      if (response.headersSent) return response.destroy();
      response.writeHead(failure.status || 400, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      response.end(
        JSON.stringify({
          error: { type: 'controlled_model_fixture_error', message: failure.message },
        }),
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    endpoint,
    apiKey,
    model,
    provider: 'openai_legacy',
    requests,
    profile: { endpoint, model, provider: 'openai_legacy', thinking: false },
    get failure() {
      return fatal?.message || null;
    },
    close() {
      if (!closed)
        closed = new Promise((resolve, reject) => {
          server.close(failure => (failure ? reject(failure) : resolve()));
          server.closeAllConnections();
        });
      return closed;
    },
  };
}
module.exports = { startRemoteChatModelFixture };
