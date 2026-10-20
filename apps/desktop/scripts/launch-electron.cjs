const path = require('node:path');
const { spawn } = require('node:child_process');
const { requireGuiStartup } = require('./gui-startup.cjs');
const desktopRoot = path.resolve(__dirname, '..');

function launchElectron(
  args = [],
  {
    env = process.env,
    preflight = requireGuiStartup,
    spawnProcess = spawn,
    resolveElectron = () => require('electron'),
  } = {},
) {
  preflight();
  return spawnProcess(resolveElectron(), [desktopRoot, ...args], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env,
  });
}

if (require.main === module) {
  try {
    const child = launchElectron(process.argv.slice(2));
    child.on('error', error => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      if (signal)
        console.error(`Electron exited with ${signal}; it will not be restarted automatically.`);
      process.exitCode = code ?? 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { launchElectron };
