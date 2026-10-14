// Optional deterministic transport for environments that prohibit socket listening.
// Uses the same request handlers and real openid-client/JWKS/signature processing.
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const servers = new Map();
let port = 19000;
function createServer(handler) {
  const server = new EventEmitter();
  server.pending = new Set();
  server.listen = (_port, host, callback) => {
    if (host !== '127.0.0.1') throw Error('Expected a loopback-only listener.');
    server.port = ++port;
    servers.set(server.port, server);
    queueMicrotask(callback);
  };
  server.address = () => ({ port: server.port });
  server.close = () => servers.delete(server.port);
  server.closeAllConnections = () => {
    for (const fail of server.pending) fail(Error('Connection closed.'));
  };
  server.handler = handler;
  return server;
}
async function fetch(input, init = {}) {
  const url = new URL(input);
  const server = servers.get(Number(url.port));
  if (!server) throw Error('Connection refused.');
  return new Promise((resolve, reject) => {
    server.pending.add(reject);
    const headers = Object.fromEntries(new Headers(init.headers));
    headers.host = url.host;
    const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []);
    req.url = url.pathname + url.search;
    req.method = init.method || 'GET';
    req.headers = headers;
    req.socket = { destroy: () => reject(Error('Connection lost.')) };
    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    res.on('error', reject);
    res.status = 200;
    res.headers = {};
    res.headersSent = false;
    res.writeHead = (status, values) => {
      res.status = status;
      res.headers = values;
      res.headersSent = true;
      return res;
    };
    res.on('finish', () => {
      server.pending.delete(reject);
      resolve(new Response(Buffer.concat(chunks), { status: res.status, headers: res.headers }));
    });
    Promise.resolve(server.handler(req, res)).catch(reject);
  });
}
module.exports =
  process.env.AUTH_TEST_TRANSPORT === 'memory'
    ? { createServer, fetch }
    : { createServer: require('node:http').createServer, fetch: global.fetch };
