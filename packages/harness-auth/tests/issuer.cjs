const { createServer, fetch } = require('./memory-http.cjs');
const crypto = require('node:crypto');
async function createIssuer() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map(),
    refreshTokens = new Set();
  const calls = {
    refresh: 0,
    token: 0,
    revoke: 0,
    model: 0,
    headers: [],
    revokedTokens: [],
    resources: [],
  };
  const behavior = {
    invalidGrant: false,
    badNonce: false,
    badAudience: false,
    badSignature: false,
    lostRefresh: false,
    tokenDelay: 0,
    // Resources (RFC 8707) the signed-in user has no grant for: invalid_target, nothing rotated.
    deniedResources: new Set(),
    // Overrides the aud the issuer puts in tokens for a resource.
    resourceAudience: {},
    // The model API answers 401 invalid_token this many times, as after a sign-out elsewhere.
    modelRejections: 0,
  };
  let origin;
  const sign = (payload, audience, typ = 'JWT') =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ })
      .setSubject('user-123')
      .setIssuer(origin)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(behavior.badSignature ? otherKey : privateKey);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        jwks_uri: origin + '/keys',
        userinfo_endpoint: origin + '/userinfo',
        revocation_endpoint: origin + '/revoke',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/keys') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      if (
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !url.searchParams.get('nonce') ||
        !url.searchParams.get('scope').includes('openid')
      )
        return json({ error: 'invalid_request' }, 400);
      const code = crypto.randomUUID();
      codes.set(code, Object.fromEntries(url.searchParams));
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('code', code);
      res.writeHead(302, { location: callback.href });
      return res.end();
    }
    if (url.pathname === '/userinfo') return json({ sub: 'user-123', name: '138****1234' });
    if (url.pathname === '/token' || url.pathname === '/revoke') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (
        form.has('client_secret') ||
        req.headers.authorization ||
        form.get('client_id') !== 'harness-native'
      )
        return json({ error: 'invalid_client' }, 400);
      if (url.pathname === '/revoke') {
        calls.revoke++;
        calls.revokedTokens.push(form.get('token'));
        refreshTokens.delete(form.get('token'));
        return json({});
      }
      calls.token++;
      let nonce;
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        if (
          !code ||
          form.get('redirect_uri') !== code.redirect_uri ||
          crypto
            .createHash('sha256')
            .update(form.get('code_verifier') || '')
            .digest('base64url') !== code.code_challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        nonce = behavior.badNonce ? 'wrong-nonce' : code.nonce;
        if (behavior.tokenDelay)
          await new Promise(resolve => setTimeout(resolve, behavior.tokenDelay));
      } else {
        calls.refresh++;
        calls.resources.push(form.get('resource'));
        if (behavior.invalidGrant || !refreshTokens.has(form.get('refresh_token')))
          return json({ error: 'invalid_grant' }, 400);
        if (form.getAll('resource').length > 1) return json({ error: 'invalid_target' }, 400);
        if (form.has('resource') && !audiences()[form.get('resource')])
          return json({ error: 'invalid_target', error_description: 'unknown resource' }, 400);
        if (behavior.deniedResources.has(form.get('resource')))
          return json(
            { error: 'invalid_target', error_description: 'no access to application' },
            400,
          );
        refreshTokens.delete(form.get('refresh_token'));
        if (behavior.lostRefresh) return req.socket.destroy();
        await behavior.beforeRefreshResponse?.();
      }
      const refresh = 'refresh-' + crypto.randomUUID();
      refreshTokens.add(refresh);
      return json({
        access_token: await sign(
          {
            scope: 'openid profile offline_access',
            client_id: 'harness-native',
            roles: ['user'],
            permissions: ['task:read'],
          },
          form.has('resource') ? audiences()[form.get('resource')] : 'harness',
          'at+jwt',
        ),
        refresh_token: refresh,
        expires_in: 900,
        token_type: 'Bearer',
        ...(nonce
          ? {
              id_token: await sign(
                { nonce },
                behavior.badAudience ? 'another-client' : 'harness-native',
              ),
            }
          : {}),
      });
    }
    if (url.pathname === '/v1/chat/completions') {
      calls.model++;
      calls.headers.push(req.headers.authorization);
      if (behavior.modelRejections > 0) {
        behavior.modelRejections--;
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
        return res.end('{"error":{"code":"unauthenticated"}}');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"text":"hello"}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    return json({ error: 'not_found' }, 404);
  });
  // The services this issuer knows: Obol's built-in model API and one remote service.
  const audiences = () => ({
    [origin + '/v1']: 'obol-api',
    [origin]: 'remote-service',
    ...behavior.resourceAudience,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    behavior,
    sign,
    config: {
      issuer: origin,
      clientId: 'harness-native',
      audience: 'harness',
      modelBaseUrl: origin + '/v1',
      remoteOrigin: origin,
      remoteAudience: 'remote-service',
    },
    authorize: async url => {
      const response = await fetch(url, { redirect: 'manual' });
      return response.headers.get('location');
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
module.exports = { createIssuer };
