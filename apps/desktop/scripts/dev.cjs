const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// Optional local-only overrides (INDUSTRIAL_MODEL_API_KEY, …); never committed.
try {
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  // No .env.local is fine; the app then uses its regular keychain profile.
}
// Spawn the JS entry points directly: on Windows, pnpm/vite shims are .cmd
// files which Node cannot spawn without a shell wrapper. vite's exports map
// hides ./bin/vite.js, so resolve the package root and join the path instead.
const vitePkg = require.resolve('vite/package.json', { paths: [root] });
const viteBin = path.join(path.dirname(vitePkg), 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1'], {
  cwd: root,
  stdio: 'inherit',
});
vite.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});
let electron;
async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (vite.exitCode !== null) throw Error('Vite stopped before the desktop could start.');
    try {
      await new Promise((resolve, reject) =>
        http
          .get('http://127.0.0.1:5173/', response => {
            response.resume();
            response.statusCode === 200 ? resolve() : reject(Error(String(response.statusCode)));
          })
          .on('error', reject),
      );
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw Error('Vite did not start.');
}
ready()
  .then(() => {
    const electronBin = require('electron');
    electron = spawn(electronBin, ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, INDUSTRIAL_DEV_URL: 'http://127.0.0.1:5173/' },
    });
    electron.on('error', error => {
      console.error(error);
      vite.kill();
      process.exitCode = 1;
    });
    electron.on('exit', code => {
      vite.kill();
      process.exitCode = code ?? 1;
    });
  })
  .catch(error => {
    console.error(error);
    vite.kill();
    process.exitCode = 1;
  });
process.on('SIGINT', () => {
  electron?.kill();
  vite.kill();
});
process.on('SIGTERM', () => {
  electron?.kill();
  vite.kill();
});
