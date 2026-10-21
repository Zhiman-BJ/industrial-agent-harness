// Connection-only regression through the real Settings, preload and IPC path.
// The loopback fixture cannot create projects, upload files or execute tools.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

async function createConnectionFixture() {
  const requests = [];
  const token = 'connection-selftest-only';
  const current = {
    version: '1.3.1',
    domains: ['test'],
    domainCatalog: [],
    capabilitySnapshotHash: 'a'.repeat(64),
    sessionModel: 'application-session',
  };
  let info = current;
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      return response.end('{}');
    }
    if (request.method !== 'GET' || request.url !== '/v1/service-info') {
      response.writeHead(405);
      return response.end('{}');
    }
    response.end(JSON.stringify(info));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    current,
    requests,
    setInfo(value) {
      info = value;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function prepare() {
  const fixture = await createConnectionFixture();
  process.env.INDUSTRIAL_REMOTE_SERVICE_URL = fixture.url;
  process.env.INDUSTRIAL_REMOTE_CREDENTIAL_ENV = 'REMOTE_CONNECTION_SELFTEST_TOKEN';
  process.env.REMOTE_CONNECTION_SELFTEST_TOKEN = fixture.token;
  return fixture;
}

async function run(window, fixture) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 20000;
    while (!(await evaluate(script))) {
      if (Date.now() > deadline) throw Error(`Remote connection UI timed out: ${script}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  async function capture(name) {
    const directory = process.env.INDUSTRIAL_UI_SCREENSHOTS;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `remote-connection-${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  await wait(`Boolean(document.querySelector('.ia-settings-button'))`);
  await evaluate(`document.querySelector('.ia-settings-button').click()`);
  await wait(
    `Array.from(document.querySelectorAll('.ia-settings-row')).some(row => row.textContent.includes('MCP & Skills'))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ia-settings-row')).find(row => row.textContent.includes('MCP & Skills')).querySelector('button').click()`,
  );
  await wait(
    `Boolean(document.querySelector('.ia-remote-service .ia-remote-primary:not(:disabled)'))`,
  );

  async function check(name, info, reason) {
    fixture.setInfo(info);
    const before = fixture.requests.length;
    await evaluate(`document.querySelector('.ia-remote-service .ia-remote-primary').click()`);
    const deadline = Date.now() + 20000;
    while (fixture.requests.length === before) {
      if (Date.now() > deadline) throw Error(`${name}: connection request was not sent`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await wait(
      `document.querySelector('.ia-remote-service .ia-remote-primary')?.disabled === false`,
    );
    assert.equal(fixture.requests.length, before + 1, `${name}: one real connection request`);
    const status = await evaluate(
      `document.querySelector('.ia-remote-service [role="status"]').textContent`,
    );
    const alert = await evaluate(
      `document.querySelector('.ia-remote-service [role="alert"]')?.textContent || ''`,
    );
    if (reason) {
      assert.equal(status, 'Temporarily unavailable', name);
      assert.match(alert, reason, name);
    } else {
      assert.equal(status, 'Connected', name);
      assert.equal(alert, '', `${name}: stale error cleared`);
    }
    await capture(name);
    console.log(`[remote-connection-selftest] ${name}: passed`);
  }
  await check('canonical', {
    serverId: 'mcp-v1-origin',
    remoteProtocolVersion: '1.1',
    canonicalSchemaVersion: '1',
    sessionModel: 'application-session',
    domains: ['test'],
    capabilities: { snapshots: true, runtimeDiscovery: true },
  });
  await check('mcp-1.3.1', fixture.current);
  await check('mcp-future-minor', { ...fixture.current, version: '1.4.0' });
  await check('mcp-future-major', { ...fixture.current, version: '2.0.0' });
  await check(
    'unsupported-protocol',
    { ...fixture.current, remoteProtocolVersion: '2.0' },
    /does not support the remote execution protocol 1.1/,
  );
  await check(
    'malformed-discovery',
    { ...fixture.current, capabilitySnapshotHash: 'malformed' },
    /capabilitySnapshotHash/,
  );
  await check('recovered', fixture.current);
  assert.equal(fixture.requests.length, 7);
  assert.ok(
    fixture.requests.every(
      request => request.method === 'GET' && request.url === '/v1/service-info',
    ),
    'Connection checks never create projects, upload files or execute tools',
  );
}

module.exports = { createConnectionFixture, prepare, run };
