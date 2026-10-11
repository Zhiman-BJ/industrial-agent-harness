const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createLocalhostCertificate } = require('./localhost-tls.cjs');
const { Transfer, parseBearerChallenge, registryScope } = require('./transfer.cjs');

test('bearer challenges parse strictly and reject non-https realms', () => {
  assert.deepEqual(
    parseBearerChallenge('Bearer realm="https://reg.example/token",service="harbor-registry"'),
    { realm: 'https://reg.example/token', service: 'harbor-registry' },
  );
  assert.deepEqual(parseBearerChallenge('Bearer realm="https://only.realm"'), {
    realm: 'https://only.realm',
    service: '',
  });
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
  assert.equal(parseBearerChallenge('Bearer realm="http://insecure"'), null);
  assert.equal(parseBearerChallenge(null), null);
  assert.equal(parseBearerChallenge('Bearer service="no-realm"'), null);
});

test('registry scopes derive only from registry API paths', () => {
  assert.equal(
    registryScope(new URL('https://reg.example/v2/proj/kicad/blobs/sha256:abc')),
    'repository:proj/kicad:pull',
  );
  assert.equal(
    registryScope(new URL('https://reg.example/v2/proj/repo/manifests/v1')),
    'repository:proj/repo:pull',
  );
  assert.equal(registryScope(new URL('https://reg.example/files/kicad.dmg')), null);
  assert.equal(registryScope(new URL('https://reg.example/v2/only')), null);
});

async function registryFixture() {
  // Minimal public-registry behavior: anonymous token service + blob GET.
  const tls = createLocalhostCertificate();
  const payload = crypto.randomBytes(4096);
  const seen = { tokenRequests: 0, blobAuthorizations: [] };
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    if (req.url.startsWith('/service/token')) {
      seen.tokenRequests += 1;
      const scope = new URL(req.url, 'https://x').searchParams.get('scope');
      assert.equal(scope, 'repository:industrial-runtime-assets/kicad:pull');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'anonymous-token-value' }));
      return;
    }
    if (req.url.startsWith('/v2/')) {
      if (req.headers.authorization !== 'Bearer anonymous-token-value') {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="https://127.0.0.1:${server.address().port}/service/token",service="harbor-registry"`,
        );
        res.end('{}');
        return;
      }
      seen.blobAuthorizations.push(req.headers.authorization);
      res.setHeader('content-type', 'application/octet-stream');
      res.end(payload);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const port = await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  return { server, port, payload, seen, cert: tls.cert };
}

test(
  'an anonymous registry bearer challenge is resolved without credentials',
  { timeout: 20000 },
  async t => {
    const fixture = await registryFixture();
    t.after(() => new Promise(resolve => fixture.server.close(resolve)));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-bearer-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const certFile = path.join(directory, 'localhost-cert.pem');
    fs.writeFileSync(certFile, fixture.cert);

    // The in-process fetch validates TLS; run the transfer in a child that
    // trusts the fixture certificate, like the download-lifecycle suite.
    const script = path.join(directory, 'fetch.cjs');
    fs.writeFileSync(
      script,
      `const { Transfer } = require(${JSON.stringify(path.resolve(__dirname, 'transfer.cjs'))});
     const transfer = new Transfer();
     transfer.response(process.argv[2])
       .then(async (response) => {
         const bytes = Buffer.from(await response.arrayBuffer());
         process.stdout.write(bytes.toString('base64'));
       })
       .catch((error) => { console.error(error.message + ' | cause: ' + (error.cause ? (error.cause.code || error.cause.message) : 'none')); process.exit(1); });`,
    );
    const child = spawn(
      process.execPath,
      [
        script,
        `https://127.0.0.1:${fixture.port}/v2/industrial-runtime-assets/kicad/blobs/sha256:${'0'.repeat(64)}`,
      ],
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    const status = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(status, 0, stderr);
    assert.deepEqual(Buffer.from(stdout, 'base64'), fixture.payload);
    assert.equal(fixture.seen.tokenRequests, 1);
    assert.deepEqual(fixture.seen.blobAuthorizations, ['Bearer anonymous-token-value']);
  },
);
