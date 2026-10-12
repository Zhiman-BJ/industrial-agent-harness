const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerRuntimeEnvironments } = require('./runtime-environments.cjs');
function setup(connectionStore) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-env-ipc-'));
  const handlers = new Map();
  const bundle = {
    domain: 'fixture',
    version: '1.0.0',
    executionProfiles: [
      {
        id: 'native',
        label: 'Native',
        kind: 'native',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: [],
        assetIds: ['app'],
      },
      {
        id: 'remote',
        label: 'Service',
        kind: 'remote',
        qualified: true,
        platforms: [`${process.platform}-${process.arch}`],
        toolIds: [],
        assetIds: [],
        connection: {
          kind: 'runtime-managed',
          verification: 'runtime-handshake',
          environment: [
            { name: 'INDUSTRIAL_HARNESS_TEST_ENDPOINT', type: 'endpoint' },
            { name: 'INDUSTRIAL_HARNESS_TEST_TOKEN', type: 'secret' },
          ],
        },
      },
    ],
    runtimeAssets: [
      {
        id: 'app',
        label: 'App',
        installUrl: 'https://example.com/download',
        environment: 'FIXTURE',
        executable: 'bin/tool',
      },
    ],
  };
  const opened = [];
  registerRuntimeEnvironments({
    ipcMain: { handle: (id, handler) => handlers.set(id, handler) },
    connectionStore,
    manager: {
      directory,
      list: () => [bundle],
      runtimeAssets: { status: () => [] },
      withLock: async callback => callback(),
      assertIdle() {},
    },
    resourceProject: (_event, request) =>
      request.projectId === undefined
        ? null
        : {
            id: request.projectId,
            domain: request.projectId === 'other' ? 'other-domain' : 'fixture',
            path: directory,
          },
    sessions: { assertIdle() {}, async reset() {} },
    projectRuntimes: { async close() {}, async reset() {} },
    dialog: {
      async showOpenDialog() {
        return { canceled: true };
      },
    },
    shell: {
      async openExternal(url) {
        opened.push(url);
      },
    },
  });
  return {
    call: (id, request) => handlers.get(`environment:${id}`)({}, request),
    directory,
    opened,
  };
}
test('environment IPC validates domain, profile, project context and asset paths', async () => {
  const h = setup();
  try {
    assert.throws(() => h.call('describe', { domain: '../escape' }), /Invalid environment/);
    assert.throws(
      () => h.call('describe', { domain: 'fixture', projectId: 'other' }),
      /another project domain/,
    );
    assert.throws(
      () => h.call('describe', { domain: 'fixture', profileId: 'unknown' }),
      /Unknown execution profile/,
    );
    assert.throws(
      () =>
        h.call('describe', {
          domain: 'fixture',
          profileId: 'native',
          paths: { arbitrary: '/tmp' },
        }),
      /Invalid application paths/,
    );
    assert.throws(
      () =>
        h.call('describe', { domain: 'fixture', profileId: 'native', paths: { app: 'relative' } }),
      /Invalid application paths/,
    );
    assert.equal(h.call('describe', { domain: 'fixture' }).profiles.length, 2);
    await assert.rejects(
      h.call('official', { domain: 'fixture', profileId: 'native', assetId: 'unknown' }),
      /unavailable/,
    );
    await h.call('official', {
      domain: 'fixture',
      profileId: 'native',
      assetId: 'app',
      url: 'https://evil.example',
    });
    assert.deepEqual(h.opened, ['https://example.com/download']);
    assert.equal(
      await h.call('choose-app', { domain: 'fixture', profileId: 'native', assetId: 'app' }),
      null,
    );
  } finally {
    fs.rmSync(h.directory, { recursive: true, force: true });
  }
});

test('connection IPC restricts declared fields and returns no saved secret', async () => {
  const records = new Map();
  const h = setup({
    available: () => true,
    read: key => records.get(key),
    write: (key, value) => records.set(key, value),
    remove: key => records.delete(key),
  });
  const request = { domain: 'fixture', profileId: 'remote' };
  try {
    await assert.rejects(
      h.call('connection-save', { ...request, values: { ARBITRARY_ENV: 'bad' } }),
      /Invalid service/,
    );
    await assert.rejects(
      h.call('connection-save', {
        ...request,
        values: { INDUSTRIAL_HARNESS_TEST_ENDPOINT: 'http://remote.example' },
      }),
      /Invalid/,
    );
    const result = await h.call('connection-save', {
      ...request,
      values: {
        INDUSTRIAL_HARNESS_TEST_ENDPOINT: 'https://remote.example',
        INDUSTRIAL_HARNESS_TEST_TOKEN: 'private-token-value',
      },
    });
    assert.equal(result.configured, true);
    assert.equal(result.executable, true);
    assert.equal(result.status, 'unchecked');
    assert.equal(JSON.stringify(result).includes('private-token-value'), false);
    const retained = await h.call('connection-save', {
      ...request,
      values: { INDUSTRIAL_HARNESS_TEST_TOKEN: '' },
    });
    assert.equal(retained.configured, true);
    const removed = await h.call('connection-save', {
      ...request,
      values: { INDUSTRIAL_HARNESS_TEST_TOKEN: null },
    });
    assert.equal(removed.configured, false);
    await assert.rejects(
      h.call('connection-reset', { domain: 'fixture', profileId: 'native' }),
      /Unknown service/,
    );
    const reset = await h.call('connection-reset', request);
    assert.equal(reset.configured, false);
    assert.equal(records.size, 0);
  } finally {
    fs.rmSync(h.directory, { recursive: true, force: true });
  }
});
