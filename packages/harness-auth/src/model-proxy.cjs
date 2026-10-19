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
  const explanations = {
    401: 'Platform sign-in is no longer valid. Sign in again.',
    402: 'Platform balance is insufficient. Top up in the Obol console.',
    403: 'This account cannot use the platform model service.',
    429: 'Platform model request limit reached. Try again later.',
  };
  let origin;
  const server = createServer(async (request, response) => {
    const reply = (status, retryAfter) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(retryAfter && /^\d{1,6}$/.test(retryAfter) ? { 'Retry-After': retryAfter } : {}),
      });
      response.end(
        JSON.stringify({
          error: {
            message: explanations[status] || 'Platform model request unavailable.',
            type: 'platform_auth_error',
          },
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
      const body = request.method === 'POST' ? Buffer.concat(chunks) : undefined;
      const send = async rejectedToken => {
        const token = await auth.serviceToken('model', base, { rejectedToken });
        if (auth.view().user?.sub !== subject || controller.signal.aborted)
          throw Object.assign(Error('Account changed.'), { code: 'login_required' });
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
          body,
        });
        return { upstream, token };
      };
      let sent = await send();
      // Only an explicit authentication rejection establishes that inference did
      // not start. Never replay after an ambiguous transport failure or plain 401.
      if (
        sent.upstream.status === 401 &&
        /^Bearer\s/i.test(sent.upstream.headers.get('www-authenticate') || '') &&
        /\berror="invalid_token"/i.test(sent.upstream.headers.get('www-authenticate') || '')
      ) {
        await sent.upstream.body?.cancel();
        sent = await send(sent.token);
      }
      const { upstream } = sent;
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply(upstream.status, upstream.headers.get('retry-after'));
      }
      response.writeHead(200, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch (error) {
      if (!response.headersSent)
        reply(
          error?.code === 'service_denied'
            ? 403
            : ['login_required', 'cancelled'].includes(error?.code)
              ? 401
              : 503,
        );
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
