#!/usr/bin/env node
// Opt-in real CLI/installer QA. Only new stores and child environments change.
// The signed feed is loopback TLS with exact owner Pack bytes; Docker is real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { signCatalog } = require('../packages/pack-manager/src/index.cjs');
const { createLocalhostCertificate } = require('../packages/pack-manager/src/localhost-tls.cjs');
const owner = require('@zhiman-bj/industrial-domain-packs');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('This fresh-install prerequisite QA is qualified only for macOS arm64.');
if (process.argv.length !== 3 || !process.argv[2] || process.argv[2].startsWith('-'))
  throw Error('Usage: node scripts/qa-fresh-install-prerequisites.cjs NEW_EVIDENCE_DIRECTORY');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(path.dirname(output), { recursive: true });
try {
  fs.mkdirSync(output);
} catch (error) {
  if (error.code === 'EEXIST')
    throw Error('Use a new evidence directory: ' + output, { cause: error });
  throw error;
}
const anchor = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim();
fs.writeFileSync(
  path.join(output, 'git-status.txt'),
  spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).stdout,
);
const summary = {
  startedAt: new Date().toISOString(),
  commit: anchor,
  owner: owner.identity,
  ownerPin: require('../package.json').dependencies['@zhiman-bj/industrial-domain-packs'],
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cases: [],
  boundaries: [
    'Actual production CLI, Pack verification, runtime preparation and Docker; no installer/fetch mocks.',
    'QA-signed loopback HTTPS catalog carries exact owner Pack archives; not a production release feed.',
    'Fresh stores/config/HOME; cached global images retained. No native application installation.',
    'CUDA service backend and GPU execution are not qualified by this script.',
  ],
};
const cli = path.join(root, 'apps/cli/src/main.cjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const keyFile = path.join(output, 'ephemeral-signing-key.pem');
const keysFile = path.join(output, 'trusted-qa-public-key.json');
fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(
  keysFile,
  JSON.stringify({ qa: publicKey.export({ type: 'spki', format: 'pem' }) }),
);
const tls = createLocalhostCertificate();
const caFile = path.join(output, 'localhost-ca.pem');
fs.writeFileSync(caFile, tls.cert);
const release = path.join(output, 'release');
const safePath = '/usr/bin:/bin:/usr/sbin:/sbin';
const cleanEnv = { ...process.env, NODE_EXTRA_CA_CERTS: caFile };
delete cleanEnv.INDUSTRIAL_HARNESS_PACK_STORE;
for (const name of Object.keys(cleanEnv))
  if (name.startsWith('INDUSTRIAL_HARNESS_CUDA_')) delete cleanEnv[name];
// Read the user's selected Docker context, without changing its config/cache.
cleanEnv.DOCKER_CONFIG = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
function environment(store, extra = {}) {
  const home = path.join(store, 'qa-home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...cleanEnv,
    HOME: home,
    INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(store, 'qa-config'),
    INDUSTRIAL_HARNESS_PACK_STORE: store,
    ...extra,
  };
}
async function child(
  name,
  args,
  env,
  { cancelOnBytes = false, script = cli, timeoutMs = 120000 } = {},
) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      tail = '',
      cancelled = false,
      expired = false,
      force;
    const timer = setTimeout(() => {
      expired = true;
      proc.kill('SIGTERM');
      force = setTimeout(() => proc.kill('SIGKILL'), 10000);
    }, timeoutMs);
    proc.stdout.on('data', bytes => {
      stdout += bytes;
      tail += bytes;
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          cancelOnBytes &&
          !cancelled &&
          row.type === 'runtime_progress' &&
          row.phase === 'downloading' &&
          row.received > 0
        ) {
          cancelled = true;
          proc.kill('SIGINT');
        }
      }
    });
    proc.stderr.on('data', bytes => {
      stderr += bytes;
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(force);
      fs.writeFileSync(path.join(output, name + '.stdout.log'), stdout);
      fs.writeFileSync(path.join(output, name + '.stderr.log'), stderr);
      const rows = stdout
        .trim()
        .split('\n')
        .flatMap(line => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const result = {
        code,
        signal,
        cancelled,
        expired,
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr,
        rows,
      };
      fs.writeFileSync(path.join(output, name + '.result.json'), JSON.stringify(result, null, 2));
      if (expired) reject(Error(name + ' exceeded its deadline'));
      else resolve(result);
    });
  });
}
function leftovers(store) {
  const found = [];
  const visit = file => {
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
      const child = path.join(file, entry.name);
      if (/\.partial$|\.tmp$|^\.staging-|^\.previous-|^(prepare|install)\.lock$/.test(entry.name))
        found.push(path.relative(store, child));
      if (entry.isDirectory()) visit(child);
    }
  };
  if (fs.existsSync(store)) visit(store);
  return found;
}
async function listed(name, store, env) {
  const result = await child(name, ['domains', 'list', '--store', store], env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function cleanFailure(list, store, outcome) {
  assert.deepEqual(list.installed, []);
  assert.equal(list.lastOperation.active, false);
  assert.equal(list.lastOperation.outcome, outcome);
  assert.deepEqual(leftovers(store), []);
}
let server;
(async () => {
  const build = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/build-pack-distribution.cjs'), release],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...cleanEnv,
        HARNESS_PACK_DOMAINS: 'chip,cuda',
        HARNESS_PACK_CHANNEL: 'stable',
        HARNESS_PACK_SIGNING_KEY_FILE: keyFile,
        HARNESS_PACK_SIGNING_KEY_ID: 'qa',
      },
      timeout: 30000,
    },
  );
  fs.rmSync(keyFile, { force: true });
  fs.writeFileSync(path.join(output, 'build.log'), build.stdout + build.stderr);
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const catalog = JSON.parse(fs.readFileSync(path.join(release, 'catalog.json'))).payload;
  const transfers = [];
  server = https.createServer(tls, (req, res) => {
    transfers.push({ at: new Date().toISOString(), path: req.url });
    if (req.url.startsWith('/catalog')) {
      const slow = req.url.includes('cancel');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          signCatalog(
            {
              ...catalog,
              packs: catalog.packs.map(entry => ({
                ...entry,
                url: '/' + (slow ? 'slow/' : '') + path.basename(entry.url),
              })),
            },
            'qa',
            privateKey,
          ),
        ),
      );
    } else {
      const entry = catalog.packs.find(
        item => req.url === '/' + item.url || req.url === '/slow/' + item.url,
      );
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      const bytes = fs.readFileSync(path.join(release, entry.url));
      res.writeHead(200, { 'content-length': bytes.length });
      if (req.url.startsWith('/slow/')) res.write(bytes.subarray(0, 70000));
      else res.end(bytes);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'https://127.0.0.1:' + server.address().port;
  const installArgs = (domain, store, mode = 'good') => [
    'domains',
    'install',
    domain,
    '--catalog',
    base + '/catalog-' + mode,
    '--keys-file',
    keysFile,
    '--store',
    store,
  ];
  assert.ok(safePath, 'Missing-Docker PATH qualification requires macOS arm64.');
  const noDocker = spawnSync('docker', ['--version'], {
    env: { ...cleanEnv, PATH: safePath },
    encoding: 'utf8',
  });
  assert.equal(noDocker.error?.code, 'ENOENT', 'Limited PATH must really omit Docker.');
  for (const mode of ['missing-docker', 'unreachable-daemon']) {
    const store = path.join(output, mode + '-store');
    // Unix socket addresses have a short OS limit; the deep evidence path must
    // not turn an unavailable-daemon test into a malformed-endpoint test.
    const absentSocket =
      '/tmp/harness-qa-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.sock';
    assert.equal(fs.existsSync(absentSocket), false);
    const env = environment(
      store,
      mode === 'missing-docker' ? { PATH: safePath } : { DOCKER_HOST: 'unix://' + absentSocket },
    );
    if (mode === 'unreachable-daemon') delete env.DOCKER_CONTEXT;
    const attempt = await child(mode, installArgs('chip', store), env);
    assert.equal(attempt.code, 1, attempt.stdout + attempt.stderr);
    assert.match(
      attempt.stdout,
      /Docker runtime is unavailable.*Install and start Docker.*retry preparation/,
    );
    if (mode === 'unreachable-daemon') {
      assert.match(
        attempt.stdout,
        /Cannot connect|failed to connect|dial unix|no such file or directory/i,
      );
      assert.doesNotMatch(attempt.stdout, /too long/);
    }
    assert.equal(
      attempt.rows.some(
        row => row.phase === 'ready' || row.phase === 'activating' || row.installed,
      ),
      false,
    );
    const reopened = await listed(mode + '-reopen', store, env);
    cleanFailure(reopened, store, 'failed');
    summary.cases.push({
      id: mode,
      status: 'pass',
      error: attempt.rows.find(row => row.type === 'error')?.message,
      actionable: true,
      falselyReadyOrActivated: false,
      freshStore: true,
      leftovers: leftovers(store),
      reopenOutcome: reopened.lastOperation.outcome,
    });
    const recovered = await child(mode + '-retry', installArgs('chip', store), environment(store));
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
    const ready = await listed(mode + '-retry-reopen', store, environment(store));
    assert.equal(ready.lastOperation.outcome, 'completed');
    assert.equal(ready.installed.find(item => item.domain === 'chip').runtimeState, 'ready');
    assert.deepEqual(leftovers(store), []);
    summary.cases.push({
      id: mode + '-retry',
      status: 'pass',
      installed: 'chip',
      runtimeState: 'ready',
      restartedProcess: true,
    });
  }
  const store = path.join(output, 'transfer-cancel-store');
  const cancelled = await child(
    'transfer-cancel',
    installArgs('chip', store, 'cancel'),
    environment(store),
    { cancelOnBytes: true },
  );
  assert.equal(cancelled.cancelled, true, 'SIGINT must follow received body bytes.');
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.stdout, /Domain preparation cancelled/);
  assert.equal(
    cancelled.rows.some(
      row => row.phase === 'ready' || row.phase === 'activating' || row.installed,
    ),
    false,
  );
  cleanFailure(
    await listed('transfer-cancel-reopen', store, environment(store)),
    store,
    'cancelled',
  );
  const retry = await child('transfer-retry', installArgs('chip', store), environment(store));
  assert.equal(retry.code, 0, retry.stdout + retry.stderr);
  assert.equal(
    (await listed('transfer-retry-reopen', store, environment(store))).installed[0].runtimeState,
    'ready',
  );
  assert.deepEqual(leftovers(store), []);
  summary.cases.push({
    id: 'transfer-cancel-retry',
    status: 'pass',
    transport: 'real loopback HTTPS, exact owner Chip archive',
    signal: 'SIGINT after received > 0',
    cancelledJournal: true,
    falselyReadyOrActivated: false,
    retryRuntimeState: 'ready',
    leftovers: [],
  });
  const project = path.join(output, 'chip-project');
  fs.cpSync(path.join(owner.sourceDirectory('chip-pack'), 'examples/managed-rtl'), project, {
    recursive: true,
  });
  const runner = path.join(output, 'factory-check.cjs');
  fs.writeFileSync(
    runner,
    [
      "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');",
      'const {loadRegistry}=require(' +
        JSON.stringify(path.join(root, 'packages/domain-skills/src/installed.cjs')) +
        ');',
      'const {createProjectRuntime}=require(' +
        JSON.stringify(path.join(root, 'packages/harness-core/src/project-runtime.cjs')) +
        ');',
      '(async()=>{const o=JSON.parse(process.argv[2]),registry=loadRegistry();let qaRuntimeInspection;',
      'if(o.expectWithheld){const pack=registry.runtimePacks.find(p=>p.domain===o.domain);const plugin=require(path.join(pack.directory,pack.runtime.entry)).createRuntimePlugin({managed:pack.managed,environment:{...process.env,...pack.runtimeEnvironment},runtimeApi:{resolveDependency:pack.resolveDependency}});try{assert.equal(plugin.available,false);assert.deepEqual(plugin.tools,[]);qaRuntimeInspection={available:plugin.available,tools:plugin.tools};}finally{await plugin.dispose?.();}}',
      'const factory=createProjectRuntime({projectDir:o.project,domain:o.domain,directory:o.state,environment:process.env,registry});',
      'try{const state=await factory.runtime.inspect();const result=await factory.runtime.execute({toolId:o.tool,inputs:{},expectedStateId:state.id},{approval:true,scope:{domain:o.domain,projectId:state.projectId,stateId:state.id,tools:[o.tool]}});console.log(JSON.stringify({...result,qaRuntimeInspection}));}finally{await factory.runtime.close();}})().catch(error=>{console.error(error);process.exitCode=1;});',
    ].join('\n'),
  );
  const native = await child(
    'chip-after-recovery-native',
    [
      JSON.stringify({
        project,
        domain: 'chip',
        tool: 'chip.rtl.verify',
        state: path.join(output, 'chip-state'),
      }),
    ],
    environment(store),
    { script: runner },
  );
  assert.equal(native.code, 0, native.stdout + native.stderr);
  const nativeResult = JSON.parse(native.stdout);
  assert.equal(nativeResult.verification.status, 'passed', native.stdout);
  const containers = spawnSync(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      'name=industrial-task-' + nativeResult.action.id,
      '--format',
      '{{.Names}}',
    ],
    { env: environment(store), encoding: 'utf8', timeout: 10000 },
  );
  fs.writeFileSync(
    path.join(output, 'own-container-cleanup.log'),
    containers.stdout + containers.stderr,
  );
  assert.equal(containers.status, 0, containers.stdout + containers.stderr);
  assert.equal(containers.stdout.trim(), '', 'The owned native task container must be removed.');
  summary.cases.push({
    id: 'chip-after-recovery-native',
    status: 'pass',
    engineering: 'passed',
    backend: 'real Harbor-pinned container, local image cache retained',
    ownedContainerRemoved: true,
  });
  const cudaStore = path.join(output, 'cuda-unconfigured-store');
  const cuda = await child(
    'cuda-unconfigured-install',
    installArgs('cuda', cudaStore),
    environment(cudaStore),
  );
  assert.equal(cuda.code, 0, cuda.stdout + cuda.stderr);
  const cudaList = await listed('cuda-unconfigured-reopen', cudaStore, environment(cudaStore));
  assert.equal(cudaList.installed[0].runtimeState, 'external-dependencies');
  assert.match(
    cudaList.installed[0].prerequisites.join(' '),
    /both authenticated remote Compiler and Evaluator/,
  );
  const cudaProject = path.join(output, 'cuda-project');
  fs.cpSync(path.join(owner.sourceDirectory('cuda-pack'), 'examples/square'), cudaProject, {
    recursive: true,
  });
  const cudaTool = 'cuda.candidate.compile';
  assert.ok(
    owner
      .hostPacks()
      .find(pack => pack.domain === 'cuda')
      .provider.tools.some(tool => tool.id === cudaTool),
    'Negative request must name an actually declared canonical tool.',
  );
  const unavailable = await child(
    'cuda-unconfigured-tool',
    [
      JSON.stringify({
        project: cudaProject,
        domain: 'cuda',
        tool: cudaTool,
        expectWithheld: true,
        state: path.join(output, 'cuda-state'),
      }),
    ],
    environment(cudaStore),
    { script: runner },
  );
  assert.equal(unavailable.code, 0, unavailable.stdout + unavailable.stderr);
  const missingService = JSON.parse(unavailable.stdout);
  assert.deepEqual(missingService.qaRuntimeInspection, { available: false, tools: [] });
  assert.equal(missingService.action.status, 'failed');
  assert.notEqual(missingService.verification.status, 'passed');
  summary.cases.push({
    id: 'cuda-unconfigured',
    status: 'pass',
    runtimeState: 'external-dependencies',
    runtimeAvailable: missingService.qaRuntimeInspection.available,
    executableTools: missingService.qaRuntimeInspection.tools,
    requestedCanonicalTool: cudaTool,
    prerequisites: cudaList.installed[0].prerequisites,
    toolStatus: missingService.action.status,
    toolDiagnostics: missingService.action.diagnostics,
    engineering: missingService.verification.status,
    limitation:
      'Tool rejection is generic; service setup directions are supplied in domains list prerequisites.',
  });
  const lifecycle = spawnSync(
    process.execPath,
    ['--test', 'packages/pack-manager/src/download-lifecycle.test.cjs'],
    { cwd: root, encoding: 'utf8', timeout: 30000 },
  );
  fs.writeFileSync(
    path.join(output, 'existing-transfer-regression.log'),
    lifecycle.stdout + lifecycle.stderr,
  );
  assert.equal(lifecycle.status, 0, lifecycle.stdout + lifecycle.stderr);
  summary.cases.push({
    id: 'existing-signed-transfer-regression',
    status: 'pass',
    boundary:
      'real HTTPS and production transfer implementation; synthetic archive/localhost feed, not Harbor download',
  });
  fs.writeFileSync(path.join(output, 'feed-requests.json'), JSON.stringify(transfers, null, 2));
  summary.verdict = 'pass';
})()
  .catch(error => {
    summary.verdict = 'fail';
    summary.failure = error.stack;
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.rmSync(keyFile, { force: true });
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    summary.cleanup = {
      loopbackTlsServerClosed: !server?.listening,
      ephemeralSigningKeyRemoved: !fs.existsSync(keyFile),
    };
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
  });
