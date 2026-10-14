const path = require('node:path');
const { openBrowser } = require('@industrial-agent-harness/harness-auth/src/system-browser.cjs');
const {
  AuthManager,
  SessionStore,
  authDirectory,
  readConfig,
} = require('@industrial-agent-harness/harness-auth');

function createCliAccount(environment = process.env, allowFileStore = false) {
  const directory = authDirectory(environment);
  return new AuthManager({
    config: readConfig(directory, environment),
    store: new SessionStore({
      directory: path.join(directory, 'cli'),
      allowPlaintext: allowFileStore,
    }),
  });
}
const usage = `industrial-harness account login|status|logout [--no-browser] [--allow-file-store]

Uses standard OIDC authorization code + PKCE through the system browser.
Set INDUSTRIAL_AUTH_CLIENT_ID to a registered Obol native client with loopback callbacks enabled.
Optional: INDUSTRIAL_AUTH_ISSUER (default https://auth.zhiman.cn), INDUSTRIAL_AUTH_AUDIENCE.
CLI persistence requires explicit --allow-file-store (private 0600 credential file).
Without it, credentials remain in memory for this command only.
--no-browser prints a login URL; open it on the same machine (loopback callback).
Desktop uses OS-encrypted storage and a separate session. No tokens are printed.
`;
async function runAccount(argv, output = process.stdout, environment = process.env, options = {}) {
  const [command, ...flags] = argv;
  if (!command || ['-h', '--help'].includes(command)) {
    output.write(usage);
    return 0;
  }
  if (
    !['login', 'status', 'logout'].includes(command) ||
    flags.some(flag => !['--no-browser', '--allow-file-store'].includes(flag))
  )
    throw Error('Invalid account command.');
  const auth = options.auth || createCliAccount(environment, flags.includes('--allow-file-store'));
  const send = value => output.write(JSON.stringify(value) + '\n');
  const cancel = () => auth.cancel();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    // Logout must still clear a damaged credential file that restore cannot read.
    if (command !== 'logout') await auth.restore();
    if (command === 'login') {
      auth.once('authorization', url =>
        send({ type: 'account_authorization', url, callback: 'same-machine-loopback' }),
      );
      await auth.login({
        openBrowser: flags.includes('--no-browser')
          ? undefined
          : url => openBrowser(url, environment),
      });
      send({ type: 'account', ...auth.view() });
    } else if (command === 'logout') send({ type: 'account', ...(await auth.logout()) });
    else send({ type: 'account', ...auth.view() });
    return 0;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    auth.close();
  }
}
module.exports = { runAccount, createCliAccount, usage };
