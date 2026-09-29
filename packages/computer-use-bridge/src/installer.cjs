const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

// Pinned release source. A future fork republishing its own release only changes
// this one place (or the GUI_BRIDGE_SOURCE_REPO / GUI_BRIDGE_TAG env overrides).
const DEFAULT_SOURCE = Object.freeze({repo: 'munimtechnologies/munim-computer-use', tag: 'v0.4.3'});
const BINARY_NAME = 'munim-computer-use';
const SUPPORT_DIR_MODE = 0o700;
const BINARY_MODE = 0o755;

function source(env = process.env) {
  return {
    repo: env.GUI_BRIDGE_SOURCE_REPO || DEFAULT_SOURCE.repo,
    tag: env.GUI_BRIDGE_TAG || DEFAULT_SOURCE.tag,
  };
}

function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return 'munim-computer-use-macos-universal.zip';
  if (platform === 'linux') return `munim-computer-use-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
  if (platform === 'win32') return 'munim-computer-use-windows-x64.zip';
  throw Error(`Unsupported platform: ${platform}`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// `get` defaults to node:https but is injectable so tests can use a local http server.
function download(url, get, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (!redirects) return reject(new Error('Too many redirects.'));
    get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString(), get, redirects - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed with HTTP ${response.statusCode} for ${url}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }, error => reject(error));
  });
}

// SHA256SUMS.txt lines are "<hash>  <filename>". Return a lower-cased hash map.
function parseSums(text) {
  const sums = {};
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(\S+)$/i);
    if (match) sums[match[2].toLowerCase()] = match[1].toLowerCase();
  }
  return sums;
}

function extractBinary(stagedFile, name, outDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bridge-x-'));
  try {
    if (name.endsWith('.zip')) {
      execFileSync('unzip', ['-o', '-q', stagedFile, '-d', tmp]);
    } else if (name.endsWith('.tar.gz')) {
      execFileSync('tar', ['-xzf', stagedFile, '-C', tmp]);
    }
    const found = fs.readdirSync(tmp, {recursive: true}).find(entry => {
      const base = path.basename(String(entry));
      return base === BINARY_NAME || base === `${BINARY_NAME}.exe`;
    });
    if (!found) throw Error('Archive does not contain the expected binary.');
    const sourceFile = path.join(tmp, String(found));
    const target = path.join(outDir, BINARY_NAME);
    fs.copyFileSync(sourceFile, target);
    fs.chmodSync(target, BINARY_MODE);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
    fs.rmSync(stagedFile, {force: true});
  }
  return path.join(outDir, BINARY_NAME);
}

async function installBridge(targetDir, env = process.env, emit = () => {}, get = require('node:https').get) {
  const {repo, tag} = source(env);
  const name = assetName(env.platform, env.arch);
  fs.mkdirSync(targetDir, {recursive: true, mode: SUPPORT_DIR_MODE});
  try {
    emit('downloading', {asset: name, repo, tag});
    const base = (env.GUI_BRIDGE_RELEASE_BASE || 'https://github.com').replace(/\/$/, '');
    const [archive, sumsText] = await Promise.all([
      download(`${base}/${repo}/releases/download/${tag}/${name}`, get),
      download(`${base}/${repo}/releases/download/${tag}/SHA256SUMS.txt`, get).then(buffer => buffer.toString('utf8')),
    ]);
    const expected = parseSums(sumsText)[name.toLowerCase()];
    if (!expected) throw Error(`SHA256SUMS.txt has no entry for ${name}.`);
    const actual = sha256(archive);
    if (actual !== expected) throw Error(`SHA256 mismatch for ${name}: expected ${expected}, got ${actual}.`);
    emit('verified', {sha256: actual});
    const staged = path.join(targetDir, `${name}.part`);
    fs.writeFileSync(staged, archive);
    const binary = extractBinary(staged, name, targetDir);
    const version = {repo, tag, sha256: actual, installedAt: new Date().toISOString()};
    fs.writeFileSync(path.join(targetDir, 'version.json'), JSON.stringify(version, null, 2), {mode: 0o600});
    emit('ready', version);
    return {binary, ...version};
  } catch (error) {
    // A failed download or verification must not leave a half-installed bridge behind.
    fs.rmSync(targetDir, {recursive: true, force: true});
    throw error;
  }
}

function status(targetDir) {
  const versionFile = path.join(targetDir, 'version.json');
  const binary = path.join(targetDir, BINARY_NAME);
  if (!fs.existsSync(versionFile) || !fs.existsSync(binary)) return {state: 'missing'};
  try {
    const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    if (typeof version.sha256 !== 'string' || !fs.statSync(binary).isFile()) return {state: 'missing'};
    return {state: 'ready', version, binary};
  } catch {
    return {state: 'missing'};
  }
}

// Idempotent: skip when the pinned tag is already installed and its hash matches.
// A GUI_BRIDGE_BIN override means the user already manages the binary; skip installation.
async function ensureInstalled(targetDir, env = process.env, emit = () => {}, get) {
  if (env.GUI_BRIDGE_BIN) return {binary: env.GUI_BRIDGE_BIN, external: true};
  const current = status(targetDir);
  const {tag} = source(env);
  // A pinned tag pins the expected hash; a matching tag plus an intact binary means reuse.
  if (current.state === 'ready' && current.version.tag === tag) {
    return {binary: current.binary, ...current.version, cached: true};
  }
  fs.rmSync(targetDir, {recursive: true, force: true});
  return installBridge(targetDir, env, emit, get);
}

module.exports = {installBridge, ensureInstalled, status, source, assetName, sha256, parseSums, DEFAULT_SOURCE, BINARY_NAME};
