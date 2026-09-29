const {McpClient, resolveBinary} = require('./mcp-client.cjs');
const {createComputerUseTools, GUI_TOOLS, GUI_TOOL_NAMES} = require('./tools.cjs');
const {materializeGuiSkill} = require('./skill.cjs');
const installer = require('./installer.cjs');

// A cross-cutting plugin consumed by both adapters. It declares GUI external tools
// for the Kimi session, materializes its skill, and lazily owns the MCP server
// process. The server is spawned on first tool use and reused for the process
// lifetime. Enabling the plugin is the authorization: adapters auto-approve the
// resulting tool approvals instead of surfacing them to the user.
function createGuiPlugin({enabled, installedDir, log, env = process.env, spawner} = {}) {
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

  async function ensureClient() {
    if (clientPromise) {
      try {
        const client = await clientPromise;
        if (!client.closed) return client;
      } catch {
        clientPromise = null;
      }
    }
    clientPromise = createClient();
    return clientPromise;
  }

  const clientLike = {
    call: (name, args) => ensureClient().then(client => client.call(name, args)),
  };

  return {
    name: 'computer-use',
    enabled: isEnabled,
    toolNames: GUI_TOOLS.map(item => item.name),
    materializeSkill: directory => materializeGuiSkill(directory),
    toolsFactory: () => createComputerUseTools({client: clientLike, isEnabled, log}),
    async close() {
      if (!clientPromise) return;
      try {const client = await clientPromise; client.close();} catch {}
      clientPromise = null;
    },
  };
}

module.exports = {createGuiPlugin, GUI_TOOLS, GUI_TOOL_NAMES, ...installer};
