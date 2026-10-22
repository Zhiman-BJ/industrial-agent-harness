const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function resolver(platform, executables = []) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const files = new Set(executables);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/docker-cli.cjs'), 'utf8'), {
    module,
    process: { platform, env: {} },
    require(name) {
      if (name === 'node:path') return paths;
      if (name === 'node:os')
        return { homedir: () => (platform === 'win32' ? 'C:\\Users\\fallback' : '/fallback') };
      if (name === 'node:fs')
        return {
          constants: { X_OK: 1 },
          accessSync(file) {
            if (!files.has(file)) throw Error('Missing fixture executable.');
          },
          statSync: file => ({ isFile: () => files.has(file) }),
          realpathSync: file => file,
        };
      if (name === 'node:child_process')
        return { spawn: () => assert.fail('PATH resolution must not start a child process.') };
      throw Error('Unexpected module: ' + name);
    },
    setTimeout,
    clearTimeout,
  });
  return module.exports;
}

test('Windows Docker discovery reads Path from a cloned environment without changing it', async () => {
  const executable = 'C:\\Custom Docker\\bin\\docker.exe';
  const cli = resolver('win32', [executable]);
  const environment = { Path: 'C:\\missing;C:\\Custom Docker\\bin', OTHER: 'preserved' };
  const before = { ...environment };
  const resolved = await cli.resolveDockerCli(environment, {
    wellKnown: () => [],
    capture: () => assert.fail('A PATH match must not invoke a login shell.'),
  });
  assert.equal(resolved?.docker, executable);
  assert.equal(resolved.via, 'PATH');
  assert.equal(resolved.environment, environment);
  assert.deepEqual(environment, before);
  assert.ok(cli.dockerSearchLocations(environment).includes('C:\\Custom Docker\\bin'));
});

test('Windows well-known installs accept mixed-case ProgramFiles and LocalAppData keys', () => {
  const system = 'C:\\Applications\\Docker\\Docker\\resources\\bin\\docker.exe';
  const user =
    'C:\\Users\\test\\AppData\\Local\\Programs\\Docker\\Docker\\resources\\bin\\docker.exe';
  const cli = resolver('win32', [system, user]);
  const environment = {
    pAtH: 'C:\\missing',
    PROGRAMFILES: 'C:\\Applications',
    LocalAppData: 'C:\\Users\\test\\AppData\\Local',
  };
  assert.ok(cli.wellKnownDockerPaths(environment).includes(system));
  assert.ok(cli.wellKnownDockerPaths(environment).includes(user));
  assert.equal(cli.resolveDockerCliSync(environment)?.docker, system);
  const userOnly = { ...environment };
  delete userOnly.PROGRAMFILES;
  assert.equal(cli.resolveDockerCliSync(userOnly)?.docker, user);
});

test('Windows PATH discovery remains first when a mixed-case well-known install also exists', () => {
  const chosen = 'C:\\chosen\\docker.exe';
  const installed = 'C:\\Applications\\Docker\\Docker\\resources\\bin\\docker.exe';
  const cli = resolver('win32', [chosen, installed]);
  const resolved = cli.resolveDockerCliSync({
    path: 'C:\\chosen',
    programfiles: 'C:\\Applications',
  });
  assert.equal(resolved?.docker, chosen);
  assert.equal(resolved.via, 'PATH');
});

test('POSIX Docker discovery keeps environment keys case-sensitive', () => {
  const executable = '/custom/bin/docker';
  const cli = resolver('linux', [executable]);
  assert.equal(cli.resolveDockerCliSync({ Path: '/custom/bin' }, { wellKnown: () => [] }), null);
  assert.equal(
    cli.resolveDockerCliSync({ PATH: '/custom/bin' }, { wellKnown: () => [] })?.docker,
    executable,
  );
  assert.ok(
    cli.wellKnownDockerPaths({ home: '/ignored' }).includes('/fallback/.docker/bin/docker'),
  );
  assert.ok(
    cli.wellKnownDockerPaths({ HOME: '/selected' }).includes('/selected/.docker/bin/docker'),
  );
});
