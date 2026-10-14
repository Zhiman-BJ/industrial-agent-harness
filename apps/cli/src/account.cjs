const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
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
Signs in to the Zhiman platform by default (https://auth.zhiman.cn, client harness-desktop-1);
run --platform-account then bills the model (https://api.zhiman.cn/v1) to your own Obol account.
Another platform: INDUSTRIAL_AUTH_ISSUER, INDUSTRIAL_AUTH_CLIENT_ID, INDUSTRIAL_AUTH_AUDIENCE,
INDUSTRIAL_AUTH_MODEL_BASE_URL; a remote service: INDUSTRIAL_AUTH_REMOTE_ORIGIN with
INDUSTRIAL_AUTH_REMOTE_AUDIENCE (its application slug).
CLI persistence requires explicit --allow-file-store (private 0600 credential file).
Without it, credentials remain in memory for this command only.
--no-browser uses code paste only; open the URL on any device and paste code#state on stdin.
SSH/headless sessions also use code paste. Normal sign-in accepts loopback or code paste.
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
  let reader;
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    // Logout must still clear a damaged credential file that restore cannot read.
    if (command !== 'logout') await auth.restore();
    if (command === 'login') {
      const manualOnly = Boolean(
        flags.includes('--no-browser') ||
          environment.SSH_CONNECTION ||
          (process.platform === 'linux' && !environment.DISPLAY && !environment.WAYLAND_DISPLAY),
      );
      auth.once('authorization', url => {
        if (auth.view().login?.loopbackAvailable)
          send({ type: 'account_authorization', url, callback: 'same-machine-loopback' });
      });
      auth.once('manual-authorization', url => {
        send({
          type: 'account_authorization',
          url,
          callback: 'paste-code',
          input: 'code#state via stdin',
        });
        const input = options.input || process.stdin;
        // A terminal must not echo authorization codes or put them in command history.
        reader = readline.createInterface({
          input,
          output: new Writable({ write: (_chunk, _encoding, done) => done() }),
          terminal: Boolean(input.isTTY),
          historySize: 0,
        });
        let submitting = false;
        reader.on('SIGINT', cancel);
        reader.on('line', async value => {
          if (submitting || auth.view().status !== 'signing_in') return;
          submitting = true;
          try {
            await auth.submitCode(value);
          } catch (error) {
            send({ type: 'account_code_error', message: error.message });
            if (reader.closed && !auth.view().login?.loopbackAvailable) cancel();
          } finally {
            submitting = false;
          }
        });
        reader.on('close', () => {
          if (
            !submitting &&
            auth.view().status === 'signing_in' &&
            !auth.view().login?.loopbackAvailable
          )
            cancel();
        });
      });
      await auth.login({
        manualOnly,
        openBrowser: manualOnly
          ? undefined
          : options.openBrowser || (url => openBrowser(url, environment)),
      });
      send({ type: 'account', ...auth.view() });
    } else if (command === 'logout') send({ type: 'account', ...(await auth.logout()) });
    else send({ type: 'account', ...auth.view() });
    return 0;
  } finally {
    reader?.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    auth.close();
  }
}
module.exports = { runAccount, createCliAccount, usage };
