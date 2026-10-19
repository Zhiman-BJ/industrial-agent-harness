const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  windowsEnvironment,
  inside,
  quoteWindowsArgument,
  buildMxcPolicy,
  assertMxcProbe,
  hostReadRoots,
} = require('../src/windows-sandbox.cjs');
const { createSession } = require('../src/code-session.cjs');

test('Windows credential exclusions are case insensitive and environment keys have one effective value', () => {
  assert.deepEqual(
    windowsEnvironment(
      {
        PATH: 'first',
        Path: 'last',
        SERVICE_TOKEN: 'secret',
        service_token: 'another',
        EMPTY: '',
        OMIT: undefined,
      },
      ['Service_Token'],
    ),
    { Path: 'last', EMPTY: '' },
  );
});

test('Windows storage comparisons distinguish sibling prefixes, volumes and path case', () => {
  assert.equal(inside('C:\\Session', 'c:\\session\\workspace'), true);
  assert.equal(inside('C:\\Session', 'C:\\SESSION'), true);
  assert.equal(inside('C:\\Session', 'C:\\Session-other'), false);
  assert.equal(inside('C:\\Session', 'C:\\Session\\..\\project'), false);
  assert.equal(inside('C:\\Session', 'D:\\Session\\workspace'), false);
});

test('Windows MXC command lines preserve literal CRT arguments without a shell', () => {
  const cases = [
    ['', '""'],
    ['plain', '"plain"'],
    ['two words', '"two words"'],
    ['a"quoted"value', String.raw`"a\"quoted\"value"`],
    ['C:\\directory with spaces\\', '"C:\\directory with spaces\\\\"'],
    ['\\"quoted', String.raw`"\\\"quoted"`],
    ['尾部 Unicode', '"尾部 Unicode"'],
    ['& | < > ^ % !', '"& | < > ^ % !"'],
    ['line\tbreak\n', '"line\tbreak\n"'],
  ];
  for (const [input, expected] of cases)
    assert.equal(quoteWindowsArgument(input), expected, JSON.stringify(input));
  for (const input of [undefined, null, 1, {}, ['argument'], 'embedded\0nul'])
    assert.throws(() => quoteWindowsArgument(input), /argument|NUL|string/i);
});

function mxcLaunch(overrides = {}) {
  return {
    executable: 'C:\\Program Files\\Node\\node.exe',
    args: ['C:\\runtime\\main.mjs', 'web', '--port', '12345'],
    workingDirectory: 'C:\\Sessions\\one\\workspace',
    writableRoots: ['C:\\Sessions\\one', 'C:\\Boundary\\scratch'],
    readonlyRoots: ['C:\\Projects\\design', 'C:\\runtime', 'C:\\HarnessState'],
    environment: { Path: 'C:\\Windows\\System32', KIMI_CODE_HOME: 'C:\\Sessions\\one' },
    ...overrides,
  };
}

test('Windows MXC policies permit only declared storage and explicitly refuse DACL fallback', t => {
  const name = 'HARNESS_TEST_MXC_HOST_ONLY';
  const previous = process.env[name];
  process.env[name] = 'host-only-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  const input = mxcLaunch();
  const policy = buildMxcPolicy(input);
  assert.deepEqual(policy, {
    version: '1.0.0',
    containment: 'processcontainer',
    fallback: { allowDaclMutation: false },
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    filesystem: {
      readwritePaths: input.writableRoots,
      readonlyPaths: input.readonlyRoots,
    },
    process: {
      commandLine:
        '"C:\\Program Files\\Node\\node.exe" "C:\\runtime\\main.mjs" "web" "--port" "12345"',
      cwd: input.workingDirectory,
      env: ['Path=C:\\Windows\\System32', 'KIMI_CODE_HOME=C:\\Sessions\\one'],
      inheritDefaultEnv: false,
    },
    network: {
      egress: { default: 'allow' },
      ingress: { default: 'deny', hostLoopback: 'allow' },
    },
    ui: { disable: false, clipboard: 'none', injection: false },
    processContainer: {
      capabilities: ['registryRead'],
      leastPrivilege: false,
      ui: {
        isolation: 'desktop',
        desktopSystemControl: false,
        systemSettings: 'none',
        ime: false,
      },
    },
    telemetry: { enabled: false },
  });
  assert.equal(
    policy.process.env.some(value => value.startsWith(name + '=')),
    false,
  );
  assert.deepEqual(buildMxcPolicy(mxcLaunch({ environment: {} })).process.env, []);
});

test('Windows MXC policies reject ambiguous launches before creating a command', () => {
  for (const overrides of [
    { executable: 'node.exe' },
    { workingDirectory: 'workspace' },
    { writableRoots: [] },
    { writableRoots: ['C:\\Sessions\\one'] },
    { writableRoots: ['C:\\Sessions\\one', 'C:\\Boundary\\scratch', 'C:\\extra'] },
    { args: ['safe', 'embedded\0nul'] },
  ])
    assert.throws(() => buildMxcPolicy(mxcLaunch(overrides)), /absolute|root|argument|NUL/i);
});

function supportedMxcProbe(overrides = {}) {
  return {
    tier: 'base-container',
    needsDaclAugmentation: false,
    warnings: [],
    probes: {
      baseContainerApiPresent: true,
      baseContainerSupportsIngressHostLoopbackAllow: true,
    },
    ...overrides,
  };
}

test('Windows MXC requires a usable BaseContainer for the complete requested policy', () => {
  assert.doesNotThrow(() => assertMxcProbe(supportedMxcProbe()));
  for (const probe of [
    undefined,
    null,
    {},
    [],
    'base-container',
    supportedMxcProbe({ tier: 'appcontainer-dacl' }),
    supportedMxcProbe({ tier: 'appcontainer-bfs' }),
    supportedMxcProbe({ tier: 'unknown' }),
    supportedMxcProbe({ tier: undefined }),
    supportedMxcProbe({ needsDaclAugmentation: true }),
    supportedMxcProbe({ needsDaclAugmentation: undefined }),
    supportedMxcProbe({ needsDaclAugmentation: 'false' }),
    supportedMxcProbe({ error: 'PSEC policy cannot be represented' }),
    supportedMxcProbe({ probes: undefined }),
    supportedMxcProbe({ probes: {} }),
    supportedMxcProbe({
      probes: {
        baseContainerApiPresent: false,
        baseContainerSupportsIngressHostLoopbackAllow: true,
      },
    }),
    supportedMxcProbe({
      probes: {
        baseContainerApiPresent: true,
        baseContainerSupportsIngressHostLoopbackAllow: false,
      },
    }),
  ])
    assert.throws(() => assertMxcProbe(probe), /MXC|PSEC|BaseContainer|probe/i);
});

test('Windows packaged read grants use physical ASAR archives instead of virtual members', () => {
  const archive = 'C:\\Apps\\Harness\\resources\\app.asar';
  const uppercaseArchive = 'C:\\Apps\\Other\\resources\\APP.ASAR';
  const virtualMembers = [
    archive + '\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs',
    archive + '\\node_modules\\@industrial-agent-harness\\agent-kimi\\src\\index.cjs',
    uppercaseArchive + '\\electron\\main.cjs',
  ];
  const unpacked = archive + '.unpacked\\node_modules\\runtime\\native.exe';
  const fileSystem = {
    readdirSync(volume) {
      assert.equal(volume, 'C:\\');
      return [{ name: 'Apps' }];
    },
    realpathSync(file) {
      assert.equal(file, 'C:\\Apps');
      return file;
    },
  };
  const roots = hostReadRoots([...virtualMembers, archive, unpacked], fileSystem);
  assert.deepEqual(roots, [archive, uppercaseArchive, unpacked, 'C:\\', 'C:\\Apps']);
  const policy = buildMxcPolicy(mxcLaunch({ readonlyRoots: roots }));
  assert.deepEqual(policy.filesystem.readonlyPaths, roots);
  assert.equal(
    policy.filesystem.readonlyPaths.some(file => /\.asar\\/i.test(file)),
    false,
    'native filesystem grants must never contain an Electron virtual archive member',
  );
});

test('Windows implicit read grants omit inaccessible paging files without losing explicit roots', () => {
  const explicit = ['D:\\Projects\\design', 'D:\\Runtime\\node.exe'];
  const errors = new Map([
    ['D:\\DumpStack.log.tmp', 'EINVAL'],
    ['D:\\pagefile.sys', 'EPERM'],
  ]);
  const fileSystem = {
    readdirSync(volume) {
      assert.equal(volume, 'D:\\');
      return ['Projects', 'Runtime', 'DumpStack.log.tmp', 'pagefile.sys'].map(name => ({ name }));
    },
    realpathSync(file) {
      if (errors.has(file))
        throw Object.assign(Error('system file metadata unavailable'), { code: errors.get(file) });
      return file;
    },
  };
  assert.deepEqual(hostReadRoots(explicit, fileSystem), [
    ...explicit,
    'D:\\',
    'D:\\Projects',
    'D:\\Runtime',
  ]);
  assert.throws(
    () =>
      hostReadRoots(explicit, {
        ...fileSystem,
        realpathSync() {
          throw Object.assign(Error('I/O failure'), { code: 'EIO' });
        },
      }),
    /I\/O failure/,
  );
});

test('native session dispatch uses the protected launcher and never restores a removed host credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-protected-dispatch-'));
  const name = 'HARNESS_TEST_HOST_ONLY_DISPATCH';
  const previous = process.env[name];
  process.env[name] = 'host-only-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
  let calls = 0;
  const session = createSession({
    workDir: directory,
    shareDir: directory,
    env: { PATH: process.env.PATH },
    envIsolated: true,
    spawn(_executable, _args, options) {
      calls++;
      assert.equal(options.env[name], undefined);
      assert.equal(options.env.KIMI_CODE_HOME, directory);
      throw Error('controlled boundary launch refusal');
    },
  });
  t.after(() => session.close());
  await assert.rejects(session.initialize(), /controlled boundary launch refusal/);
  assert.equal(calls, 1, 'launcher refusal must not fall back to an unprotected spawn');
  assert.equal(session.child, undefined);
});
