const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');

const SELFTEST_FLAGS = Object.freeze([
  '--account-selftest',
  '--remote-ui-selftest',
  '--task-results-selftest',
  '--viewer-selftest',
  '--kicad-selftest',
  '--godot-selftest',
  '--documents-selftest',
  '--browser-selftest',
  '--language-selftest',
  '--ui-selftest',
  '--messages-selftest',
  '--gui-settings-selftest',
  '--engineering-selftest',
  '--cad-selftest',
  '--cad-resize-selftest',
  '--mcp-selftest',
  '--subagent-selftest',
  '--external-mcp-selftest',
  '--agent-log-selftest',
  '--chat-selftest',
  '--parallel-selftest',
  '--image-input-selftest',
  '--model-sync-selftest',
  '--replay-selftest',
  '--install-experience-selftest',
  '--project-onboarding-selftest',
  '--container-install-selftest',
]);
const PATH_ENV = Object.freeze([
  'INDUSTRIAL_UI_SCREENSHOTS',
  'INDUSTRIAL_PCB3D_FIXTURE',
  'HARNESS_CAD_SELFTEST_OUTPUT',
  'HARNESS_LANGUAGE_SELFTEST_OUTPUT',
]);
const ENV_ALLOWLIST = Object.freeze(['INDUSTRIAL_DEV_URL', ...PATH_ENV]);
const SELFTEST_MARKERS = Object.freeze({
  '--account-selftest': 'Account selftest passed:',
  '--kicad-selftest': 'KiCad selftest passed:',
  '--ui-selftest': 'UI selftest passed:',
  '--language-selftest': 'Language selftest passed:',
  '--messages-selftest': 'Message selftest passed:',
  '--gui-settings-selftest': 'Desktop settings selftest passed:',
  '--model-sync-selftest': 'Model sync selftest passed:',
  '--install-experience-selftest': 'Installation experience selftest passed:',
  '--project-onboarding-selftest': 'Project onboarding selftest passed:',
  '--remote-ui-selftest': '[remote-ui-selftest] done',
  '--container-install-selftest': 'Real release-image Desktop installation and repair passed.',
});

function hasControl(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validateOptions({ args = [], mode, env = {} } = {}) {
  if (!Array.isArray(args) || args.length > 1 || args.some(arg => !SELFTEST_FLAGS.includes(arg)))
    throw Error('GUI source launch accepts one supported selftest flag or no arguments.');
  const selectedMode = mode || (args.length ? 'selftest' : 'start');
  if (
    !['start', 'dev', 'selftest'].includes(selectedMode) ||
    (selectedMode === 'selftest') !== (args.length === 1)
  )
    throw Error('GUI launch mode does not match its arguments.');
  if (!env || typeof env !== 'object' || Array.isArray(env))
    throw Error('Invalid GUI environment.');
  const safeEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_ALLOWLIST.includes(name)) throw Error(`Unsupported GUI environment variable: ${name}`);
    if (typeof value !== 'string' || !value || value.length > 4096 || hasControl(value))
      throw Error(`Invalid GUI environment variable: ${name}`);
    if (PATH_ENV.includes(name) && !path.isAbsolute(value))
      throw Error(`GUI resource path must be absolute: ${name}`);
    if (name === 'INDUSTRIAL_DEV_URL') {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw Error('Invalid local development URL.');
      }
      if (
        selectedMode !== 'dev' ||
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw Error('GUI development URL must be a plain HTTP loopback root URL in dev mode.');
    }
    safeEnv[name] = value;
  }
  if (selectedMode === 'dev' && !safeEnv.INDUSTRIAL_DEV_URL)
    throw Error('GUI dev mode requires an explicit ready local development URL.');
  return { args: [...args], mode: selectedMode, env: safeEnv };
}

function selectMacGuiEnvironment(environment, mode = 'start') {
  const selected = {};
  for (const name of ENV_ALLOWLIST)
    if ((name !== 'INDUSTRIAL_DEV_URL' || mode === 'dev') && environment[name])
      selected[name] = environment[name];
  return selected;
}

// This runs in the GUI-launched Electron process itself, before app.ready.
// Keep the executable named Electron so native app.isPackaged remains false.
const BOOTSTRAP_SOURCE = String.raw`const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const crypto = require('node:crypto');
const { app } = require('electron');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const attemptId = crypto.randomUUID();
fs.rmSync(config.resultPath, {force: true});
let observed = false, finalized = false, failed = false, loggingIncomplete = false;
const log = (level, args) => {
  const message = util.format(...args);
  fs.appendFileSync(config.logPath, new Date().toISOString() + ' ' + attemptId + ' ' + level + ' ' + message + '\n');
  if ((level === 'log' || level === 'info') && config.mode === 'selftest' && config.expectedMarker)
    observed ||= message.startsWith(config.expectedMarker);
};
const finish = code => {
  if (finalized) return;
  finalized = true;
  const completed = config.mode === 'selftest' && observed;
  fs.writeFileSync(config.resultPath, JSON.stringify({runId: config.runId, attemptId, mode: config.mode,
    args: config.args, completed, exitCode: code, passed: completed && code === 0 && !failed,
    recordedBy: 'process-exit', loggingIncomplete,
    finishedAt: new Date().toISOString()}) + '\n', {mode: 0o600});
};
// main.cjs also reports startup failures directly to fd 2, bypassing console.
// Forward first so native return values and argument errors remain unchanged.
const writeSync = fs.writeSync;
fs.writeSync = function(fd, data, ...options) {
  const written = Reflect.apply(writeSync, this, [fd, data, ...options]);
  if (fd === 1 || fd === 2) {
    try {
      let bytes;
      if (typeof data === 'string') {
        bytes = Buffer.from(data, typeof options[1] === 'string' ? options[1] : 'utf8');
      } else {
        const offset = (typeof options[0] === 'object' ? options[0]?.offset : options[0]) ?? 0;
        bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength).subarray(offset);
      }
      log(fd === 2 ? 'stderr' : 'stdout', [bytes.subarray(0, written).toString('utf8')]);
    } catch { loggingIncomplete = true; }
  }
  return written;
};
for (const level of ['log','info','warn','error','debug']) console[level] = (...args) => log(level,args);
process.on('exit', finish);
app.on('quit', (_event, code) => log('quit',[code]));
const fail = reason => { failed = true; log('error',[reason?.stack || reason]); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
log('bootstrap',[JSON.stringify({runId: config.runId, attemptId, isPackaged: app.isPackaged,
  defaultApp: Boolean(process.defaultApp), execPath: process.execPath, sourceMain: config.main,
  startedAt: new Date().toISOString()})]);
if (app.isPackaged || app.isReady()) {
  fail(Error('Source GUI bootstrap requires unpackaged Electron before app.ready.'));
} else {
  try {
    for (const name of config.environmentAllowlist) delete process.env[name];
    Object.assign(process.env, config.env);
    process.chdir(config.desktopRoot);
    process.argv.splice(1, process.argv.length - 1, config.desktopRoot, ...config.args);
    log('load-main',[config.main]);
    require(config.main);
  } catch (error) { fail(error); }
}
`;

function verifyBundleLinks(appPath) {
  const root = fs.realpathSync(appPath);
  const visit = directory => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== root && !target.startsWith(root + path.sep))
          throw Error('Electron bundle contains a link outside the copied app.');
      } else if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
}

function signApp(appPath) {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: 'pipe',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: 'pipe',
  });
}

function prepareMacGui(options = {}, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin')
    throw Error('GUI source bundles are available only on macOS.');
  const selected = validateOptions(options);
  const desktopRoot = fs.realpathSync(options.desktopRoot || path.resolve(__dirname, '..'));
  // Keep the source app recognizable across preparations without sharing identity
  // with another checkout, interactive mode, or selftest suite.
  const identity = crypto
    .createHash('sha256')
    .update(JSON.stringify(['source-v1', desktopRoot, selected.mode, selected.args]))
    .digest('hex')
    .slice(0, 24);
  const bundleId = `com.industrial-harness.source-${identity}`;
  const desktopPackage = JSON.parse(
    fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
  );
  const main = path.join(desktopRoot, 'electron/main.cjs');
  if (!fs.statSync(main).isFile()) throw Error('Desktop main entry is missing.');
  if (selected.mode !== 'dev' && !fs.existsSync(path.join(desktopRoot, 'dist/index.html')))
    throw Error('Build the desktop before preparing a GUI source launch.');
  const resolve = createRequire(path.join(desktopRoot, 'package.json'));
  const electronPackagePath = resolve.resolve('electron/package.json');
  const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
  if (electronPackage.version !== desktopPackage.devDependencies?.electron)
    throw Error('Installed Electron does not match the desktop pinned dependency.');
  const sourceApp = fs.realpathSync(
    path.join(path.dirname(electronPackagePath), 'dist/Electron.app'),
  );
  if (!fs.statSync(path.join(sourceApp, 'Contents/MacOS/Electron')).isFile())
    throw Error('Official Electron app executable is missing.');
  const parent = fs.realpathSync(options.outputRoot || os.tmpdir());
  const runDirectory = fs.mkdtempSync(path.join(parent, 'harness-mac-gui-'));
  fs.chmodSync(runDirectory, 0o700);
  const runId = crypto.randomUUID();
  const appPath = path.join(runDirectory, 'Harness-GUI.app');
  const logPath = path.join(runDirectory, 'startup.log');
  const resultPath = path.join(runDirectory, 'result.json');
  fs.writeFileSync(logPath, '', { mode: 0o600, flag: 'wx' });
  try {
    fs.cpSync(sourceApp, appPath, {
      recursive: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
    verifyBundleLinks(appPath);
    const plistPath = path.join(appPath, 'Contents/Info.plist');
    const plist = fs.readFileSync(plistPath, 'utf8');
    if (!/<key>CFBundleIdentifier<\/key>\s*<string>[^<]+<\/string>/.test(plist))
      throw Error('Electron bundle identifier is missing.');
    fs.writeFileSync(
      plistPath,
      plist.replace(
        /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+(<\/string>)/,
        `$1${bundleId}$2`,
      ),
    );
    const resources = path.join(appPath, 'Contents/Resources/app');
    fs.mkdirSync(resources, { recursive: true });
    const configPath = path.join(resources, 'config.json');
    const config = {
      runId,
      bundleId,
      desktopRoot,
      main,
      ...selected,
      environmentAllowlist: ENV_ALLOWLIST,
      expectedMarker: SELFTEST_MARKERS[selected.args[0]] || null,
      logPath,
      resultPath,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.writeFileSync(
      path.join(resources, 'package.json'),
      JSON.stringify(
        {
          name: desktopPackage.name,
          version: desktopPackage.version,
          private: true,
          main: 'launcher.cjs',
        },
        null,
        2,
      ) + '\n',
    );
    fs.writeFileSync(path.join(resources, 'launcher.cjs'), BOOTSTRAP_SOURCE);
    (dependencies.signApp || signApp)(appPath);
    return {
      runId,
      bundleId,
      runDirectory,
      appPath,
      logPath,
      resultPath,
      configPath,
      mode: selected.mode,
    };
  } catch (error) {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        runId,
        completed: false,
        prepared: false,
        error: String(error.message || error),
      }) + '\n',
      { mode: 0o600 },
    );
    throw Error(`GUI source preparation failed; details: ${resultPath}`, { cause: error });
  }
}

function openMacGui(prepared, run = spawnSync) {
  const result = run('/usr/bin/open', ['-n', '-a', prepared.appPath], {
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.error?.code || result.stderr || `exit ${result.status}`)
      .trim()
      .slice(0, 1000);
    throw Error(
      `macOS could not open the prepared app (${diagnostic}). Open ${prepared.appPath} with Finder or the GUI controller.`,
      { cause: result.error || Error(String(result.stderr || result.status)) },
    );
  }
  return prepared;
}

function cli(argv = process.argv.slice(2)) {
  const args = argv.filter(arg => arg !== '--');
  const prepareOnly = args.includes('--prepare-only');
  const dev = args.includes('--dev');
  const flags = args.filter(arg => !['--prepare-only', '--dev'].includes(arg));
  if (
    args.filter(arg => arg === '--prepare-only').length > 1 ||
    args.filter(arg => arg === '--dev').length > 1
  )
    throw Error('Duplicate GUI launch options.');
  const mode = dev ? 'dev' : flags.length ? 'selftest' : 'start';
  const prepared = prepareMacGui({
    args: flags,
    mode,
    env: selectMacGuiEnvironment(process.env, mode),
  });
  console.log(JSON.stringify(prepared, null, 2));
  if (!prepareOnly) openMacGui(prepared);
  return prepared;
}
if (require.main === module) {
  try {
    cli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = {
  prepareMacGui,
  openMacGui,
  selectMacGuiEnvironment,
  validateOptions,
  SELFTEST_FLAGS,
  SELFTEST_MARKERS,
  ENV_ALLOWLIST,
  BOOTSTRAP_SOURCE,
  cli,
};
