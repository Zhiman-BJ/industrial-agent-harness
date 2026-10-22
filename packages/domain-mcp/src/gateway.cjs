const fs = require('node:fs');
const path = require('node:path');
const {
  builtInPackDirectory,
  packGatewayAdapter,
} = require('@industrial-agent-harness/domain-skills');
function registered(provider) {
  return {
    ...provider,
    installedDirectory: provider.installedDirectory || builtInPackDirectory(provider),
  };
}
function providerRuntime(provider, environment = process.env) {
  const resource = registered(provider);
  return packGatewayAdapter(resource).providerRuntime(resource, environment);
}
function resolveGatewayScript(directory = __dirname) {
  // External Python cannot read Electron's virtual ASAR filesystem.
  const unpacked = directory.replace(/(^|[\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
  const script = path.join(unpacked, 'gateway.py');
  try {
    if (!fs.statSync(script).isFile()) throw Error('Not a regular file.');
    fs.accessSync(script, fs.constants.R_OK);
  } catch {
    throw Error('Domain MCP gateway script is missing or unreadable. Reinstall the application.');
  }
  return script;
}
function gatewayConfig(directory, provider, projectDir, environment, options = {}) {
  if (!projectDir || !path.isAbsolute(projectDir))
    throw Error('Domain MCP requires an explicit absolute project directory.');
  const project = fs.realpathSync(projectDir);
  if (!fs.statSync(project).isDirectory()) throw Error('Domain MCP project must be a directory.');
  const resource = registered(provider);
  return packGatewayAdapter(resource).gatewayConfig(directory, resource, project, environment, {
    ...options,
    gatewayScript: resolveGatewayScript(),
  });
}
module.exports = { providerRuntime, gatewayConfig, resolveGatewayScript };
