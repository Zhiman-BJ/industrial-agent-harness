const assert = require('node:assert/strict');
const path = require('node:path');
const { writePrivate } = require('@industrial-agent-harness/harness-auth');
const { createIssuer } = require('@industrial-agent-harness/harness-auth/tests/issuer.cjs');
async function prepare(directory) {
  const issuer = await createIssuer();
  writePrivate(path.join(directory, 'config.json'), JSON.stringify(issuer.config));
  return {
    issuer,
    openBrowser: async url => {
      await fetch(await issuer.authorize(url));
    },
    close: issuer.close,
  };
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
  await wait("Boolean(document.querySelector('.ia-settings-button'))");
  await evaluate("document.querySelector('.ia-settings-button').click()");
  await evaluate(
    "Array.from(document.querySelectorAll('.ia-settings-row')).find(row => /Platform account|平台账号/.test(row.textContent)).querySelector('button').click()",
  );
  await wait("Boolean(document.querySelector('.ia-account-modal'))");
  await evaluate("document.querySelector('.ia-account-actions button').click()");
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
  await evaluate("document.querySelector('.ia-account-actions button').click()");
  await wait("window.harnessAccount.get().then(view => view.status === 'signed_out')");
  assert.equal(fixture.issuer.calls.revoke, 1);
  console.log(
    JSON.stringify({ ok: true, account: 'PKCE login, refresh, secret-free IPC, logout' }),
  );
}
module.exports = { prepare, run };
