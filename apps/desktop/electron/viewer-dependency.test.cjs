const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const {
  resolveViewerInterpreter,
  ResolvedViewerService,
  pythonModuleProbe,
} = require('./viewer-dependency.cjs');

const unavailableMessage =
  'Layout viewer needs preparation. Open Settings → Domains, then choose Prepare / repair viewers.';
const overrideMessage =
  'KLAYOUT_PYTHON cannot run the required KLayout Python modules. Correct the override and reopen the layout.';

function resolve(options = {}) {
  return resolveViewerInterpreter({
    unavailableMessage,
    overrideMessage,
    resolveManaged: () => undefined,
    legacy: process.execPath,
    ...options,
  });
}

test('an explicit interpreter is authoritative, including invalid explicit overrides', () => {
  let managedCalls = 0;
  const resolveManaged = () => {
    managedCalls++;
    return process.execPath;
  };
  assert.equal(resolve({ override: process.execPath, resolveManaged }).python, process.execPath);
  for (const override of ['', '/missing/viewer-python', os.tmpdir()])
    assert.throws(() => resolve({ override, resolveManaged, allowLegacy: true }), {
      message: overrideMessage,
    });
  assert.equal(managedCalls, 0, 'Invalid explicit configuration must not silently fall back.');
  assert.throws(
    () =>
      resolve({
        override: process.execPath,
        resolveManaged,
        allowLegacy: true,
        validateOverride: pythonModuleProbe(['klayout.db', 'klayout.lay']),
      }),
    { message: overrideMessage },
    'An executable that cannot import the required Python modules is also an invalid override.',
  );
  assert.equal(managedCalls, 0);
});

test('managed dependencies precede legacy environments; packaged callers cannot use legacy', () => {
  assert.equal(resolve({ resolveManaged: () => process.execPath }).python, process.execPath);
  assert.throws(() => resolve(), { message: unavailableMessage });
  assert.equal(resolve({ allowLegacy: true }).python, process.execPath);
  assert.throws(
    () => resolve({ resolveManaged: () => '/missing/managed-python', allowLegacy: true }),
    { message: unavailableMessage },
  );
});

test('service replacement, repair and missing dependencies close the previous worker', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-viewer-dependency-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const python = path.join(directory, 'python');
  const otherPython = path.join(directory, 'other-python');
  for (const file of [python, otherPython]) fs.writeFileSync(file, 'fixture', { mode: 0o755 });
  let selected = python;
  let resolutions = 0;
  let configuration = 'initial';
  const created = [];
  const session = new ResolvedViewerService(
    () => {
      resolutions++;
      return resolve({ resolveManaged: () => selected });
    },
    interpreter => {
      const service = {
        python: interpreter,
        closes: 0,
        close() {
          this.closes++;
        },
      };
      created.push(service);
      return service;
    },
    { configurationKey: () => configuration },
  );
  const first = session.get();
  for (let render = 0; render < 50; render++) assert.equal(session.get(), first);
  assert.equal(resolutions, 1, 'Repeated renders only stat the selected interpreter.');
  assert.equal(session.get(true), first);
  assert.equal(resolutions, 2, 'Each new artifact open resolves the Pack declaration again.');
  selected = otherPython;
  const second = session.get(true);
  assert.equal(first.closes, 1);
  assert.notEqual(second, first);
  fs.writeFileSync(otherPython, 'repaired fixture interpreter with a new identity');
  const third = session.get();
  assert.equal(second.closes, 1);
  assert.notEqual(
    third,
    second,
    'Replacing an interpreter at the same path invalidates the worker.',
  );
  assert.equal(resolutions, 4, 'A changed interpreter identity reruns shared resolution.');
  configuration = 'explicit-override-changed';
  assert.equal(session.get(), third);
  assert.equal(resolutions, 5, 'Configuration changes also rerun shared resolution.');
  third.failure = 'worker stopped';
  const recovered = session.get();
  assert.equal(third.closes, 1);
  session.close();
  assert.equal(recovered.closes, 1);
  const afterRepair = session.get();
  assert.notEqual(afterRepair, recovered, 'Explicit repair close always resolves a fresh worker.');
  assert.equal(resolutions, 7, 'Failure and repair each rerun shared resolution.');
  selected = undefined;
  assert.throws(() => session.get(true), { message: unavailableMessage });
  assert.equal(afterRepair.closes, 1, 'A missing dependency must never leave the old worker live.');
  assert.equal(created.length, 5);
});

test('production preload keeps viewer repair on the existing repair IPC and preserves full repair', async () => {
  let host;
  const calls = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        if (name === 'viewerHost') host = value;
      },
    },
    ipcRenderer: {
      invoke: (...args) => {
        calls.push(args);
        return Promise.resolve({});
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    process: { platform: process.platform },
    require: name => {
      assert.equal(name, 'electron');
      return electron;
    },
  });
  await host.domainRepair('example-domain', { scope: 'viewer' });
  await host.domainRepair('example-domain');
  await host.domainInstall(['example-domain'], { scope: 'viewer' });
  await host.domainInstall(['example-domain']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['domains:repair', { domain: 'example-domain', scope: 'viewer' }],
    ['domains:repair', { domain: 'example-domain' }],
    ['domains:install', { domains: ['example-domain'], scope: 'viewer' }],
    ['domains:install', { domains: ['example-domain'] }],
  ]);
});

test('installed viewer readiness stays independent of external engineering tools', async () => {
  const { domainPreparationState } = await import('../src/components/domain-readiness.mjs');
  const external = { runtimeState: 'external-dependencies' };
  assert.deepEqual(domainPreparationState(external), {
    runtimeRepair: false,
    runtimeReady: false,
    viewerState: undefined,
  });
  for (const ready of [true, false]) {
    assert.deepEqual(domainPreparationState({ ...external, viewerAssets: [{ ready }] }), {
      runtimeRepair: false,
      runtimeReady: false,
      viewerState: ready ? 'ready' : 'needs-preparation',
    });
  }
  assert.equal(
    domainPreparationState({ runtimeState: 'ready', viewerState: 'needs-preparation' })
      .runtimeRepair,
    true,
  );
  assert.equal(
    domainPreparationState({ viewerAssets: [{ ready: true }, { ready: false }] }).viewerState,
    'needs-preparation',
  );
});

test('dependency IPC diagnostics recover translatable product messages in both languages', async () => {
  const { viewerDependencyMessage } = await import('../src/components/domain-readiness.mjs');
  const { translate } = await import('../src/i18n/core.ts');
  const { messages } = require('../i18n.config.json');
  for (const message of [unavailableMessage, overrideMessage]) {
    const decorated = `Error: Error invoking remote method 'viewer:open': Error: ${message}`;
    const key = viewerDependencyMessage(decorated);
    assert.equal(key, message);
    assert.equal(translate('en', key), message);
    assert.notEqual(translate('zh-CN', key), message);
  }
  assert.equal(viewerDependencyMessage('Artifact content changed; reopen the file.'), undefined);
  for (const key of [
    'Viewers ready',
    'Viewers need preparation',
    'Check / repair viewers',
    'Prepare / repair viewers',
    'Open domain settings',
    'Retry viewer',
    'Install viewer support',
  ]) {
    for (const locale of ['en', 'zh-CN']) assert.ok(messages[key][locale], `${key}: ${locale}`);
  }
});
