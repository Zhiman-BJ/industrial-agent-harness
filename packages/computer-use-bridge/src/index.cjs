const {McpClient, resolveBinary} = require('./mcp-client.cjs');
const {createComputerUseTools, GUI_TOOLS, GUI_TOOL_NAMES} = require('./tools.cjs');
const {materializeGuiSkill} = require('./skill.cjs');
const installer = require('./installer.cjs');

// A cross-cutting plugin consumed by both adapters. It declares GUI external tools
// for the Kimi session, materializes its skill, and lazily owns the MCP server
// process. The server is spawned on first tool use and reused for the process
// lifetime. Enabling the plugin is the authorization: adapters auto-approve the
// resulting tool approvals instead of surfacing them to the user.
function createGuiPlugin({enabled, installedDir, log, env = process.env, spawner, queueWaitMs = 30000} = {}) {
  let clientPromise = null;
  const isEnabled = () => (typeof enabled === 'function' ? enabled() : Boolean(enabled));

  function createClient() {
    const bin = resolveBinary(installedDir, env);
    const options = {env: {}};
    if (spawner) options.spawner = spawner;
    const client = new McpClient(bin, options);
    return client.initialize().then(() => client, error => {
      client.close();
      throw error;
    });
  }

  // A failed spawn must not poison the cache for later callers: clear it only
  // while no newer attempt replaced it.
  function spawnClient() {
    const promise = createClient();
    promise.catch(() => {if (clientPromise === promise) clientPromise = null;});
    return promise;
  }

  async function ensureClient() {
    if (!clientPromise) clientPromise = spawnClient();
    let client = await clientPromise;
    // A client whose server already died is marked closed (mcp-client die()):
    // drop it and rebuild once instead of reusing a permanently broken pipe.
    if (client.closed) {
      clientPromise = spawnClient();
      client = await clientPromise;
    }
    return client;
  }

  // Every session shares one server driving ONE physical desktop (mouse,
  // keyboard, focus, clipboard), and a turn may also issue parallel tool
  // calls. Interleaved input injection across those callers is uncontrolled,
  // so calls serialize through a FIFO queue. The lock is per call, not per
  // session: a queued caller merely awaits its turn (nothing blocks), and one
  // that exceeds its wait budget abandons the slot with an actionable error
  // so the model can retry later or reach the same goal via a non-GUI tool.
  // Execution itself keeps McpClient's per-call timeout; an abandoned wait
  // never cancels an already-started physical action.
  let queueTail = Promise.resolve();
  const clientLike = {
    call: (name, args) => new Promise((resolve, reject) => {
      const previous = queueTail;
      let advance;
      queueTail = new Promise(resolveSlot => {advance = resolveSlot;});
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        advance();
        reject(new Error(`Computer use is busy with another session; gave up waiting for ${name} after ${queueWaitMs}ms. Retry later, or complete this step with a non-GUI tool.`));
      }, queueWaitMs);
      previous.then(() => {
        if (settled) {advance(); return;}
        clearTimeout(timer);
        ensureClient().then(client => client.call(name, args)).then(
          value => {settled = true; advance(); resolve(value);},
          error => {settled = true; advance(); reject(error);}
        );
      });
    }),
  };

  return {
    name: 'computer-use',
    clientLike,
    enabled: isEnabled,
    toolNames: GUI_TOOLS.map(item => item.name),
    materializeSkill: directory => materializeGuiSkill(directory),
    // Each Kimi session builds its tools through this factory. An optional
    // per-session log sink routes tool-call records to the calling chat's
    // broker trace; without one the shared `log` callback applies.
    toolsFactory: (sessionLog) => createComputerUseTools({client: clientLike, isEnabled, log: sessionLog || log}),
    async close() {
      if (!clientPromise) return;
      try {const client = await clientPromise; client.close();} catch {}
      clientPromise = null;
    },
  };
}

module.exports = {createGuiPlugin, GUI_TOOLS, GUI_TOOL_NAMES, ...installer};
