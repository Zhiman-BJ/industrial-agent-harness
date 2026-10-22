const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('../src/index.cjs');

function electronHost(t) {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: '40.0.0', configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(process.versions, 'electron', original);
    else delete process.versions.electron;
  });
}

async function launch(t, config = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sdk-runtime-'));
  const cliPath = path.join(projectDir, 'cli.cjs');
  fs.writeFileSync(
    cliPath,
    `process.stdout.write(JSON.stringify({schemaVersion:1,type:'result',mode:process.env.ELECTRON_RUN_AS_NODE ?? null,marker:process.env.SDK_RUNTIME_MARKER})+'\\n');`,
  );
  const client = createClient({
    projectDir,
    cliPath,
    domain: 'chip',
    ...config,
    environment: { ...config.environment, SDK_RUNTIME_MARKER: 'cli-child' },
  });
  t.after(async () => {
    await client.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  const handle = client.run({ task: 'Inspect the child runtime', timeoutMs: 5000 });
  for await (const event of handle.events) assert.equal(event.schemaVersion, 1);
  const result = (await handle.result).result;
  assert.equal(result.marker, 'cli-child');
  return result;
}

test('SDK selects Node mode when an Electron host reuses its own executable', async t => {
  electronHost(t);
  for (const nodeExecutable of [undefined, process.execPath]) {
    await t.test(nodeExecutable ? 'explicit current executable' : 'default executable', async t => {
      const environment = { ELECTRON_RUN_AS_NODE: '0' };
      const result = await launch(t, { nodeExecutable, environment });
      assert.equal(result.mode, '1');
      assert.equal(environment.ELECTRON_RUN_AS_NODE, '0');
    });
  }
});

test('SDK preserves the configured environment for an ordinary Node host', async t => {
  for (const mode of [undefined, '', 'custom-node-setting']) {
    const result = await launch(t, { environment: { ELECTRON_RUN_AS_NODE: mode } });
    assert.equal(result.mode, mode ?? null);
  }
});

test('SDK recognizes a filesystem alias of the current Electron executable', async t => {
  electronHost(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sdk-alias-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'runtime');
  fs.symlinkSync(path.dirname(process.execPath), alias, 'junction');
  // Windows also accepts forward-slash executable paths; their canonical
  // identity must be recognized just like paths emitted by path.join().
  const interpreter = path.join(alias, path.basename(process.execPath)).split(path.sep).join('/');
  const result = await launch(t, {
    nodeExecutable: interpreter,
    environment: { ELECTRON_RUN_AS_NODE: '0' },
  });
  assert.equal(result.mode, '1');
});

test('SDK does not force Electron Node mode on a different custom interpreter', async t => {
  electronHost(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sdk-interpreter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const interpreter = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, interpreter);
  else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(interpreter, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, {
      mode: 0o700,
    });
  }
  const result = await launch(t, {
    nodeExecutable: interpreter,
    environment: { ELECTRON_RUN_AS_NODE: 'custom-interpreter-setting' },
  });
  assert.equal(result.mode, 'custom-interpreter-setting');
});
