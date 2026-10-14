const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// A narrow loopback transport for kernels whose model key is fixed at startup.
// Only this trusted process sees rotating platform credentials.
async function createModelProxy({ auth, fetch = global.fetch, createServer = http.createServer }) {
  const base = auth.config.modelBaseUrl;
  if (!base || !auth.view().user)
    throw Error('Sign in and configure the platform model service first.');
  const subject = auth.view().user.sub;
  const key = crypto.randomBytes(32).toString('base64url');
  const active = new Set();
  let origin;
  const server = createServer(async (request, response) => {
    const reply = status => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(
        JSON.stringify({
          error: { message: 'Platform model request unavailable.', type: 'platform_auth_error' },
        }),
      );
    };
    if (
      request.headers.host !== new URL(origin).host ||
      request.headers.origin ||
      request.headers.authorization !== `Bearer ${key}`
    )
      return reply(401);
    const routes = new Map([
      ['POST /v1/chat/completions', 'chat/completions'],
      ['POST /v1/messages', 'messages'],
      ['GET /v1/models', 'models'],
    ]);
    const route = routes.get(`${request.method} ${request.url}`);
    if (!route) return reply(404);
    if (auth.view().user?.sub !== subject) return reply(401);
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    response.once('close', abort);
    const timeout = setTimeout(abort, 3600000);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1048576) return reply(413);
        chunks.push(chunk);
      }
      const token = await auth.serviceToken('model', base);
      if (auth.view().user?.sub !== subject) return reply(401);
      const upstream = await fetch(base + '/' + route, {
        method: request.method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(request.headers['anthropic-version']
            ? { 'anthropic-version': request.headers['anthropic-version'] }
            : {}),
        },
        body: request.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply(upstream.status);
      }
      response.writeHead(200, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch {
      if (!response.headersSent) reply(503);
      else response.destroy();
    } finally {
      clearTimeout(timeout);
      active.delete(controller);
      response.removeListener('close', abort);
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint: origin + '/v1',
    apiKey: key,
    close: () => {
      for (const controller of active) controller.abort();
      server.close();
      server.closeAllConnections();
    },
  };
}
module.exports = { createModelProxy };
