#!/usr/bin/env node
'use strict';

// Explicit internal entry; loads the product frontend with a read-only backend.
// The public main process and live task/session composition are never loaded.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const desktop = path.resolve(__dirname, '../..');
async function launch() {
  const args = process.argv.slice(2);
  const argument = args.indexOf('--replay');
  if (argument < 0 || !args[argument + 1] || args[argument + 1].startsWith('--'))
    throw Error('Usage: launch.cjs --replay <directory or .tar.gz>');
  const legacy = args.includes('--legacy-shell');
  if (legacy || !args.includes('--renderer-dir')) {
    const vite = await import(pathToFileURL(require.resolve('vite', { paths: [desktop] })).href);
    await vite.build({
      root: legacy ? __dirname : desktop,
      configFile: path.join(legacy ? __dirname : desktop, 'vite.config.ts'),
    });
  }
  const electron = require.resolve('electron', { paths: [desktop] });
  const child = spawn(
    require(electron),
    [path.join(__dirname, legacy ? 'main.cjs' : 'product-main.cjs'), ...args],
    {
      cwd: legacy ? desktop : path.resolve(desktop, '../..'),
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    },
  );
  child.on('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
launch().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
