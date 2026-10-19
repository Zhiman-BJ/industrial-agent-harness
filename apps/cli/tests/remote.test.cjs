const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { runRemote } = require('../src/remote.cjs');
const { RemoteSettings } = require('../../../packages/harness-core/src/index.cjs');

test('CLI built-in service needs no name or URL and saves the same project execution preference as Desktop', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-remote-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config') };
  let output = '';
  const sink = {
    write: text => {
      output += text;
    },
  };
  await runRemote(['status'], sink, environment);
  assert.equal(JSON.parse(output).status, 'not_configured');
  output = '';
  await runRemote(
    ['use', '--project-dir', directory, '--domain', 'example', '--location', 'remote'],
    sink,
    environment,
  );
  assert.equal(
    new RemoteSettings({
      directory: environment.INDUSTRIAL_HARNESS_CONFIG_DIR,
      environment,
    }).project(directory, 'example').location,
    'remote',
  );
  await assert.rejects(
    runRemote(
      ['sync', '--project-dir', directory, '--domain', 'example', '--file', 'source.txt'],
      sink,
      environment,
    ),
    /unavailable/,
  );
  await assert.rejects(
    runRemote(
      ['use', '--project-dir', directory, '--domain', 'example', '--location', 'invalid'],
      sink,
      environment,
    ),
    /Invalid/,
  );
});

test('CLI rebind previews without requests and creates a fresh project only with explicit confirmation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-rebind-'));
  let requests = 0;
  const newProjectId = crypto.randomUUID();
  const server = http.createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, 'Bearer cli-rebind-token');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/service-info')
      response.end(
        JSON.stringify({
          remoteProtocolVersion: '1.1',
          canonicalSchemaVersion: '1',
          serverId: 'rebind-server',
          sessionModel: 'application-session',
          domains: ['example'],
          capabilities: { protectedExecution: true },
          domainCapabilities: [],
        }),
      );
    else {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/projects');
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { domain: 'example' });
      response.end(
        JSON.stringify({ id: newProjectId, domain: 'example', canonicalProjectId: 'a'.repeat(64) }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const environment = {
    INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
    INDUSTRIAL_REMOTE_SERVICE_URL: 'http://127.0.0.1:' + server.address().port,
    INDUSTRIAL_REMOTE_CREDENTIAL_ENV: 'CLI_REMOTE_TOKEN',
    CLI_REMOTE_TOKEN: 'cli-rebind-token',
  };
  const settings = new RemoteSettings({
    directory: environment.INDUSTRIAL_HARNESS_CONFIG_DIR,
    environment,
  });
  const previous = settings.update(directory, 'example', {
    location: 'remote',
    remoteProjectId: crypto.randomUUID(),
    protocol: '0.2',
    serviceIdentity: 'b'.repeat(64),
    snapshotId: crypto.randomUUID(),
    files: ['old.txt'],
  });
  let output = '';
  const sink = {
    write: text => {
      output += text;
    },
  };
  const args = ['rebind', '--project-dir', directory, '--domain', 'example'];
  await runRemote(args, sink, environment);
  assert.equal(requests, 0);
  assert.equal(JSON.parse(output).type, 'rebind_review');
  assert.deepEqual(settings.project(directory, 'example'), previous);
  output = '';
  await runRemote([...args, '--confirm-new-project'], sink, environment);
  assert.equal(requests, 2);
  const events = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    events.map(value => value.type),
    ['rebind_review', 'rebound'],
  );
  assert.equal(events[1].requiresExplicitUpload, true);
  const current = settings.project(directory, 'example');
  assert.equal(current.remoteProjectId, newProjectId);
  assert.equal(current.snapshotId, undefined);
  assert.deepEqual(current.bindingHistory[0].binding, previous);
  await assert.rejects(
    runRemote(['status', '--confirm-new-project'], sink, environment),
    /Invalid/,
  );
});
