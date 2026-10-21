const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { RemoteSettings, selectedSnapshot } = require('../src/remote-settings.cjs');
const { hash } = require('@industrial-agent-harness/domain-runtime');

function fixture(t, { current = true, account, serviceInfo = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'settings');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'input.txt'), 'task input');
  const projectId = randomUUID();
  const canonicalProjectId = hash('canonical service project');
  const environment = {
    INDUSTRIAL_REMOTE_SERVICE_URL: 'https://remote.example',
    INDUSTRIAL_REMOTE_CREDENTIAL_ENV: 'TEST_REMOTE_TOKEN',
    TEST_REMOTE_TOKEN: 'fixture-only-token',
  };
  const requests = [];
  const uploads = [];
  const snapshots = new Map();
  const hooks = {};
  const fetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const route = new URL(url).pathname;
    requests.push({ route, method: init.method });
    await hooks.request?.(route, init);
    if (route === '/v1/service-info') {
      return Response.json(
        current
          ? {
              version: '1.1.0',
              domains: ['test'],
              domainCatalog: [],
              capabilitySnapshotHash: 'a'.repeat(64),
              sessionModel: 'application-session',
              ...serviceInfo,
            }
          : {
              serverId: 'test-service',
              remoteProtocolVersion: '1.1',
              canonicalSchemaVersion: '1',
              domains: ['test'],
              sessionModel: 'application-session',
              capabilities: { snapshots: true },
              ...serviceInfo,
            },
      );
    }
    if (route === '/v1/projects')
      return Response.json({
        id: projectId,
        domain: 'test',
        ...(current ? {} : { canonicalProjectId }),
      });
    if (route === `/v1/projects/${projectId}/snapshots`) {
      const body = JSON.parse(init.body);
      const snapshotId = randomUUID();
      uploads.push(body);
      snapshots.set(snapshotId, body.manifest);
      await hooks.upload?.(body);
      if (!current) return Response.json({ id: snapshotId, projectId, manifest: body.manifest });
      return Response.json({
        snapshotId,
        projectId,
        status: 'uploading',
        files: body.manifest.files.map(file => {
          const objectKey = `snapshots/${file.sha256.slice(0, 2)}/${file.sha256}`;
          return {
            ...file,
            upload: {
              method: 'PUT',
              objectKey,
              url: `${route}/${snapshotId}/objects/${objectKey}`,
            },
          };
        }),
      });
    }
    if (init.method === 'PUT') {
      const sha256 = route.split('/').at(-1);
      assert.equal(hash(Buffer.from(init.body)), sha256);
      await hooks.put?.();
      return Response.json({});
    }
    if (route.endsWith('/complete')) {
      const snapshotId = route.split('/').at(-2);
      assert.ok(snapshots.has(snapshotId));
      await hooks.complete?.();
      return Response.json({ snapshotId, projectId, status: 'ready' });
    }
    throw Error('Unexpected fixture request: ' + route);
  };
  const options = { directory, environment, fetch, account };
  const settings = new RemoteSettings(options);
  settings.setLocation(projectDir, 'test', 'remote');
  return {
    settings,
    options,
    projectDir,
    directory,
    environment,
    projectId,
    canonicalProjectId,
    requests,
    uploads,
    hooks,
  };
}
async function approve(f, remember = false) {
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt'], { remember });
  return f.settings.sync(f.projectDir, 'test', review.id);
}
function change(f, content = 'changed task input') {
  fs.writeFileSync(path.join(f.projectDir, 'input.txt'), content);
}
function pending(f, changes) {
  const root = path.join(f.directory, 'remote-invocations');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'pending.json'),
    JSON.stringify({
      remoteProjectId: f.projectId,
      serviceIdentity: f.settings.identity(),
      ...changes,
    }),
  );
}

test('MCP v1 discovery ignores product release metadata and retains read-only planning', async t => {
  for (const version of [
    '1.0.0',
    '1.1.0',
    '1.1.1',
    '1.2.0',
    '1.2.1',
    '1.2.12',
    '1.3.0',
    '1.3.1',
    '1.3.12',
    '1.4.0',
    '2.0.0',
    '20.7.99',
    '1.2',
    '1.3.1-rc.1',
    '1.3.1+build',
    '1.02.1',
    '1.2.01',
    'development',
    '',
    null,
    1.2,
    {},
    ['1.3.1'],
    undefined,
  ]) {
    const f = fixture(t, { serviceInfo: { version } });
    const connection = await f.settings.check();
    assert.equal(connection.status, 'connected', `${version}: ${connection.reason}`);
    assert.equal(connection.protocol, '1.1');
    assert.deepEqual(connection.executableDomains, []);
    assert.equal(f.settings.read().service.gatewayContract, 'mcp-v1');
    const review = await f.settings.review(f.projectDir, 'test', ['input.txt']);
    assert.equal(review.files[0].path, 'input.txt');
    await assert.rejects(
      f.settings.ensurePrepared(f.projectDir, 'test'),
      /Prepare and approve the task input files/,
    );
    assert.ok(f.requests.every(request => request.method === 'GET'));
    assert.equal(f.settings.project(f.projectDir, 'test').remoteProjectId, undefined);
  }
});

test('observed MCP gateway product 1.3.1 connects without granting execution or uploading inputs', async t => {
  const f = fixture(t, {
    serviceInfo: {
      version: '1.3.1',
      domainCatalog: [],
      // Metadata claims must not bypass protected live discovery/qualification.
      capabilities: { protectedExecution: true },
      domainCapabilities: [{ domain: 'test', qualification: 'qualified' }],
    },
  });
  const connection = await f.settings.check();
  assert.equal(connection.status, 'connected', connection.reason);
  assert.equal(connection.protocol, '1.1');
  assert.deepEqual(connection.executableDomains, []);
  assert.equal(connection.capabilities.protectedExecution, undefined);
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt']);
  assert.equal(review.files[0].path, 'input.txt');
  assert.ok(
    f.requests.every(request => request.route === '/v1/service-info' && request.method === 'GET'),
  );
  assert.equal(f.uploads.length, 0);
  assert.equal(f.settings.project(f.projectDir, 'test').remoteProjectId, undefined);
});

test('product upgrades preserve the MCP contract and existing project binding', async t => {
  const serviceInfo = { version: '1.3.1' };
  const f = fixture(t, { serviceInfo });
  const binding = await f.settings.bind(f.projectDir, 'test');
  const identity = f.settings.identity();
  const before = f.requests.length;
  for (const version of ['1.4.0', '2.0.0', 'development', undefined]) {
    serviceInfo.version = version;
    const connection = await f.settings.check();
    assert.equal(connection.status, 'connected', `${version}: ${connection.reason}`);
    assert.equal(f.settings.identity(), identity);
    assert.deepEqual(await f.settings.bind(f.projectDir, 'test'), binding);
    assert.equal(f.settings.read().service.gatewayContract, 'mcp-v1');
    assert.deepEqual(connection.executableDomains, []);
  }
  assert.ok(f.requests.slice(before).every(request => request.method === 'GET'));
  assert.equal(f.requests.filter(request => request.route === '/v1/projects').length, 1);
  assert.equal(f.uploads.length, 0);
});

test('malformed MCP v1 service envelopes report the incompatible field and remain read-only', async t => {
  for (const [change, reason] of [
    [{ sessionModel: 'project-session' }, /sessionModel/],
    [{ sessionModel: undefined }, /sessionModel/],
    [{ domains: ['test', 2] }, /domains/],
    [{ domains: null }, /domains/],
    [{ domainCatalog: {} }, /domainCatalog/],
    [{ domainCatalog: undefined }, /domainCatalog/],
    [{ capabilitySnapshotHash: 'bad-hash' }, /capabilitySnapshotHash/],
    [{ capabilitySnapshotHash: 'A'.repeat(64) }, /capabilitySnapshotHash/],
    [{ capabilitySnapshotHash: undefined }, /capabilitySnapshotHash/],
    [{ remoteProtocolVersion: '1.0' }, /does not support the remote execution protocol 1.1/],
    [{ remoteProtocolVersion: '2.0' }, /does not support the remote execution protocol 1.1/],
    [{ remoteProtocolVersion: null }, /does not support the remote execution protocol 1.1/],
    [
      { remoteProtocolVersion: '1.1' },
      /Invalid remote service info:.*canonicalSchemaVersion.*serverId/,
    ],
  ]) {
    const f = fixture(t, { serviceInfo: { version: '2.0.0-rc.1', ...change } });
    const connection = await f.settings.check();
    assert.equal(connection.status, 'unavailable', JSON.stringify(change));
    assert.match(connection.reason, reason);
    await assert.rejects(
      f.settings.review(f.projectDir, 'test', ['input.txt']),
      /unavailable for this domain/,
    );
    assert.ok(f.requests.every(request => request.method === 'GET'));
    assert.equal(f.settings.read().service, undefined);
  }
});

test('canonical gateway schema and service identity checks remain independent of product versions', async t => {
  const valid = fixture(t, { current: false, serviceInfo: { version: '2.0.0' } });
  assert.equal((await valid.settings.check()).status, 'connected');
  for (const [change, field] of [
    [{ canonicalSchemaVersion: '2' }, /canonicalSchemaVersion/],
    [{ canonicalSchemaVersion: undefined }, /canonicalSchemaVersion/],
    [{ serverId: '' }, /serverId/],
    [{ serverId: undefined }, /serverId/],
    [{ domains: null }, /domains/],
    [{ sessionModel: undefined }, /sessionModel/],
  ]) {
    const f = fixture(t, { current: false, serviceInfo: change });
    const connection = await f.settings.check();
    assert.equal(connection.status, 'unavailable');
    assert.match(connection.reason, /Invalid remote service info:/);
    assert.match(connection.reason, field);
    assert.equal(f.settings.read().service, undefined);
    assert.ok(f.requests.every(request => request.method === 'GET'));
  }
});

test('planning does not upload and freezes exact files, hashes, destination and remembered choice', async t => {
  const f = fixture(t);
  const files = ['input.txt'];
  const review = await f.settings.review(f.projectDir, 'test', files, { remember: true });
  files.push('never-approved.txt');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(review.destination, 'https://remote.example');
  assert.equal(review.remember, true);
  assert.equal(review.manifestDigest, selectedSnapshot(f.projectDir, ['input.txt']).digest);
  assert.equal(review.files[0].sha256, hash('task input'));
  assert.ok(
    Object.isFrozen(review) && Object.isFrozen(review.files) && Object.isFrozen(review.files[0]),
  );
  assert.equal(f.settings.approvalReview(f.projectDir, 'test', review.id), review);
  await f.settings.sync(f.projectDir, 'test', review.id);
  assert.deepEqual(
    f.uploads[0].manifest.files.map(file => file.path),
    ['input.txt'],
  );
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id), /expired/);
});

test('changed approved bytes, changed binding and empty snapshots require a fresh plan', async t => {
  const f = fixture(t);
  await assert.rejects(f.settings.review(f.projectDir, 'test', []), /1 and 256/);
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt']);
  change(f);
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id), /changed/);
  const changed = await f.settings.review(f.projectDir, 'test', ['input.txt']);
  f.settings.setLocation(f.projectDir, 'test', 'local');
  assert.throws(
    () => f.settings.approvalReview(f.projectDir, 'test', changed.id),
    /binding changed/,
  );
  assert.equal(f.uploads.length, 0);
});

test('manual uploads stay strict and automatic preparation reuses unchanged snapshots', async t => {
  const f = fixture(t);
  await assert.rejects(f.settings.ensurePrepared(f.projectDir, 'test'), /Prepare and approve/);
  const binding = await approve(f);
  const before = f.requests.length;
  assert.equal(
    (await f.settings.ensurePrepared(f.projectDir, 'test')).snapshotId,
    binding.snapshotId,
  );
  assert.equal(f.requests.length, before);
  change(f);
  await assert.rejects(f.settings.ensureSynced(f.projectDir, 'test'), /changed/);
  await assert.rejects(f.settings.ensurePrepared(f.projectDir, 'test'), /Prepare and approve/i);
  assert.equal(f.uploads.length, 1);
});

test('remembered exact-file authorization survives restart and refreshes contents without adding new files', async t => {
  const f = fixture(t);
  const first = await approve(f, true);
  change(f);
  fs.writeFileSync(path.join(f.projectDir, 'new-dependency.txt'), 'not yet approved');
  f.settings = new RemoteSettings(f.options);
  await assert.rejects(f.settings.ensureSynced(f.projectDir, 'test'), /changed/);
  const next = await f.settings.ensurePrepared(f.projectDir, 'test');
  assert.notEqual(next.snapshotId, first.snapshotId);
  assert.equal(f.uploads[1].baseSnapshotId, first.snapshotId);
  assert.deepEqual(
    f.uploads[1].manifest.files.map(file => file.path),
    ['input.txt'],
  );
  assert.equal(f.uploads[1].manifest.files[0].sha256, hash('changed task input'));
  const requests = f.requests.length;
  assert.equal((await f.settings.ensurePrepared(f.projectDir, 'test')).snapshotId, next.snapshotId);
  assert.equal(f.requests.length, requests);
});

test('new paths cannot inherit an existing remembered grant and a one-time review revokes remembering', async t => {
  const f = fixture(t);
  await approve(f, true);
  fs.writeFileSync(path.join(f.projectDir, 'new.txt'), 'new dependency');
  f.settings.update(f.projectDir, 'test', { files: ['input.txt', 'new.txt'] });
  await assert.rejects(f.settings.ensurePrepared(f.projectDir, 'test'), /approve/);
  assert.equal(f.uploads.length, 1);
  await approve(f);
  assert.equal(f.settings.project(f.projectDir, 'test').syncPolicy, null);
  change(f);
  await assert.rejects(f.settings.ensurePrepared(f.projectDir, 'test'), /approve/);
});

for (const record of [
  { status: 'unknown' },
  { status: 'queued' },
  { status: 'provisioning' },
  { status: 'collecting' },
  { status: 'completed', needsImport: true },
]) {
  test(`pending ${JSON.stringify(record)} blocks snapshot reuse and refresh before network calls`, async t => {
    const f = fixture(t);
    await approve(f, true);
    pending(f, record);
    const requests = f.requests.length;
    await assert.rejects(
      f.settings.ensurePrepared(f.projectDir, 'test'),
      /active or unknown|needs import/,
    );
    change(f);
    await assert.rejects(
      f.settings.ensurePrepared(f.projectDir, 'test'),
      /active or unknown|needs import/,
    );
    assert.equal(f.requests.length, requests);
  });
}

for (const unsafe of ['secret', 'symlink', 'size']) {
  test(`remembering never bypasses ${unsafe} input checks`, async t => {
    const f = fixture(t);
    await approve(f, true);
    if (unsafe === 'secret') change(f, '{"password":"never-upload-this"}');
    if (unsafe === 'size') change(f, Buffer.alloc(8 * 1048576 + 1));
    if (unsafe === 'symlink') {
      fs.unlinkSync(path.join(f.projectDir, 'input.txt'));
      fs.writeFileSync(path.join(f.projectDir, 'other.txt'), 'other');
      fs.symlinkSync('other.txt', path.join(f.projectDir, 'input.txt'));
    }
    const requests = f.requests.length;
    await assert.rejects(f.settings.ensurePrepared(f.projectDir, 'test'));
    assert.equal(f.requests.length, requests);
  });
}

test('credential changes invalidate both an approval and a persisted remembered authorization', async t => {
  const f = fixture(t);
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt'], { remember: true });
  f.environment.TEST_REMOTE_TOKEN = 'different-fixture-token';
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id), /expired/);
  f.environment.TEST_REMOTE_TOKEN = 'fixture-only-token';
  await approve(f, true);
  change(f);
  f.environment.TEST_REMOTE_TOKEN = 'different-fixture-token';
  const requests = f.requests.length;
  await assert.rejects(
    f.settings.ensurePrepared(f.projectDir, 'test'),
    /another service or credential/,
  );
  assert.equal(f.requests.length, requests);
});

test('cancellation before preparation or during service check dispatches no upload', async t => {
  const f = fixture(t);
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt']);
  const before = new AbortController();
  before.abort();
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id, { signal: before.signal }));
  const during = new AbortController();
  f.hooks.request = route => {
    if (route === '/v1/service-info') during.abort();
  };
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id, { signal: during.signal }));
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('configuration switch between manifest and blob dispatch cannot send project contents', async t => {
  const f = fixture(t);
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt'], { remember: true });
  f.hooks.upload = () => {
    f.environment.INDUSTRIAL_REMOTE_SERVICE_URL = 'https://other.example';
  };
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id));
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0);
  assert.equal(f.settings.project(f.projectDir, 'test').snapshotId, undefined);
  assert.equal(f.settings.project(f.projectDir, 'test').syncPolicy, undefined);
});

test('cancellation after upload response does not commit a usable snapshot or remembered grant', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt'], { remember: true });
  f.hooks.complete = () => controller.abort();
  await assert.rejects(
    f.settings.sync(f.projectDir, 'test', review.id, { signal: controller.signal }),
  );
  assert.equal(f.settings.project(f.projectDir, 'test').snapshotId, undefined);
  assert.equal(f.settings.project(f.projectDir, 'test').syncPolicy, undefined);
});

test('account switch during token acquisition blocks the first mutation and upload', async t => {
  let subject = 'first';
  let switchAccount = false;
  const account = {
    identity: 'fixture-account',
    config: { remoteOrigin: 'https://remote.example' },
    view: () => ({ user: { sub: subject } }),
    serviceToken: async () => {
      if (switchAccount) subject = 'second';
      return 'fixture-token';
    },
  };
  const f = fixture(t, { account });
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt'], { remember: true });
  switchAccount = true;
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id));
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

for (const current of [true, false]) {
  test(`binding preserves ${current ? 'the planning' : 'the authoritative service'} canonical project identity`, async t => {
    const f = fixture(t, { current });
    const planningId = hash('planning project');
    f.settings.update(f.projectDir, 'test', { canonicalProjectId: planningId });
    const binding = await approve(f);
    assert.equal(binding.canonicalProjectId, current ? planningId : f.canonicalProjectId);
  });
}

test('revoking remembered authorization during preflight prevents automatic refresh', async t => {
  const f = fixture(t);
  await approve(f, true);
  change(f);
  f.hooks.request = route => {
    if (route === '/v1/service-info') f.settings.update(f.projectDir, 'test', { syncPolicy: null });
  };
  await assert.rejects(f.settings.ensurePrepared(f.projectDir, 'test'), /authorization changed/);
  assert.equal(f.uploads.length, 1);
});

test('files changed while creating the remote project are never uploaded under the old review', async t => {
  const f = fixture(t);
  const review = await f.settings.review(f.projectDir, 'test', ['input.txt']);
  f.hooks.request = route => {
    if (route === '/v1/projects') change(f);
  };
  await assert.rejects(f.settings.sync(f.projectDir, 'test', review.id), /Selected files changed/);
  assert.equal(f.uploads.length, 0);
});

test('service identity changing during connection cleanup cannot inherit the previous ready check', async t => {
  const f = fixture(t);
  const client = f.settings.client.bind(f.settings);
  f.settings.client = (...args) => {
    const control = client(...args);
    control.close = async () => {
      f.environment.TEST_REMOTE_TOKEN = 'new-fixture-identity';
    };
    return control;
  };
  assert.equal((await f.settings.check()).status, 'unchecked');
});
