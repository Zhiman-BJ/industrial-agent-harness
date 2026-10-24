'use strict';

const { KiCadRuntimeManager, isKiCadFile } = require('./runtime.cjs');
const { recordedOcctGlue } = require('./recorded-occt.cjs');

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
    async handle(request) {
      // Let the production runtime authorize the token, method, source hashes
      // and exact asset path before adapting the one pinned JavaScript asset.
      const response = await runtime.handle(request);
      if (
        response.ok &&
        new URL(request.url).pathname.endsWith('/vendor/occt-import/occt-import-js.js')
      ) {
        try {
          return new Response(recordedOcctGlue(Buffer.from(await response.arrayBuffer())), {
            status: response.status,
            headers: response.headers,
          });
        } catch {
          return new Response('Recorded STEP parser unavailable.', {
            status: 409,
            headers: response.headers,
          });
        }
      }
      return response;
    },
    close: token => runtime.close(token),
  };
}

module.exports = { createReadOnlyKiCadViewer };
