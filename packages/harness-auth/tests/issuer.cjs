const { createServer, fetch } = require('./memory-http.cjs');
const crypto = require('node:crypto');
async function createIssuer({
  clients = { 'harness-native': 'harness' },
  subjects = {},
  resources = {},
} = {}) {
  const { generateKeyPair, exportJWK, SignJWT, decodeJwt } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map(),
    refreshTokens = new Map();
  const calls = {
    refresh: 0,
    token: 0,
    revoke: 0,
    model: 0,
    headers: [],
    revokedTokens: [],
    refreshClients: [],
    revokedClients: [],
    resources: [],
  };
  const behavior = {
    invalidGrant: false,
    badNonce: false,
    badAudience: false,
    badSignature: false,
    lostRefresh: false,
    tokenDelay: 0,
  };
  let origin;
  const sign = (payload, audience, typ = 'JWT', subject = 'user-123') =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ })
      .setSubject(subject)
      .setIssuer(origin)
      .setAudience(audience)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
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
    if (url.pathname === '/userinfo')
      return json({ sub: decodeJwt(req.headers.authorization.slice(7)).sub, name: '138****1234' });
    if (url.pathname === '/token' || url.pathname === '/revoke') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.has('client_secret') || req.headers.authorization || !clients[form.get('client_id')])
        return json({ error: 'invalid_client' }, 400);
      const clientId = form.get('client_id');
      if (url.pathname === '/revoke') {
        calls.revoke++;
        calls.revokedClients.push(clientId);
        if (behavior.revokeFailure === clientId) return json({ error: 'server_error' }, 503);
        calls.revokedTokens.push(form.get('token'));
        refreshTokens.delete(form.get('token'));
        return json({});
      }
      calls.token++;
      const resource = form.get('resource');
      calls.resources.push(resource);
      if (behavior.invalidTarget || (resource && !resources[resource]))
        return json({ error: 'invalid_target' }, 400);
      let nonce;
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        if (
          !code ||
          code.client_id !== clientId ||
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
        calls.refreshClients.push(clientId);
        if (behavior.invalidGrant || refreshTokens.get(form.get('refresh_token')) !== clientId)
          return json({ error: 'invalid_grant' }, 400);
        refreshTokens.delete(form.get('refresh_token'));
        if (behavior.lostRefresh) return req.socket.destroy();
        await behavior.beforeRefreshResponse?.(clientId);
      }
      const refresh = 'refresh-' + crypto.randomUUID();
      refreshTokens.set(refresh, clientId);
      return json({
        access_token: await sign(
          {
            scope: 'openid profile offline_access',
            client_id: clientId,
            roles: ['user'],
            permissions: ['task:read'],
          },
          resource ? resources[resource] : clients[clientId],
          'at+jwt',
          subjects[clientId] || 'user-123',
        ),
        refresh_token: refresh,
        expires_in: 900,
        token_type: 'Bearer',
        ...(nonce
          ? {
              id_token: await sign(
                { nonce },
                behavior.badAudience ? 'another-client' : clientId,
                'JWT',
                subjects[clientId] || 'user-123',
              ),
            }
          : {}),
      });
    }
    if (url.pathname === '/v1/chat/completions') {
      calls.model++;
      calls.headers.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"text":"hello"}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    return json({ error: 'not_found' }, 404);
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
