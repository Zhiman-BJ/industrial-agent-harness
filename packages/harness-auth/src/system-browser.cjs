const { spawn } = require('node:child_process');
const { trustedUrl } = require('./config.cjs');
function openBrowser(url, environment = process.env) {
  const parsed = new URL(url);
  trustedUrl(parsed.origin);
  if (parsed.username || parsed.password) throw Error('Invalid authorization URL.');
  if (
    environment.SSH_CONNECTION ||
    (process.platform === 'linux' && !environment.DISPLAY && !environment.WAYLAND_DISPLAY)
  )
    return;
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false, env: environment });
    child.once('error', resolve);
    child.once('exit', resolve);
  });
}
module.exports = { openBrowser };
