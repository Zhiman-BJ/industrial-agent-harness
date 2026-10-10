#!/usr/bin/env node
// Reclaim space after QA runs: stale build outputs, aged evidence directories,
// orphaned suite locks and abandoned /tmp worktrees of this repository.
// Preview by default; --apply deletes. Nothing tracked, not git-ignored, fresh
// within its retention window, or referenced by a running process is touched.
// Protocol: doc/qa-runbook.md section 1.6.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    apply: false,
    retentionBuilds: 7,
    retentionEvidence: 14,
    retentionWorktree: 7,
    lockTtlHours: 6,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--retention-builds') options.retentionBuilds = Number(argv[++i]);
    else if (argument === '--retention-evidence') options.retentionEvidence = Number(argv[++i]);
    else if (argument === '--retention-worktree') options.retentionWorktree = Number(argv[++i]);
    else if (argument === '--lock-ttl-hours') options.lockTtlHours = Number(argv[++i]);
    else throw Error(`Unknown argument: ${argument}`);
  }
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0))
      throw Error(`${name} must be a nonnegative number`);
  }
  return options;
}

function git(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function processArguments() {
  const result = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function newestMtime(target) {
  let latest = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    }
  }
  return latest;
}

function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

function qaWorktrees() {
  const porcelain = git(['worktree', 'list', '--porcelain']);
  if (!porcelain) return [];
  const tmpRoot = os.tmpdir() + path.sep;
  return parseWorktreeList(porcelain).filter(
    entry => entry.path.startsWith(tmpRoot) && path.resolve(entry.path) !== path.resolve(root),
  );
}

function worktreeIsDirty(worktreePath) {
  const status = git(['status', '--porcelain', '--untracked-files=normal'], worktreePath);
  return status === null ? true : status.trim().length > 0;
}

function isIgnoredPath(relativePath) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function isLockName(name) {
  return name.startsWith('.lock.');
}

function isEvidenceDirName(name) {
  return !name.startsWith('.') && !name.startsWith('qa-cleanup-');
}

// Pure decision core: inputs are gathered by main(), so tests can inject fakes.
function plan({
  builds,
  evidences,
  locks,
  worktrees,
  now,
  retention,
  isIgnored,
  isActive,
  dirtyWorktrees,
  newestOf,
}) {
  const selected = [];
  const skipped = [];
  const pushSkipped = (item, reason) => skipped.push({ path: item.path, kind: item.kind, reason });
  for (const item of builds) {
    if (!isIgnored(item.path)) {
      pushSkipped(item, 'not ignored');
      continue;
    }
    if (isActive(item.path)) {
      pushSkipped(item, 'in use by a running process');
      continue;
    }
    if (newestOf(item.path) > now - retention.builds * DAY_MS) {
      pushSkipped(item, 'modified within retention');
      continue;
    }
    selected.push(item);
  }
  for (const item of evidences) {
    if (isActive(item.path)) {
      pushSkipped(item, 'in use by a running process');
      continue;
    }
    if (newestOf(item.path) > now - retention.evidence * DAY_MS) {
      pushSkipped(item, 'modified within retention');
      continue;
    }
    selected.push(item);
  }
  for (const item of locks) {
    if (item.mtime > now - retention.lockTtlHours * 60 * 60 * 1000) {
      pushSkipped(item, 'lock younger than ttl');
      continue;
    }
    selected.push(item);
  }
  for (const item of worktrees) {
    if (dirtyWorktrees.has(item.path)) {
      pushSkipped(item, 'uncommitted changes');
      continue;
    }
    if (isActive(item.path)) {
      pushSkipped(item, 'in use by a running process');
      continue;
    }
    if (newestOf(item.path) > now - retention.worktree * DAY_MS) {
      pushSkipped(item, 'modified within retention');
      continue;
    }
    selected.push(item);
  }
  return { selected, skipped };
}

function listDirectory(directory, filter) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(filter)
    .map(entry => path.join(directory, entry.name));
}

function remove(target) {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(target, { recursive: true });
  else fs.unlinkSync(target);
}

function singleRunGuard() {
  const lockDir = path.join(root, 'dist/ci-reports/.qa-cleanup.lock');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    return lockDir;
  } catch {
    const owner = fs.existsSync(path.join(lockDir, 'owner.json'))
      ? JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
      : null;
    const ageHours = (Date.now() - fs.statSync(lockDir).mtimeMs) / 60 / 60 / 1000;
    const alive = owner && processArguments().some(line => line.startsWith(`${owner.pid} `));
    if (alive && ageHours < 1) {
      console.log('Another qa-cleanup is running; skipped.');
      return null;
    }
    fs.rmSync(lockDir, { recursive: true });
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    return lockDir;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.chdir(root);
  const guard = singleRunGuard();
  if (!guard) return;
  try {
    const reports = path.join(root, 'dist/ci-reports');
    const distRoot = path.join(root, 'dist');
    const builds = listDirectory(distRoot, entry => entry.name !== 'ci-reports').map(p => ({
      path: p,
      kind: 'build-output',
    }));
    builds.push(
      ...listDirectory(path.join(root, 'apps/desktop/dist'), () => true).map(p => ({
        path: p,
        kind: 'build-output',
      })),
    );
    const evidences = listDirectory(
      reports,
      entry => entry.isDirectory() && isEvidenceDirName(entry.name),
    ).map(p => ({
      path: p,
      kind: 'evidence',
    }));
    const locks = listDirectory(reports, entry => entry.isDirectory() && isLockName(entry.name))
      .filter(p => !p.endsWith('.qa-cleanup.lock'))
      .map(p => ({ path: p, kind: 'suite-lock', mtime: fs.statSync(p).mtimeMs }));
    const worktrees = qaWorktrees().map(entry => ({ path: entry.path, kind: 'tmp-worktree' }));
    const active = processArguments();
    const dirtyWorktrees = new Set(
      worktrees.filter(item => worktreeIsDirty(item.path)).map(item => item.path),
    );
    const { selected, skipped } = plan({
      builds,
      evidences,
      locks,
      worktrees,
      now: Date.now(),
      retention: options,
      isIgnored: p => isIgnoredPath(path.relative(root, p)),
      isActive: p => active.some(line => line.includes(p)),
      dirtyWorktrees,
      newestOf: newestMtime,
    });
    const report = {
      apply: options.apply,
      root,
      retention: {
        buildsDays: options.retentionBuilds,
        evidenceDays: options.retentionEvidence,
        worktreeDays: options.retentionWorktree,
        lockTtlHours: options.lockTtlHours,
      },
      selected: selected.map(item => ({
        path: path.relative(root, item.path) || item.path,
        kind: item.kind,
      })),
      skipped,
      deleted: [],
      errors: [],
    };
    if (options.apply) {
      for (const item of selected) {
        try {
          if (item.kind === 'tmp-worktree') {
            const removed = spawnSync('git', ['worktree', 'remove', '--force', item.path], {
              cwd: root,
              encoding: 'utf8',
            });
            if (removed.status !== 0 && !fs.existsSync(item.path)) {
              // Directory already gone; a stale registration is fine.
            } else if (removed.status !== 0) {
              report.errors.push({ path: item.path, error: removed.stderr.trim() });
              continue;
            }
          } else {
            remove(item.path);
          }
          report.deleted.push(path.relative(root, item.path) || item.path);
        } catch (error) {
          report.errors.push({ path: item.path, error: String(error) });
        }
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(reports, `qa-cleanup-${stamp}.json`);
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(report, null, 2) + '\n');
    console.log(
      `${options.apply ? 'Deleted' : 'Would delete'} ${report.deleted.length || selected.length} target(s); ` +
        `skipped ${skipped.length}; log: ${path.relative(root, logPath)}`,
    );
    if (!options.apply) console.log('Preview only; pass --apply to delete.');
  } finally {
    fs.rmSync(guard, { recursive: true });
  }
}

module.exports = { parseWorktreeList, isLockName, isEvidenceDirName, plan, newestMtime };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
