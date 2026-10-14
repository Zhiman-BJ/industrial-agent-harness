#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const {
  AuthManager,
  SessionStore,
  validateConfig,
} = require('../packages/harness-auth/src/index.cjs');
const { openBrowser: systemBrowser } = require('../packages/harness-auth/src/system-browser.cjs');

const networkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);
const authCodes = new Set([
  'cancelled',
  'timeout',
  'access_denied',
  'login_required',
  'protocol_error',
  'unavailable',
  'refresh_uncertain',
  'invalid_code',
  'no_pending_login',
  'login_consumed',
]);
const verificationCodes = new Set([
  'CANCELLED',
  'CLIENT_ID_REQUIRED',
  'LOGIN_NOT_VERIFIED',
  'REFRESH_NOT_ROTATED',
  'REFRESH_IDENTITY_MISMATCH',
  'USERINFO_UNAVAILABLE',
  'USERINFO_IDENTITY_MISMATCH',
  'LOCAL_LOGOUT_FAILED',
  'REVOCATION_UNCONFIRMED',
  'INVALID_ARGUMENTS',
  'REPORT_PATH_MUST_BE_ABSOLUTE',
  'INTERACTIVE_TERMINAL_REQUIRED',
]);
function networkCode(error) {
  const pending = [error],
    seen = new Set();
  while (pending.length && seen.size < 20) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (networkCodes.has(current.code)) return current.code;
    pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 10));
  }
  return null;
}
function check(condition, code) {
  if (!condition)
    throw Object.assign(new Error('Verification failed.'), { verificationCode: code });
}

// No personal configuration is read. Only this isolated in-memory session is inspected.
// loginDriver receives { auth, loginOptions }; onEvent receives only safe progress fields.
async function runVerification({
  config,
  fetch = global.fetch,
  createServer,
  openBrowser = systemBrowser,
  noBrowser = false,
  loginDriver = ({ auth, loginOptions }) => auth.login(loginOptions),
  onEvent = () => {},
  signal,
} = {}) {
  const report = {
    schemaVersion: 1,
    status: 'failed',
    phases: Object.fromEntries(
      ['setup', 'login', 'refresh', 'userinfo', 'logout', 'cleanup'].map(name => [name, 'not_run']),
    ),
    checks: {
      memoryOnly: false,
      refreshObserved: false,
      refreshRotated: false,
      userinfoSubjectMatches: false,
      revocationAttempted: false,
      revoked: false,
      credentialsCleared: false,
      temporaryDirectoryRemoved: false,
    },
    errors: [],
  };
  let phase = 'setup',
    directory,
    auth,
    store,
    acquired = false;
  const transportErrors = new Map();
  const emit = (status, code) => {
    try {
      onEvent({ phase, status, ...(code ? { code } : {}) });
    } catch {
      /* Observer only. */
    }
  };
  const begin = name => {
    phase = name;
    transportErrors.delete(name);
    emit('running');
  };
  const pass = () => {
    report.phases[phase] = 'passed';
    emit('passed');
  };
  const fail = (error, fallback) => {
    const code =
      transportErrors.get(phase) ||
      networkCode(error) ||
      (verificationCodes.has(error?.verificationCode) ? error.verificationCode : null) ||
      (authCodes.has(error?.code) ? error.code.toUpperCase() : fallback);
    report.phases[phase] = 'failed';
    report.errors.push({ phase, code });
    emit('failed', code);
  };
  const cancel = () => auth?.cancel();
  const active = () => check(!signal?.aborted, 'CANCELLED');
  try {
    begin('setup');
    const connection = validateConfig(config || {});
    check(Boolean(connection.clientId), 'CLIENT_ID_REQUIRED');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-obol-verification-'));
    store = new SessionStore({ directory: path.join(directory, 'account'), allowPlaintext: false });
    auth = new AuthManager({
      config: connection,
      store,
      ...(createServer ? { createServer } : {}),
      fetch: async (input, init) => {
        try {
          return await fetch(input, init);
        } catch (error) {
          const code = networkCode(error);
          if (code) transportErrors.set(phase, code);
          throw error;
        }
      },
    });
    auth.on('change', view => {
      if (phase === 'refresh' && view.status === 'refreshing') report.checks.refreshObserved = true;
    });
    signal?.addEventListener('abort', cancel);
    report.checks.memoryOnly = !store.persistent();
    active();
    pass();

    begin('login');
    await loginDriver({
      auth,
      loginOptions: { manualOnly: noBrowser, openBrowser: noBrowser ? undefined : openBrowser },
    });
    active();
    const view = auth.view();
    acquired = view.status === 'signed_in';
    check(acquired && Boolean(view.user?.sub) && !view.persistent, 'LOGIN_NOT_VERIFIED');
    const subject = view.user.sub;
    pass();

    begin('refresh');
    const previousAccess = await auth.accessToken();
    const previousRefresh = await store.transaction(tx => tx.read()?.refreshToken);
    // Ignore an incidental expiry refresh above: this call must cause its own refresh.
    report.checks.refreshObserved = false;
    const refreshedAccess = await auth.accessToken({ rejectedToken: previousAccess });
    const nextRefresh = await store.transaction(tx => tx.read()?.refreshToken);
    report.checks.refreshRotated = Boolean(
      previousRefresh && nextRefresh && previousRefresh !== nextRefresh,
    );
    check(report.checks.refreshObserved && report.checks.refreshRotated, 'REFRESH_NOT_ROTATED');
    check(
      auth.view().status === 'signed_in' && auth.view().user?.sub === subject,
      'REFRESH_IDENTITY_MISMATCH',
    );
    active();
    pass();

    begin('userinfo');
    const { oidc, config: protocol } = await auth.protocol();
    check(Boolean(protocol.serverMetadata().userinfo_endpoint), 'USERINFO_UNAVAILABLE');
    const user = await oidc.fetchUserInfo(protocol, refreshedAccess, subject);
    report.checks.userinfoSubjectMatches = user.sub === subject;
    check(report.checks.userinfoSubjectMatches, 'USERINFO_IDENTITY_MISMATCH');
    active();
    pass();
  } catch (error) {
    fail(error, phase === 'setup' ? 'SETUP_FAILED' : 'VERIFICATION_FAILED');
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (auth) {
      begin('logout');
      try {
        report.checks.revocationAttempted = Boolean(store.read()?.refreshToken);
        const result = await auth.logout();
        report.checks.revoked = report.checks.revocationAttempted && result.revoked;
        report.checks.credentialsCleared =
          result.status === 'signed_out' && (await store.transaction(tx => tx.read() === null));
        check(report.checks.credentialsCleared, 'LOCAL_LOGOUT_FAILED');
        // An ambiguous refresh can clear local credentials; do not claim server revocation then.
        check(
          !(acquired || report.checks.revocationAttempted) || report.checks.revoked,
          'REVOCATION_UNCONFIRMED',
        );
        pass();
      } catch (error) {
        fail(error, 'LOGOUT_FAILED');
      } finally {
        auth.close();
      }
    }
    begin('cleanup');
    try {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      report.checks.temporaryDirectoryRemoved = true;
      pass();
    } catch (error) {
      fail(error, 'CLEANUP_FAILED');
    }
  }
  report.status = Object.values(report.phases).every(status => status === 'passed')
    ? 'passed'
    : 'failed';
  return report;
}

const usage = `Usage: node scripts/verify-obol-login.cjs --client-id ID [options]
  --issuer URL    Default: https://auth.zhiman.cn
  --audience SLUG Optional registered application slug (business access is not tested)
  --no-browser    Open the printed link yourself and paste code#state
  --report PATH   Write a new 0600 JSON report at an absolute path; never overwrite

Uses an isolated memory session; verifies login, refresh rotation, UserInfo and logout.
Authorization links appear only in the interactive terminal. No tokens are printed.
`;
function parseArgs(argv) {
  const args = { issuer: 'https://auth.zhiman.cn', noBrowser: false };
  const names = {
    '--issuer': 'issuer',
    '--client-id': 'clientId',
    '--audience': 'audience',
    '--report': 'report',
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    check(!seen.has(flag), 'INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--no-browser') args.noBrowser = true;
    else {
      check(Object.hasOwn(names, flag), 'INVALID_ARGUMENTS');
      const value = argv[++index];
      check(Boolean(value) && !value.startsWith('--'), 'INVALID_ARGUMENTS');
      args[names[flag]] = value;
    }
  }
  check(Boolean(args.clientId), 'CLIENT_ID_REQUIRED');
  check(!args.report || path.isAbsolute(args.report), 'REPORT_PATH_MUST_BE_ABSOLUTE');
  return args;
}

async function terminalLogin({ auth, loginOptions }) {
  check(Boolean(process.stderr.isTTY), 'INTERACTIVE_TERMINAL_REQUIRED');
  let reader,
    submitting = false;
  const cancel = () => auth.cancel();
  const authorization = url => {
    if (auth.view().login?.loopbackAvailable)
      process.stderr.write(`Open on this computer to sign in:\n${url}\n`);
  };
  const manual = url => {
    process.stderr.write(
      `Code-paste fallback (any device):\n${url}\nPaste the complete code#state here (hidden); Ctrl+C cancels.\n`,
    );
    reader = readline.createInterface({
      input: process.stdin,
      output: new Writable({ write: (_chunk, _encoding, done) => done() }),
      terminal: Boolean(process.stdin.isTTY),
      historySize: 0,
    });
    reader.on('SIGINT', cancel);
    reader.on('line', async value => {
      if (submitting || auth.view().status !== 'signing_in') return;
      submitting = true;
      try {
        await auth.submitCode(value);
      } catch {
        process.stderr.write('Code submission failed; check the complete code and state.\n');
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
  };
  auth.on('authorization', authorization);
  auth.on('manual-authorization', manual);
  try {
    return await auth.login(loginOptions);
  } finally {
    reader?.close();
    auth.removeListener('authorization', authorization);
    auth.removeListener('manual-authorization', manual);
  }
}

async function main(argv = process.argv.slice(2)) {
  let reportFd;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(usage);
      return 0;
    }
    if (args.report) reportFd = fs.openSync(args.report, 'wx', 0o600);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    let report;
    try {
      report = await runVerification({
        config: { issuer: args.issuer, clientId: args.clientId, audience: args.audience },
        noBrowser:
          args.noBrowser ||
          Boolean(process.env.SSH_CONNECTION) ||
          (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY),
        loginDriver: terminalLogin,
        signal: controller.signal,
        onEvent: event => process.stdout.write(JSON.stringify(event) + '\n'),
      });
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    if (reportFd !== undefined) {
      fs.writeFileSync(reportFd, JSON.stringify(report, null, 2) + '\n');
      fs.fsyncSync(reportFd);
    }
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    const code =
      (verificationCodes.has(error?.verificationCode) ? error.verificationCode : null) ||
      networkCode(error) ||
      'COMMAND_FAILED';
    process.stderr.write(JSON.stringify({ phase: 'command', status: 'failed', code }) + '\n');
    return 1;
  } finally {
    if (reportFd !== undefined) fs.closeSync(reportFd);
  }
}

if (require.main === module)
  main().then(code => {
    process.exitCode = code;
  });
module.exports = { runVerification, parseArgs, main };
