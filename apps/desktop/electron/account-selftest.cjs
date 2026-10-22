const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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
  const capture = async name => {
    const directory = process.env.INDUSTRIAL_UI_SCREENSHOTS;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(directory, name + '.png'), image.toPNG());
  };
  const wait = async script => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Account UI selftest timed out waiting for: ${script.slice(0, 160)}`);
  };
  // The settings gear lives in the sidebar, which React unmounts below the
  // 760px breakpoint (App.tsx sidebarVisible). After restoring the window from
  // the compact 640px pass, the renderer's resize listener and React commit
  // still need a beat — clicking the gear before that round-trip lands races
  // and intermittently hits a null element. Wait for the sidebar to be back.
  const restoreSidebar = async () => {
    await wait("Boolean(document.querySelector('.ia-settings-button'))");
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
  };
  const click = async selector => {
    await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const clickAction = async () => {
    await wait("!document.querySelector('.ia-account-actions button').disabled");
    await click('.ia-account-actions button');
  };
  const openAccount = async () => {
    await click('.ia-settings-button');
    await wait("Boolean(document.querySelector('.ia-settings-row'))");
    await evaluate(
      "Array.from(document.querySelectorAll('.ia-settings-row')).find(row => /Platform account|平台账号/.test(row.textContent)).querySelector('button').click()",
    );
    await wait("Boolean(document.querySelector('.ia-account-modal'))");
    await require('./modal-focus-selftest.cjs').check(window, '.ia-account-modal');
  };
  const setTheme = async theme => {
    const dark = theme === 'dark';
    if (
      await evaluate(
        `document.querySelector('.ia-app').classList.contains('theme-dark') === ${dark}`,
      )
    )
      return;
    // Switch through the existing settings control without reloading an active sign-in.
    await click('.ia-account-modal > header button');
    await wait("!document.querySelector('.ia-account-modal')");
    await click('.ia-settings-button');
    await wait("Boolean(document.querySelector('.ia-settings-row'))");
    await evaluate(
      "Array.from(document.querySelectorAll('.ia-settings-row')).find(row => /Appearance|外观/.test(row.textContent)).querySelector('button').click()",
    );
    await wait(`document.querySelector('.ia-app').classList.contains('theme-dark') === ${dark}`);
    await click('.ia-settings-title button');
    await wait("!document.querySelector('.ia-settings-title')");
    await openAccount();
  };
  const settleLayout = () =>
    evaluate(
      'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
    );
  const checkLayout = async name => {
    const geometry = await evaluate(`(() => {
      const modal = document.querySelector('.ia-account-modal');
      const content = modal.querySelector('.ia-account-content');
      const header = modal.querySelector(':scope > header');
      const footer = modal.querySelector('.ia-account-actions');
      const withinViewport = element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
          && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      };
      return {
        fits: withinViewport(modal),
        horizontalOverflow: [modal, content].some(element => element.scrollWidth > element.clientWidth + 1),
        actionsVisible: [header, footer, ...header.querySelectorAll('button'), ...footer.querySelectorAll('button')].every(withinViewport),
        headerTop: header.getBoundingClientRect().top,
        footerTop: footer.getBoundingClientRect().top,
      };
    })()`);
    assert.equal(geometry.fits, true, `${name}: account dialog fits the viewport`);
    assert.equal(geometry.horizontalOverflow, false, `${name}: no horizontal overflow`);
    assert.equal(geometry.actionsVisible, true, `${name}: header and footer actions stay visible`);
    return geometry;
  };
  const captureThemes = async (name, ready) => {
    const originalSize = window.getContentSize();
    const originalTheme = await evaluate(
      "document.querySelector('.ia-app').classList.contains('theme-dark') ? 'dark' : 'light'",
    );
    const restore = async () => {
      window.setContentSize(...originalSize);
      await restoreSidebar();
      await setTheme(originalTheme);
      await wait(ready);
      await settleLayout();
    };
    try {
      for (const theme of ['light', 'dark']) {
        window.setContentSize(...originalSize);
        await restoreSidebar();
        await setTheme(theme);
        await wait(ready);
        await settleLayout();
        await checkLayout(`${name}-${theme}`);
        await capture(`${name}-${theme}`);
        window.setContentSize(640, 480);
        await wait('innerWidth === 640 && innerHeight === 480');
        await settleLayout();
        const before = await checkLayout(`${name}-${theme}-compact`);
        await evaluate(
          "document.querySelector('.ia-account-content').scrollTop = document.querySelector('.ia-account-content').scrollHeight",
        );
        await settleLayout();
        const after = await checkLayout(`${name}-${theme}-compact-scrolled`);
        assert.equal(
          after.headerTop,
          before.headerTop,
          'Scrolling account content keeps the header fixed',
        );
        assert.equal(
          after.footerTop,
          before.footerTop,
          'Scrolling account content keeps the footer fixed',
        );
        await evaluate("document.querySelector('.ia-account-content').scrollTop = 0");
        await settleLayout();
        await capture(`${name}-${theme}-compact`);
      }
      await restore();
    } catch (error) {
      // The original failure is the signal; restore best-effort and never let
      // a restore timeout mask it behind a generic "selftest timed out".
      try {
        await restore();
      } catch (restoreError) {
        error.message += ` [theme restore also failed: ${restoreError.message}]`;
      }
      throw error;
    }
  };
  await openAccount();
  await wait("window.harnessAccount.get().then(view => view.status === 'signed_out')");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.ia-account-modal input, .ia-account-connection').length",
    ),
    0,
    'Signed-out users can sign in without entering connection or model settings',
  );
  assert.equal(await evaluate('typeof window.harnessAccount.configure'), 'undefined');
  await captureThemes(
    'account-ready',
    "Boolean(document.querySelector('.ia-account-actions button:not(:disabled)'))",
  );
  await clickAction();
  await wait("document.querySelector('.ia-account-modal').textContent.includes('138****1234')");
  const view = await evaluate('window.harnessAccount.get()');
  assert.equal(view.status, 'signed_in');
  await capture('account-signed-in');
  await captureThemes(
    'account-signed-in',
    "document.querySelector('.ia-account-identity')?.textContent.includes('138****1234')",
  );
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
  await capture('account-paste-code');
  await captureThemes(
    'account-paste-code',
    "Boolean(document.querySelector('.ia-account-modal form input[type=password]'))",
  );
  await click('.ia-account-modal form button[type=button]');
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
    await click('.ia-account-modal form button[type=submit]');
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
  await capture('account-signed-out');
  console.log(
    'Account selftest passed:',
    JSON.stringify({
      ok: true,
      persistentCredentials: view.persistent,
      account: 'PKCE loopback/paste, cancellation, invalid code, refresh, secret-free IPC, logout',
    }),
  );
}
module.exports = { prepare, run };
