const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIssuer } = require('./issuer.cjs');
const { createServer, fetch } = require('./memory-http.cjs');
const { runVerification } = require('../../../scripts/verify-obol-login.cjs');

async function setup(t, customFetch) {
  const issuer = await createIssuer();
  t.after(issuer.close);
  const events = [];
  return {
    issuer,
    events,
    options: {
      config: issuer.config,
      fetch: customFetch || fetch,
      createServer,
      openBrowser: async url => {
        await fetch(await issuer.authorize(url));
      },
      onEvent: event => events.push(event),
    },
  };
}

test('live verifier uses signed OIDC login, refresh rotation, UserInfo and revocation without reporting secrets', async t => {
  const { issuer, options, events } = await setup(t);
  const report = await runVerification(options);
  assert.equal(report.status, 'passed');
  assert.equal(issuer.calls.refresh, 1);
  assert.equal(issuer.calls.revoke, 1);
  const output = JSON.stringify({ report, events });
  for (const token of issuer.calls.revokedTokens) assert.ok(!output.includes(token));
  for (const privateValue of ['user-123', '138****1234', 'code_verifier', 'eyJ'])
    assert.ok(!output.includes(privateValue));
});

test('live verifier rejects a wrongly addressed ID token and does not continue to refresh', async t => {
  const { issuer, options } = await setup(t);
  issuer.behavior.badAudience = true;
  const report = await runVerification(options);
  assert.equal(report.status, 'failed');
  assert.equal(issuer.calls.refresh, 0);
  // The OIDC library rejects the response before returning tokens to Harness.
  assert.equal(report.checks.revocationAttempted, false);
});

test('live verifier completes manual code-paste login without a loopback listener', async t => {
  const { issuer, options } = await setup(t);
  const report = await runVerification({
    ...options,
    noBrowser: true,
    createServer: () => assert.fail('Manual login must not open a callback listener'),
    loginDriver: async ({ auth, loginOptions }) => {
      let submission;
      auth.once('manual-authorization', url => {
        submission = (async () => {
          const callback = new URL(await issuer.authorize(url));
          await auth.submitCode(
            `${callback.searchParams.get('code')}#${callback.searchParams.get('state')}`,
          );
        })();
        submission.catch(() => auth.cancel());
      });
      const view = await auth.login(loginOptions);
      await submission;
      return view;
    },
  });
  assert.equal(report.status, 'passed');
  assert.equal(issuer.calls.refresh, 1);
  assert.equal(issuer.calls.revoke, 1);
});

test('live verifier fails on a refreshed UserInfo subject mismatch and revokes the session', async t => {
  let userinfoCalls = 0;
  const { issuer, options } = await setup(t, (input, init) => {
    if (new URL(input).pathname === '/userinfo' && ++userinfoCalls > 1)
      return new Response(JSON.stringify({ sub: 'different-user' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    return fetch(input, init);
  });
  const report = await runVerification(options);
  assert.equal(report.status, 'failed');
  assert.equal(issuer.calls.refresh, 1);
  assert.equal(issuer.calls.revoke, 1);
  assert.ok(!JSON.stringify(report).includes('different-user'));
});

test('live verifier never claims success when the revocation endpoint fails', async t => {
  const { options } = await setup(t, (input, init) => {
    if (new URL(input).pathname === '/revoke')
      return new Response(JSON.stringify({ error: 'server_error' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    return fetch(input, init);
  });
  assert.equal((await runVerification(options)).status, 'failed');
});

test('live verifier preserves a safe DNS error code without leaking original error text', async () => {
  const report = await runVerification({
    config: { issuer: 'https://auth.example.test', clientId: 'test-native' },
    fetch: async () => {
      throw new TypeError('private request details', {
        cause: Object.assign(new Error('secret-token'), { code: 'ENOTFOUND' }),
      });
    },
    createServer,
    openBrowser: () => assert.fail('Discovery failed; the browser must not open'),
  });
  assert.equal(report.status, 'failed');
  const output = JSON.stringify(report);
  assert.ok(output.includes('ENOTFOUND'));
  assert.ok(!output.includes('private request details'));
  assert.ok(!output.includes('secret-token'));
});
