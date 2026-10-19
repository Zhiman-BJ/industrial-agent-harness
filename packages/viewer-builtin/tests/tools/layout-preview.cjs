// Local-only acceptance harness: the production Viewer + production KLayout
// service, restricted to generated fixtures. This is not an Electron IPC test.
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../..');
const { RasterService } = require('../../src/layout/raster.cjs');
const { LayoutSourceStore } = require(path.join(root, 'apps/desktop/electron/layout-source.cjs'));
const localRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const fixtureDirectory =
  process.env.LAYOUT_STRESS_FIXTURES || '/tmp/industrial-layout-stress-20261019/fixtures';
const python =
  process.env.KLAYOUT_PYTHON ||
  path.resolve(root, '../industrial-agent-harness/apps/desktop/.venv-klayout/bin/python');

async function main() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(fixtureDirectory, 'manifest.json'), 'utf8'),
  );
  const aliases = {
    complex: 'hierarchy-32',
    hierarchy: 'hierarchy-32',
    flat: 'flat-unique-32',
    polygon: 'complex-polygon-12002',
  };
  const snapshots = new LayoutSourceStore(
    await fs.mkdtemp(path.join(os.tmpdir(), 'layout-preview-snapshots-')),
  );
  let current;
  let opening;
  let worker;
  async function meta(name) {
    name = aliases[name] || name;
    const fixture = manifest.fixtures.find(item => item.name === name);
    if (!fixture) throw Error('Unknown acceptance fixture.');
    // Each page opening starts a new selection, just like Electron layout:open.
    // A reload resets the renderer's generation counter and must not reuse an
    // older worker token whose generation has already advanced.
    if (opening?.name === name) return opening.promise;
    if (opening) throw Error('Another fixture is loading.');
    const promise = (async () => {
      worker?.close();
      await current?.source.close();
      current = undefined;
      const source = await snapshots.prepare({ file: fixture.path, sha256: fixture.sha256 });
      try {
        worker = new RasterService(python);
        const token = crypto.randomUUID();
        const data = await worker.call({ op: 'load', token, path: source.path });
        await source.assertCurrent();
        current = {
          name,
          source,
          meta: { ...data, sourceHash: fixture.sha256 },
          fixture: { name, ...fixture.stats, boxes: fixture.boxes },
        };
        return { ...current.meta, fixture: current.fixture };
      } catch (error) {
        await source.close();
        throw error;
      }
    })();
    opening = { name, promise };
    try {
      return await promise;
    } finally {
      opening = undefined;
    }
  }
  const { createServer } = await import(pathToFileURL(localRequire.resolve('vite')).href);
  const { default: react } = await import(
    pathToFileURL(localRequire.resolve('@vitejs/plugin-react')).href
  );
  const server = await createServer({
    configFile: false,
    root: path.join(root, 'packages/viewer-builtin/tests/preview'),
    resolve: {
      alias: [
        { find: /^react-dom\/client$/, replacement: localRequire.resolve('react-dom/client') },
        { find: /^react-dom$/, replacement: localRequire.resolve('react-dom') },
        { find: /^react$/, replacement: localRequire.resolve('react') },
      ],
    },
    plugins: [
      react(),
      {
        name: 'layout-acceptance-host',
        configureServer(server) {
          server.middlewares.use('/api/layout', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            try {
              const origin = req.headers.origin;
              if (req.method !== 'POST' || (origin && origin !== 'http://127.0.0.1:43125'))
                throw Error('Only local acceptance requests are allowed.');
              let body = '';
              for await (const chunk of req) {
                body += chunk;
                if (body.length > 64 * 1024) throw Error('Request too large.');
              }
              const request = JSON.parse(body || '{}');
              const operation = req.url.split('?')[0].replace(/^\//, '');
              let result;
              if (operation === 'meta') result = await meta(request.fixture || 'complex');
              else {
                const source = current;
                if (!source || request.token !== source.meta.token)
                  throw Error('Layout source changed.');
                await source.source.assertCurrent();
                if (operation === 'cancel') {
                  worker.setGeneration(request.token, request.generation);
                  result = null;
                } else if (operation === 'tile') {
                  result = await worker.call({
                    op: 'tile',
                    token: request.token,
                    generation: request.generation,
                    layer: request.layer,
                    box: request.box,
                    mode: request.mode,
                    pixels: request.pixels,
                  });
                } else if (operation === 'render') {
                  result = await worker.call({
                    op: 'render',
                    token: request.token,
                    box: request.box,
                    visible: request.visible,
                    width: request.width,
                    height: request.height,
                    quality: request.quality,
                    theme: request.theme,
                  });
                } else if (operation === 'geometry') {
                  result = await worker.call({
                    op: 'geometry',
                    token: request.token,
                    box: request.box,
                    visible: request.visible,
                  });
                } else throw Error('Unknown acceptance operation.');
                if (source !== current) throw Error('Layout source changed.');
                await source.source.assertCurrent();
              }
              res.end(JSON.stringify(result));
            } catch (error) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: error.message }));
            }
          });
        },
      },
    ],
    server: { host: '127.0.0.1', port: 43125, strictPort: true, fs: { allow: [root] } },
  });
  await server.listen();
  console.log('Layout acceptance preview: http://127.0.0.1:43125/?fixture=complex');
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    worker?.close();
    await snapshots.close();
    await server.close();
    await fs.rm(snapshots.directory, { recursive: true, force: true });
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
