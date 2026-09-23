const {spawn} = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1'], {cwd: root, stdio: 'inherit'});
let electron;
async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (vite.exitCode !== null) throw Error('Vite stopped before the desktop could start.');
    try {
      await new Promise((resolve, reject) => http.get('http://127.0.0.1:5173/', response => {response.resume(); response.statusCode === 200 ? resolve() : reject(Error(String(response.statusCode)));}).on('error', reject));
      return;
    } catch {await new Promise(resolve => setTimeout(resolve, 250));}
  }
  throw Error('Vite did not start.');
}
ready().then(() => {
  electron = spawn('pnpm', ['exec', 'electron', '.'], {cwd: root, stdio: 'inherit', env: {...process.env, INDUSTRIAL_DEV_URL: 'http://127.0.0.1:5173/'}});
  electron.on('exit', code => {vite.kill(); process.exitCode = code ?? 1;});
}).catch(error => {console.error(error); vite.kill(); process.exitCode = 1;});
process.on('SIGINT', () => {electron?.kill(); vite.kill();});
process.on('SIGTERM', () => {electron?.kill(); vite.kill();});
