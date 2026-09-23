const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
function createViewerProtocol(appRoot) {
  const waves = new Map();
  const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};
  function registerWave(file) {
    const canonical = fs.realpathSync(file);
    const id = crypto.randomUUID(); waves.set(id,canonical);
    return `app://viewer/wave/${id}`;
  }
  async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'app:' || !['viewer','surfer'].includes(url.hostname)) return new Response('Forbidden',{status:403});
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const headers = {'Cache-Control':'no-store','Access-Control-Allow-Origin':'app://surfer'};
      if (url.hostname === 'viewer' && relative.startsWith('wave/')) {
        const file = waves.get(relative.slice(5));
        if (!file) return new Response('Unknown waveform',{status:404});
        return new Response(Readable.toWeb(fs.createReadStream(file)),{headers:{...headers,'Content-Type':'application/octet-stream'}});
      }
      const root = fs.realpathSync(url.hostname === 'surfer' ? path.join(__dirname, 'surfer') : path.join(appRoot, 'dist'));
      const file = fs.realpathSync(path.resolve(root, relative || 'index.html'));
      if (!file.startsWith(root + path.sep) || !mime[path.extname(file)]) return new Response('Forbidden',{status:403});
      return new Response(Readable.toWeb(fs.createReadStream(file)),{headers:{...headers,'Content-Type':mime[path.extname(file)]}});
    } catch { return new Response('Not found',{status:404}); }
  }
  return {handle,registerWave,close:()=>waves.clear()};
}
module.exports = {createViewerProtocol};
