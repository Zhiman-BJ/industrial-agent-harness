#!/usr/bin/env node
'use strict';

// Explicit internal entry; never loads the public Desktop composition root.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const desktop = path.resolve(__dirname, '../..');
async function launch() {
  const args = process.argv.slice(2);
  const argument = args.indexOf('--replay');
  if (argument < 0 || !args[argument + 1] || args[argument + 1].startsWith('--'))
    throw Error('Usage: launch.cjs --replay <directory or .tar.gz>');
  // Source launches always build this isolated renderer first. The public
  // Desktop renderer and its task/session composition are never loaded.
  const vite = await import(pathToFileURL(require.resolve('vite', { paths: [desktop] })).href);
  await vite.build({ configFile: path.join(__dirname, 'vite.config.ts') });
  const electron = require.resolve('electron', { paths: [desktop] });
  const child = spawn(require(electron), [path.join(__dirname, 'main.cjs'), ...args], {
    cwd: desktop,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
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
