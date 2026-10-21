const http = require('node:http');
function isRejectedToolResult(message) {
  const rejected = value => {
    if (typeof value === 'string') {
      // Kimi prefixes MCP text with timing metadata. Decode the JSON payload
      // before checking nested diagnostics; a raw substring scan misclassifies
      // the Pack's informational agent_docker_access policy as a rejection.
      const payload = value.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\n/, '');
      try { return rejected(JSON.parse(payload)); } catch {}
      return /rejected|denied/i.test(value.replace(/agent_docker_access:\s*intentionally_denied\b/g, 'policy diagnostic'));
    }
    if (Array.isArray(value)) return value.some(rejected);
    if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) =>
      !(key === 'agent_docker_access' && item === 'intentionally_denied') && (rejected(key) || rejected(item)));
    return false;
  };
  return rejected(message.content);
}

// Controlled model responses exercise the real pinned Kimi runtime and its MCP approvals.
// They do not claim an LLM inference or an industrial signoff.
async function startModel(options = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const results = body.messages.filter(message => message.role === 'tool');
    // Policy diagnostic labels such as `intentionally_denied` are not a
    // rejected tool invocation. Keep actual rejection words fail-closed.
    const rejected = options.stopOnRejection !== false && results.some(isRejectedToolResult);
    const index = options.resultIndex ? options.resultIndex(body) : options.perPrompt ? body.messages.slice(body.messages.findLastIndex(message => message.role === 'user') + 1).filter(message => message.role === 'tool').length : results.length;
    const calls = (typeof options.calls === 'function' ? options.calls(body) : options.calls) || [
      {name: 'domain_tool_describe', arguments: {toolId: 'eda.harness.create_goal'}},
      {name: 'domain_tool_call', arguments: {toolId: 'eda.harness.create_goal', arguments: {description: 'MCP_INTEGRATION_GOAL', constraints: {}, required_verification: []}}},
      {name: 'domain_tool_call', arguments: {toolId: 'eda.harness.get_operational_context', arguments: {}}},
    ];
    const call = !rejected && calls[index];
    if (call) {
      const available = (body.tools || []).map(tool => tool.function.name);
      const matched = available.find(name => name === call.name || name.endsWith(`__${call.name}`));
      if (matched) call.name = matched;
    }
    const success = typeof options.success === 'function' ? options.success(body, requests.length - 1) : options.success;
    const usage = (typeof options.usage === 'function' ? options.usage(body, requests.length - 1) : options.usage) || {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110};
    const stepText = (typeof options.stepText === 'function' ? options.stepText(body, requests.length - 1) : options.stepText) ?? options.beforeTool;
    const thinking = typeof options.thinking === 'function' ? options.thinking(body, requests.length - 1) : options.thinking;
    const message = call ? {role: 'assistant', content: stepText || null, tool_calls: [{id: `mcp-call-${index}`, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}]} : {role: 'assistant', content: rejected ? 'MCP_REJECTED' : success || 'MCP_CONTEXT_CONFIRMED'};
    if (body.stream) {
      response.writeHead(200, {'Content-Type': 'text/event-stream'});
      if (thinking) response.write(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{index: 0, delta: {reasoning_content: thinking}, finish_reason: null}]})}\n\n`);
      if (call && stepText) response.write(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{index: 0, delta: {content: stepText}, finish_reason: null}]})}\n\n`);
      const delta = call ? {role: 'assistant', tool_calls: [{index: 0, ...message.tool_calls[0]}]} : message;
      response.write(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
      response.end(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop'}], usage})}\n\ndata: [DONE]\n\n`);
    } else {response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({id: 'fixture', object: 'chat.completion', created: 1, model: body.model, choices: [{index: 0, message, finish_reason: call ? 'tool_calls' : 'stop'}], usage}));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {endpoint: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => {server.closeAllConnections(); server.close();}};
}
module.exports = {startModel, isRejectedToolResult};
