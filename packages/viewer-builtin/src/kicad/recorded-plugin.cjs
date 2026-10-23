'use strict';

const { KiCadRuntimeManager, isKiCadFile } = require('./runtime.cjs');

// Historical documents use the production parser, model loader and renderer.
// No resource provider is installed: opening recorded data cannot download or
// repair absent models. The host verifies its recording's declared hashes.
function createReadOnlyKiCadViewer({ validateOpened } = {}) {
  const runtime = new KiCadRuntimeManager();
  return {
    protocolHosts: Object.freeze(['kicad']),
    plugin: {
      id: 'kicad',
      matches: isKiCadFile,
      async open(context) {
        const { artifact, file, root } = context;
        const data = await runtime.open(file, artifact.sha256, root);
        try {
          await validateOpened?.({ ...context, data }, runtime);
          return { artifact, kind: 'kicad', data };
        } catch (error) {
          runtime.close(data.token);
          throw error;
        }
      },
    },
    handle: request => runtime.handle(request),
    close: token => runtime.close(token),
  };
}

module.exports = { createReadOnlyKiCadViewer };
