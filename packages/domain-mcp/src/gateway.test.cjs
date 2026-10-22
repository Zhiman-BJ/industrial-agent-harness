const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { providerRuntime, gatewayConfig, resolveGatewayScript } = require('./gateway.cjs');

const { sourceHash } = require('../../domain-skills/src/index.cjs').packGatewayAdapter({
  packId: 'chip-pack',
});

test('provider resolution pins source and requires explicit absolute runtime overrides', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-runtime-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'eda-harness');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  for (const [name, text] of [
    ['pyproject.toml', 'fixture'],
    ['uv.lock', 'fixture'],
    ['src/runtime.py', 'fixture'],
  ])
    fs.writeFileSync(path.join(source, name), text);
  const python = path.join(directory, 'python');
  fs.writeFileSync(python, 'fixture executable never launched');
  const provider = {
    id: 'fixture',
    packId: 'chip-pack',
    packDirectory: 'chip',
    title: 'Fixture',
    directoryEnv: 'FIXTURE_PACK',
    pythonEnv: 'FIXTURE_PYTHON',
    sourceSha256: sourceHash(source),
  };
  const environment = { FIXTURE_PACK: directory, FIXTURE_PYTHON: python };
  assert.deepEqual(providerRuntime(provider, environment), {
    sourceDir: fs.realpathSync(source),
    python,
  });
  assert.throws(
    () => providerRuntime(provider, { ...environment, FIXTURE_PACK: 'relative' }),
    /absolute/,
  );
  assert.throws(
    () => providerRuntime(provider, { ...environment, FIXTURE_PYTHON: 'relative' }),
    /Python environment/,
  );
  assert.throws(
    () => gatewayConfig(directory, provider, undefined, environment),
    /explicit absolute project/,
  );
  const config = gatewayConfig(directory, provider, directory, environment, {
    gatewayScript: '/untrusted/override.py',
  });
  assert.equal(config.command, python);
  assert.equal(config.args[0], resolveGatewayScript());
  assert.equal(JSON.parse(fs.readFileSync(config.args[1])).projectDir, fs.realpathSync(directory));
  fs.writeFileSync(path.join(source, 'src/runtime.py'), 'changed');
  assert.throws(() => providerRuntime(provider, environment), /registered snapshot/);
});

test('gateway script resolution preserves source paths and requires physical unpacked files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ['source', 'app.asar-assets/src', 'app.asar.unpacked/src']) {
    const directory = path.join(root, relative);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'gateway.py'), '# fixture\n');
    assert.equal(resolveGatewayScript(directory), path.join(directory, 'gateway.py'));
  }
  const archive = path.join(root, 'app.asar');
  fs.writeFileSync(archive, 'an archive is a file, not a Python-readable directory');
  const archived = path.join(archive, 'node_modules', 'domain-mcp', 'src');
  const unpacked = path.join(archive + '.unpacked', 'node_modules', 'domain-mcp', 'src');
  assert.throws(() => resolveGatewayScript(archived), /missing or unreadable.*Reinstall/);
  fs.mkdirSync(path.join(unpacked, 'gateway.py'), { recursive: true });
  assert.throws(() => resolveGatewayScript(archived), /missing or unreadable.*Reinstall/);
  fs.rmdirSync(path.join(unpacked, 'gateway.py'));
  fs.writeFileSync(path.join(unpacked, 'gateway.py'), '# fixture\n');
  assert.equal(resolveGatewayScript(archived), path.join(unpacked, 'gateway.py'));
});

test('Desktop packaging unpacks the Python gateway used by the registered MCP adapter', () => {
  const config = require('../../../electron-builder.config.cjs');
  assert.equal(config.asar, true);
  assert.ok(
    config.asarUnpack.includes('node_modules/@industrial-agent-harness/domain-mcp/src/gateway.py'),
    'The external interpreter needs the gateway as a real file outside app.asar.',
  );
});

test('registered gateway providers reach the physical script through session MCP configuration', t => {
  const { loadRegistry } = require('@industrial-agent-harness/domain-skills');
  const { selectMcpServers, writeMcpConfig } = require('./index.cjs');
  const provider = loadRegistry().providerPacks.find(
    pack => pack.provider.transport === 'gateway',
  )?.provider;
  assert.ok(provider, 'A registered gateway provider must exercise the production adapter.');
  const selected = selectMcpServers({
    domain: provider.domain,
    tools: provider.tools.map(tool => tool.id),
  });
  assert.ok(selected.some(item => item.id === provider.id));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-session-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = writeMcpConfig(directory, selected, {
    projectDir: directory,
    environment: { [provider.pythonEnv]: process.execPath },
  });
  const config = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[provider.id];
  assert.equal(config.args[0], resolveGatewayScript());
  assert.equal(fs.statSync(config.args[0]).isFile(), true);
});

test('an external interpreter reads the shipped gateway through its unpacked path', t => {
  const python = ['python3', 'python'].find(
    command =>
      spawnSync(command, ['-I', '-c', 'import sys; sys.exit(0)'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      }).status === 0,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-external-python-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = path.join('node_modules', '@industrial-agent-harness', 'domain-mcp', 'src');
  const archive = path.join(root, 'app.asar');
  fs.writeFileSync(archive, 'archive');
  const unpacked = path.join(archive + '.unpacked', relative);
  fs.mkdirSync(unpacked, { recursive: true });
  const bytes = fs.readFileSync(resolveGatewayScript());
  fs.writeFileSync(path.join(unpacked, 'gateway.py'), bytes);
  const script = resolveGatewayScript(path.join(archive, relative));
  const args = python
    ? [
        '-I',
        '-c',
        'import hashlib,pathlib,sys; p=pathlib.Path(sys.argv[1]); data=p.read_bytes(); compile(data,str(p),"exec"); print(hashlib.sha256(data).hexdigest())',
        script,
      ]
    : [
        '-e',
        'const fs=require("node:fs"),crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));',
        script,
      ];
  // Plain Node provides the same unpatched filesystem boundary on hosts that
  // lack Python; when Python is present, also compile the actual shipped bytes.
  t.diagnostic(python ? 'External Python read and compile' : 'External plain Node physical read');
  const digest = execFileSync(python || process.execPath, args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(digest.trim(), crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fs.existsSync(path.join(archive, relative, 'gateway.py')), false);
});
