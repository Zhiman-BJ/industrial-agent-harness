#!/usr/bin/env node
// Trusted base-branch code. Candidate objects are data: never checkout or archive them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const limits = { files: 20000, blob: 64 * 1024 * 1024, total: 256 * 1024 * 1024 };

function git(args, cwd, maxBuffer = 8 * 1024 * 1024) {
  return execFileSync(
    'git',
    ['-c', `core.hooksPath=${os.devNull}`, '-c', 'credential.helper=', ...args],
    {
      cwd,
      maxBuffer,
      timeout: 120000,
      // No token, inherited Git config, credential helper, filters or object alternates.
      env: {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function entriesFromTree(bytes, bounds = limits) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text && !text.endsWith('\0')) throw Error('Truncated Git tree listing');
  const records = text ? text.slice(0, -1).split('\0') : [];
  if (!records.length || records.length > bounds.files) throw Error('Candidate file count limit');
  const seen = new Set();
  return records.map(record => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) throw Error('Candidate must contain regular blobs only (no symlinks/gitlinks)');
    const [, , oid, file] = match;
    const parts = file.split('/');
    if (
      file.includes('\\') ||
      /[\x00-\x1f\x7f:]/.test(file) ||
      parts.some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part))
    )
      throw Error(`Unsafe candidate path: ${JSON.stringify(file)}`);
    // Fail on case collisions as well as duplicate/file-directory collisions.
    const key = file.toLowerCase();
    if (seen.has(key)) throw Error('Duplicate candidate path');
    seen.add(key);
    return { oid, file };
  });
}

function materializeTree(directory, sha, destination, runGit = git, bounds = limits) {
  const entries = entriesFromTree(
    runGit(['ls-tree', '-rz', '--full-tree', sha], directory),
    bounds,
  );
  let total = 0;
  // Validate every mode/path before creating anything; the destination must be new.
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    for (const { oid, file } of entries) {
      const size = Number(runGit(['cat-file', '-s', oid], directory).toString().trim());
      total += size;
      if (!Number.isSafeInteger(size) || size < 0 || size > bounds.blob || total > bounds.total)
        throw Error('Candidate blob/total size limit');
      const bytes = runGit(['cat-file', 'blob', oid], directory, bounds.blob + 1);
      if (bytes.length !== size) throw Error('Candidate blob size mismatch');
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { sha, files: entries.length, bytes: total };
}

function fetchCandidate(
  { repository, number, sha, destination, temp = os.tmpdir() },
  runGit = git,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository || ''))
    throw Error('Invalid base repository');
  if (!/^[1-9][0-9]*$/.test(String(number))) throw Error('Invalid PR number');
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw Error('Invalid expected PR SHA');
  const directory = fs.mkdtempSync(path.join(temp, 'architecture-git-'));
  try {
    runGit(['init', '--bare', '--template=', directory], temp);
    // GitHub maintains this ref in the base repo for both fork and same-repo PRs.
    // Fetch only that ref, with no credentials, tags, submodules or working tree.
    runGit(
      [
        'fetch',
        '--no-tags',
        '--depth=1',
        '--recurse-submodules=no',
        `https://github.com/${repository}.git`,
        `refs/pull/${number}/head`,
      ],
      directory,
    );
    const actual = runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], directory)
      .toString()
      .trim();
    if (actual !== sha)
      throw Error('PR head moved or fetched SHA mismatched; retry the current event');
    return materializeTree(directory, sha, destination, runGit);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { fetchCandidate, materializeTree, entriesFromTree, git, limits };
if (require.main === module) {
  try {
    const report = fetchCandidate({
      repository: process.env.GITHUB_REPOSITORY,
      number: process.env.PR_NUMBER,
      sha: process.env.HEAD_SHA,
      destination: process.env.CANDIDATE_ROOT,
      temp: process.env.RUNNER_TEMP,
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    // Do not echo candidate content or child-process output into Actions commands.
    console.error(`Candidate acquisition failed: ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
