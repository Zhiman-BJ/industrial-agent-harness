const assert = require('node:assert/strict');
const path = require('node:path');
const { writePrivate } = require('@industrial-agent-harness/harness-auth');
const { createIssuer } = require('@industrial-agent-harness/harness-auth/tests/issuer.cjs');
async function prepare(directory) {
  const issuer = await createIssuer();
  writePrivate(path.join(directory, 'config.json'), JSON.stringify(issuer.config));
  let codeReady;
  const fixture = {
    issuer,
    mode: 'automatic',
    code: null,
    codeReady: new Promise(resolve => {
      codeReady = resolve;
    }),
    openBrowser: async url => {
      const callback = new URL(await issuer.authorize(url));
      if (callback.pathname === '/oauth/code') {
        fixture.code = callback.searchParams.get('code') + '#' + callback.searchParams.get('state');
        codeReady();
      } else if (fixture.mode === 'automatic') await fetch(callback);
    },
    close: issuer.close,
  };
  return fixture;
}
async function run(window, account, fixture) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  const wait = async script => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Account UI selftest timed out.');
  };
  const clickAction = async () => {
    await wait("!document.querySelector('.ia-account-actions button').disabled");
    await evaluate("document.querySelector('.ia-account-actions button').click()");
  };
  await wait("Boolean(document.querySelector('.ia-settings-button'))");
  await evaluate("document.querySelector('.ia-settings-button').click()");
  await evaluate(
    "Array.from(document.querySelectorAll('.ia-settings-row')).find(row => /Platform account|平台账号/.test(row.textContent)).querySelector('button').click()",
  );
  await wait("Boolean(document.querySelector('.ia-account-modal'))");
  await clickAction();
  await wait("document.querySelector('.ia-account-modal').textContent.includes('138****1234')");
  const view = await evaluate('window.harnessAccount.get()');
  assert.equal(view.status, 'signed_in');
  const serialized = JSON.stringify(view);
  for (const forbidden of ['access_token', 'refresh_token', 'accessToken', 'refreshToken'])
    assert.ok(!serialized.includes(forbidden));
  const clock = Date.now();
  account.auth.now = () => clock + 850000;
  await account.auth.accessToken();
  assert.equal(fixture.issuer.calls.refresh, 1);
  await clickAction();
  await wait("window.harnessAccount.get().then(view => view.status === 'signed_out')");
  assert.equal(fixture.issuer.calls.revoke, 1);
  fixture.mode = 'manual';
  await clickAction();
  await wait("Boolean(document.querySelector('.ia-account-modal input[type=password]'))");
  await clickAction();
  await wait("window.harnessAccount.get().then(view => view.status === 'signed_out')");
  await wait("!document.querySelector('.ia-account-actions button').disabled");
  await clickAction();
  await wait("Boolean(document.querySelector('.ia-account-modal form'))");
  await evaluate("document.querySelector('.ia-account-modal form button[type=button]').click()");
  let codeTimeout;
  try {
    await Promise.race([
      fixture.codeReady,
      new Promise((_, reject) => {
        codeTimeout = setTimeout(
          () => reject(Error('Manual authorization page did not open.')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(codeTimeout);
  }
  assert.ok(fixture.code);
  const enter = async value => {
    await evaluate(`(() => {
      const input = document.querySelector('.ia-account-modal input[type=password]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait("!document.querySelector('.ia-account-modal form button[type=submit]').disabled");
    await evaluate("document.querySelector('.ia-account-modal form button[type=submit]').click()");
  };
  await enter('invalid');
  await wait("Boolean(document.querySelector('.ia-account-modal [role=alert]'))");
  assert.equal(
    await evaluate("document.querySelector('.ia-account-modal input[type=password]').value"),
    '',
  );
  await enter(fixture.code);
  await wait("window.harnessAccount.get().then(view => view.status === 'signed_in')");
  await wait("!document.querySelector('.ia-account-modal input[type=password]')");
  await clickAction();
  await wait("window.harnessAccount.get().then(view => view.status === 'signed_out')");
  assert.equal(fixture.issuer.calls.revoke, 2);
  console.log(
    JSON.stringify({
      ok: true,
      account: 'PKCE loopback/paste, cancellation, invalid code, refresh, secret-free IPC, logout',
    }),
  );
}
module.exports = { prepare, run };
