'use strict';

// Fail-on-call test sandbox around the *composed* importer/player, installed
// before either package is loaded. UI JavaScript remains the fixed local UI;
// imported trajectory data never reaches eval, a shell, or a live task API.
function installReplaySafetyGuard() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const calls = { modelCalls: 0, toolCalls: 0, scriptCalls: 0, networkCalls: 0 };
  Module._load = function (request, ...args) {
    let kind;
    if (/(?:agent-kimi|kimi-code)/.test(request)) kind = 'modelCalls';
    else if (/(?:harness-application|domain-runtime|computer-use-bridge)/.test(request))
      kind = 'toolCalls';
    else if (/^(?:node:)?(?:child_process|vm)$/.test(request)) kind = 'scriptCalls';
    else if (/^(?:node:)?(?:http|https|http2|net|tls|dgram)$/.test(request)) kind = 'networkCalls';
    if (kind) {
      calls[kind]++;
      throw Error(`Read-only replay attempted ${kind}: ${request}`);
    }
    return originalLoad.call(this, request, ...args);
  };
  globalThis.fetch = () => {
    calls.networkCalls++;
    throw Error('Read-only replay attempted fetch');
  };
  return {
    calls,
    restore() {
      Module._load = originalLoad;
      globalThis.fetch = originalFetch;
    },
  };
}

module.exports = { installReplaySafetyGuard };
