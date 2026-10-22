const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/task-process.cjs'), 'utf8');

function writeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture executable', { mode: 0o755 });
  return file;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-task-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'selected');
  fs.mkdirSync(project, { recursive: true });
  return {
    root,
    project,
    bundle(name = 'Harness With Spaces', parent = path.join(root, 'Applications')) {
      const app = path.join(parent, name + '.app');
      const contents = path.join(app, 'Contents');
      fs.mkdirSync(contents, { recursive: true });
      fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist/>');
      const executable = writeExecutable(path.join(contents, 'MacOS', name));
      return { app, contents, executable };
    },
    async run({
      target,
      execPath = path.join(root, 'host-node'),
      platform = 'darwin',
      electron = false,
      projectDir = project,
      omitProjectDir = false,
      environment = {},
      filesystem = {},
      readOnlyDirs = [],
      homeDir = os.homedir(),
    }) {
      const directory = path.join(projectDir, '.harness-runs', 'runtime-check');
      const input = path.join(directory, 'input');
      const work = path.join(directory, 'work');
      fs.mkdirSync(input, { recursive: true });
      fs.mkdirSync(work, { recursive: true });
      const bin = path.join(root, 'sandbox-tools');
      writeExecutable(path.join(bin, 'bwrap'));
      const calls = [];
      const module = { exports: {} };
      const dependencies = {
        'node:fs': {
          ...fs,
          existsSync: file =>
            file === '/usr/bin/sandbox-exec' ? platform === 'darwin' : fs.existsSync(file),
          statSync: (file, ...options) =>
            file === '/dev'
              ? { isDirectory: () => true, isFile: () => false }
              : fs.statSync(file, ...options),
          ...filesystem,
        },
        'node:path': path,
        'node:os': { ...os, homedir: () => homeDir },
        'node:child_process': {
          spawnSync: () => assert.fail('Local execution must not probe a Docker subprocess.'),
          spawn(command, args, options) {
            calls.push({ command, args: Array.from(args), options });
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => assert.fail('A completed fixture subprocess should not be killed.');
            queueMicrotask(() => child.emit('close', 0, null));
            return child;
          },
        },
        './workspace-files.cjs': {
          hash: bytes => createHash('sha256').update(bytes).digest('hex'),
        },
        './docker-cli.cjs': {
          resolveDockerCli: () => assert.fail('A local task must not resolve Docker.'),
        },
      };
      vm.runInNewContext(source, {
        module,
        process: {
          platform,
          arch: 'x64',
          execPath,
          versions: electron ? { electron: 'fixture' } : {},
          env: {},
        },
        require: name => {
          assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
          return dependencies[name];
        },
        Buffer,
        setTimeout,
        clearTimeout,
      });
      const result = await module.exports.executeTask(
        { command: [target, '-e', '0'], runtime: { kind: 'local', readOnlyDirs }, timeoutMs: 5000 },
        {
          ...(!omitProjectDir ? { projectDir } : {}),
          directory,
          input,
          work,
          actionId: 'runtime-check',
          environment: { PATH: bin, ...environment },
        },
      );
      assert.equal(result.status, 'COMPLETED');
      assert.equal(calls.length, 1);
      return {
        result,
        identity: result.identity,
        call: calls[0],
        roots: Array.from(result.identity.readOnlyRoots),
        profile:
          platform === 'darwin' ? fs.readFileSync(path.join(directory, 'task.sb'), 'utf8') : null,
      };
    },
  };
}

test('macOS bundle runtime grants only Contents and resolves a framework symlink', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle();
  const framework = path.join(bundle.contents, 'Frameworks', 'Electron Framework.framework');
  const actual = path.join(framework, 'Versions', 'A', 'Electron Framework');
  fs.mkdirSync(path.dirname(actual), { recursive: true });
  fs.writeFileSync(actual, 'fixture framework');
  const current = path.join(framework, 'Versions', 'Current');
  fs.symlinkSync(path.dirname(actual), current, 'junction');
  let library = path.join(current, 'Electron Framework');
  if (process.platform !== 'win32') {
    library = path.join(framework, 'Electron Framework');
    fs.symlinkSync(path.join('Versions', 'Current', 'Electron Framework'), library, 'file');
  }
  assert.equal(fs.realpathSync(library), fs.realpathSync(actual));
  const { roots, profile } = await instance.run({ target: bundle.executable });
  const contents = fs.realpathSync(bundle.contents);
  assert.ok(roots.includes(contents), 'The framework installation must be readable.');
  assert.equal(path.relative(contents, fs.realpathSync(library)).startsWith('..'), false);
  assert.ok(profile.includes(`(subpath ${JSON.stringify(contents)})`));
  for (const forbidden of [bundle.app, path.dirname(bundle.app), instance.root, instance.project])
    assert.equal(roots.includes(fs.realpathSync(forbidden)), false, forbidden);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(deny network\*\)/);
});

test('embedded interpreters use the enclosing bundle even with an uppercase APP extension', async t => {
  const instance = fixture(t);
  const app = path.join(instance.root, 'Applications', 'Embedded Runtime.APP');
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist/>');
  for (const location of [
    ['Resources', 'bin', 'python'],
    ['Frameworks', 'Python.framework', 'Versions', 'A', 'bin', 'python'],
  ]) {
    const executable = writeExecutable(path.join(contents, ...location));
    const { roots, profile } = await instance.run({ target: executable });
    const canonical = fs.realpathSync(contents);
    assert.ok(roots.includes(canonical), executable);
    assert.ok(profile.includes(`(subpath ${JSON.stringify(canonical)})`));
    assert.equal(roots.includes(fs.realpathSync(app)), false);
    assert.equal(roots.includes(fs.realpathSync(path.dirname(app))), false);
  }
});

test('a nested helper bundle grants its own Contents without exposing the outer application', async t => {
  const instance = fixture(t);
  const outer = instance.bundle('Outer');
  const helpers = path.join(outer.contents, 'Frameworks');
  const helper = instance.bundle('Nested Helper', helpers);
  const { roots, profile } = await instance.run({ target: helper.executable });
  const ownContents = fs.realpathSync(helper.contents);
  assert.ok(roots.includes(ownContents));
  assert.ok(profile.includes(`(subpath ${JSON.stringify(ownContents)})`));
  for (const forbidden of [helper.app, helpers, outer.contents, outer.app]) {
    const canonical = fs.realpathSync(forbidden);
    assert.equal(roots.includes(canonical), false, forbidden);
    assert.equal(profile.includes(`(subpath ${JSON.stringify(canonical)})`), false, forbidden);
  }
});

test('a MacOS-looking directory without Info.plist does not expand runtime reads', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle();
  fs.rmSync(path.join(bundle.contents, 'Info.plist'));
  const { roots } = await instance.run({ target: bundle.executable });
  assert.ok(roots.includes(fs.realpathSync(bundle.executable)));
  assert.equal(roots.includes(fs.realpathSync(bundle.contents)), false);
});

for (const omitProjectDir of [false, true]) {
  test(`a bundle in the project cannot expose unselected sources (${omitProjectDir ? 'inferred' : 'explicit'} project)`, async t => {
    const instance = fixture(t);
    const bundle = instance.bundle('Project Tool', instance.project);
    const { roots } = await instance.run({ target: bundle.executable, omitProjectDir });
    assert.equal(roots.includes(fs.realpathSync(bundle.contents)), false);
    assert.equal(roots.includes(fs.realpathSync(instance.project)), false);
  });
}

test('a runtime bundle containing the project does not expose its enclosing Contents', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle();
  const projectDir = path.join(bundle.contents, 'Resources', 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const { roots } = await instance.run({ target: bundle.executable, projectDir });
  assert.equal(roots.includes(fs.realpathSync(bundle.contents)), false);
});

test('a launch alias inside a fake bundle cannot expose that bundle', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle();
  const external = writeExecutable(
    path.join(instance.root, 'standalone', path.basename(bundle.executable)),
  );
  const launchDirectory = path.dirname(bundle.executable);
  fs.rmSync(launchDirectory, { recursive: true });
  fs.symlinkSync(path.dirname(external), launchDirectory, 'junction');
  const { roots } = await instance.run({ target: bundle.executable });
  assert.ok(roots.includes(fs.realpathSync(external)));
  assert.equal(roots.includes(fs.realpathSync(bundle.contents)), false);
  assert.equal(roots.includes(path.dirname(external)), false);
});

test('the current macOS Electron runtime receives trusted Node mode', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle();
  const { call, identity, roots } = await instance.run({
    target: bundle.executable,
    execPath: bundle.executable,
    electron: true,
    environment: { ELECTRON_RUN_AS_NODE: '0', NODE_OPTIONS: '--inspect' },
  });
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(identity.runAsNode, true);
  assert.ok(roots.includes(fs.realpathSync(bundle.contents)));
});

test('a canonical alias of the current Electron executable retains Node mode', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle();
  const aliasDirectory = path.join(instance.root, 'electron-alias');
  fs.symlinkSync(path.dirname(bundle.executable), aliasDirectory, 'junction');
  const alias = path.join(aliasDirectory, path.basename(bundle.executable));
  const { call, roots } = await instance.run({
    target: alias,
    execPath: bundle.executable,
    electron: true,
  });
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(roots.includes(fs.realpathSync(bundle.contents)));
  assert.equal(roots.includes(fs.realpathSync(instance.root)), false);
});

test('standalone Node tasks cannot inherit an untrusted Electron mode or runtime root', async t => {
  const instance = fixture(t);
  const node = writeExecutable(path.join(instance.root, 'node-runtime', 'node'));
  const { call, identity, roots } = await instance.run({
    target: node,
    execPath: node,
    environment: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' },
  });
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(Boolean(identity.runAsNode), false);
  assert.equal(roots.includes(path.dirname(node)), false);
});

test('other native executables are not forced into the host Electron Node mode', async t => {
  const instance = fixture(t);
  const host = instance.bundle('Host');
  const tool = instance.bundle('Native Tool');
  const { call, identity } = await instance.run({
    target: tool.executable,
    execPath: host.executable,
    electron: true,
    environment: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(Boolean(identity.runAsNode), false);
});

test('Linux Electron binds its exact installation read-only and receives Node mode', async t => {
  const instance = fixture(t);
  const install = path.join(instance.root, 'electron-install');
  const executable = writeExecutable(path.join(install, 'electron'));
  fs.writeFileSync(path.join(install, 'libffmpeg.so'), 'fixture library');
  fs.writeFileSync(path.join(install, 'icudtl.dat'), 'fixture runtime data');
  const { call, identity, roots } = await instance.run({
    platform: 'linux',
    target: executable,
    execPath: executable,
    electron: true,
  });
  const canonical = fs.realpathSync(install);
  assert.ok(roots.includes(canonical));
  const mount = call.args.findIndex(
    (arg, index) => arg === '--ro-bind' && call.args[index + 1] === canonical,
  );
  assert.ok(mount >= 0, 'The installation must be mounted read-only.');
  assert.equal(call.args[mount + 2], canonical);
  assert.equal(roots.includes(fs.realpathSync(instance.root)), false);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(identity.runAsNode, true);
});

test('Linux native executables do not gain the Electron installation directory', async t => {
  const instance = fixture(t);
  const install = path.join(instance.root, 'other-runtime');
  const executable = writeExecutable(path.join(install, 'native-tool'));
  fs.writeFileSync(path.join(install, 'icudtl.dat'), 'fixture runtime data');
  const host = writeExecutable(path.join(instance.root, 'host-runtime', 'electron'));
  const { call, roots } = await instance.run({
    platform: 'linux',
    target: executable,
    execPath: host,
    electron: true,
    environment: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(roots.includes(fs.realpathSync(install)), false);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('Linux Electron cannot automatically expose an installation overlapping the project', async t => {
  const instance = fixture(t);
  const executable = writeExecutable(path.join(instance.project, 'runtime', 'electron'));
  fs.writeFileSync(path.join(path.dirname(executable), 'icudtl.dat'), 'fixture runtime data');
  const { roots } = await instance.run({
    platform: 'linux',
    target: executable,
    execPath: executable,
    electron: true,
  });
  assert.equal(roots.includes(fs.realpathSync(path.dirname(executable))), false);
  assert.equal(roots.includes(fs.realpathSync(instance.project)), false);
});

test('Linux Electron without runtime installation data does not expose its parent directory', async t => {
  const instance = fixture(t);
  const executable = writeExecutable(path.join(instance.root, 'unqualified-runtime', 'electron'));
  const { call, roots } = await instance.run({
    platform: 'linux',
    target: executable,
    execPath: executable,
    electron: true,
  });
  assert.equal(roots.includes(fs.realpathSync(path.dirname(executable))), false);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('Linux Electron never grants the shared temporary directory as a runtime root', async t => {
  const instance = fixture(t);
  const shared = fs.realpathSync(os.tmpdir());
  const executable = path.join(shared, 'harness-fixture-electron');
  const data = path.join(shared, 'icudtl.dat');
  const virtualFile = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
  const { roots } = await instance.run({
    platform: 'linux',
    target: executable,
    execPath: executable,
    electron: true,
    filesystem: {
      accessSync: (file, ...args) => {
        if (file !== executable) fs.accessSync(file, ...args);
      },
      statSync: (file, ...args) =>
        file === executable || file === data ? virtualFile : fs.statSync(file, ...args),
      lstatSync: (file, ...args) =>
        file === executable || file === data ? virtualFile : fs.lstatSync(file, ...args),
      realpathSync: (file, ...args) =>
        file === executable || file === data ? file : fs.realpathSync(file, ...args),
      readFileSync: (file, ...args) =>
        file === executable ? Buffer.from('fixture executable') : fs.readFileSync(file, ...args),
    },
  });
  assert.equal(roots.includes(shared), false);
  assert.ok(roots.includes(executable));
});

function assertNotGranted(result, directory) {
  for (const root of new Set([directory, fs.realpathSync(directory)])) {
    assert.equal(result.roots.includes(root), false, root);
    assert.equal(
      result.profile?.includes(`(subpath ${JSON.stringify(root)})`) ?? false,
      false,
      root,
    );
  }
}

test('an embedded project interpreter does not auto-expose unselected Resources', async t => {
  const instance = fixture(t);
  const bundle = instance.bundle('Project Python', instance.project);
  const resources = path.join(bundle.contents, 'Resources');
  const executable = writeExecutable(path.join(resources, 'bin', 'python'));
  const result = await instance.run({ target: executable });
  assertNotGranted(result, resources);
  assertNotGranted(result, bundle.contents);
});

test('a project tools/bin executable does not auto-expose the tools directory', async t => {
  const instance = fixture(t);
  const tools = path.join(instance.project, 'tools');
  const executable = writeExecutable(path.join(tools, 'bin', 'tool'));
  const result = await instance.run({ target: executable });
  assertNotGranted(result, tools);
});

test('a project bin alias cannot grant its unselected sibling source files', async t => {
  const instance = fixture(t);
  const external = writeExecutable(path.join(instance.root, 'external-runtime', 'bin', 'tool'));
  const tools = path.join(instance.project, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.symlinkSync(path.dirname(external), path.join(tools, 'bin'), 'junction');
  const result = await instance.run({ target: path.join(tools, 'bin', 'tool') });
  assertNotGranted(result, tools);
  assert.ok(result.roots.includes(fs.realpathSync(path.resolve(external, '..', '..'))));
});

function virtualEnvironment(instance) {
  const base = writeExecutable(path.join(instance.root, 'base-python', 'bin', 'python'));
  const environment = path.join(instance.root, 'real-venv');
  fs.mkdirSync(environment);
  fs.writeFileSync(path.join(environment, 'pyvenv.cfg'), 'fixture venv');
  fs.symlinkSync(path.dirname(base), path.join(environment, 'bin'), 'junction');
  const alias = path.join(instance.root, 'managed-alias');
  fs.symlinkSync(environment, alias, 'junction');
  return { base, environment, alias, executable: path.join(alias, 'bin', 'python') };
}

test('a venv launch alias grants its canonical configuration and library directory', async t => {
  const instance = fixture(t);
  const venv = virtualEnvironment(instance);
  const result = await instance.run({ target: venv.executable });
  const canonical = fs.realpathSync(venv.environment);
  assert.ok(result.roots.includes(canonical), 'Seatbelt must allow the resolved venv directory.');
  assert.ok(result.profile.includes(`(subpath ${JSON.stringify(canonical)})`));
  assert.equal(result.identity.launchPath, venv.executable);
});

test('a Linux venv launch alias retains a safe read-only mount at its launch location', async t => {
  const instance = fixture(t);
  const venv = virtualEnvironment(instance);
  const result = await instance.run({ platform: 'linux', target: venv.executable });
  const canonical = fs.realpathSync(venv.environment);
  assert.ok(result.roots.includes(canonical));
  assert.ok(result.roots.includes(venv.alias));
  const mounts = result.call.args.flatMap((arg, index, args) =>
    arg === '--ro-bind' ? [{ source: args[index + 1], destination: args[index + 2] }] : [],
  );
  assert.ok(
    mounts.some(mount => mount.source === canonical && mount.destination === venv.alias),
    'The checked venv installation must also exist at the preserved launch alias.',
  );
  assert.equal(result.identity.launchPath, venv.executable);
});

test('an installation prefix containing the project does not expose that project', async t => {
  const instance = fixture(t);
  const installation = path.join(instance.root, 'installation');
  const executable = writeExecutable(path.join(installation, 'bin', 'tool'));
  const projectDir = path.join(installation, 'project');
  fs.mkdirSync(projectDir);
  const result = await instance.run({ target: executable, projectDir });
  assertNotGranted(result, installation);
});

test('an alias of the user local directory does not bypass shared-prefix exclusions', async t => {
  const instance = fixture(t);
  const homeDir = path.join(instance.root, 'test-home');
  const local = path.join(homeDir, '.local');
  const executable = writeExecutable(path.join(local, 'bin', 'tool'));
  const alias = path.join(instance.root, 'alias-local');
  fs.symlinkSync(local, alias, 'junction');
  const result = await instance.run({ target: path.join(alias, 'bin', 'tool'), homeDir });
  assertNotGranted(result, local);
  assertNotGranted(result, alias);
  assert.equal(result.roots.includes(fs.realpathSync(executable)), true);
});

test('explicit readOnlyDirs continue to authorize a checked project dependency', async t => {
  const instance = fixture(t);
  const tools = path.join(instance.project, 'tools');
  const executable = writeExecutable(path.join(tools, 'bin', 'tool'));
  const result = await instance.run({ target: executable, readOnlyDirs: [tools] });
  const canonical = fs.realpathSync(tools);
  assert.ok(result.roots.includes(canonical));
  assert.ok(result.profile.includes(`(subpath ${JSON.stringify(canonical)})`));
});
