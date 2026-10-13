const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ProjectPathSchema,
  ProjectTaskManifestSchema,
} = require('@industrial-agent-harness/contracts');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const excluded = new Set(['.git', '.harness-runs', 'node_modules', '.venv', '__pycache__']);
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
function canonicalPath(file) {
  const missing = [];
  let current = path.resolve(file);
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function projectFile(projectDir, relative, protectedPaths = []) {
  projectDir = fs.realpathSync(projectDir);
  ProjectPathSchema.parse(relative);
  if (relative.split('/').some(part => excluded.has(part)))
    throw Error('Path is reserved for runtime, dependencies or evidence.');
  const file = path.join(projectDir, ...relative.split('/'));
  if (protectedPaths.some(root => inside(file, canonicalPath(root))))
    throw Error('Path is protected runtime storage.');
  let current = projectDir;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw Error('Project input paths cannot contain symlinks.');
    if (stat && current !== file && !stat.isDirectory())
      throw Error('A path parent is not a directory.');
  }
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw Error('Expected an ordinary project file.');
  if (stat?.nlink > 1) throw Error('Hard-linked project files cannot be used.');
  return file;
}
function readBytes(file, maximum = 262144) {
  if (fs.statSync(file).size > maximum) throw Error('File exceeds the bounded read size.');
  return fs.readFileSync(file);
}
function* scanCandidates(projectDir, protectedPaths, diagnostics) {
  const seen = new Set(),
    protectedRoots = protectedPaths.map(canonicalPath);
  const note = (name, reason) => {
    if (diagnostics.length < 100) diagnostics.push(`Input omitted: ${name}: ${reason}`);
  };
  let declaration;
  try {
    declaration = manifest(projectDir, protectedPaths);
  } catch (error) {
    note('harness.tasks.json', error.message);
    declaration = { tasks: {} };
  }
  const required = new Set([
    'harness.tasks.json',
    'harness.project.json',
    ...Object.values(declaration.tasks).flatMap(task => task.inputs),
  ]);
  for (const name of [...required].sort()) {
    if (!fs.lstatSync(path.join(projectDir, name), { throwIfNoEntry: false })) {
      if (!['harness.tasks.json', 'harness.project.json'].includes(name))
        note(name, 'Declared input is missing.');
      continue;
    }
    seen.add(name);
    yield { name, required: true };
  }
  const ignored = declaration.workspace?.ignore || [];
  let count = 0,
    stopped = false;
  function* visit(name, depth = 0) {
    if (stopped || ignored.some(root => name === root || name.startsWith(root + '/'))) return;
    if (name.split('/').some(part => excluded.has(part))) return;
    const file = path.join(projectDir, name);
    if (protectedRoots.some(root => inside(file, root))) return;
    if (++count > 10000 || depth > 32) {
      note(
        name || '.',
        'Workspace scan limit reached; use workspace.inputs/ignore to narrow discovery.',
      );
      stopped = count > 10000;
      return;
    }
    let stat;
    try {
      stat = fs.lstatSync(file, { throwIfNoEntry: false });
    } catch (error) {
      note(name, error.message);
      return;
    }
    if (!stat) {
      note(name, 'Path is missing.');
      return;
    }
    if (stat.isSymbolicLink()) {
      note(name, 'Symlink cannot be used as an input.');
      return;
    }
    if (stat.isDirectory()) {
      let children;
      try {
        children = fs.readdirSync(file).sort();
      } catch (error) {
        note(name, error.message);
        return;
      }
      for (const entry of children) yield* visit(name ? name + '/' + entry : entry, depth + 1);
    } else if (!seen.has(name)) {
      seen.add(name);
      yield { name, required: false };
    }
  }
  for (const root of declaration.workspace?.inputs || ['']) yield* visit(root);
}
function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function indexFile(projectDir, name, protectedPaths, total) {
  const file = projectFile(projectDir, name, protectedPaths),
    stat = fs.statSync(file, { bigint: true });
  if (stat.size > 64n * 1024n * 1024n || total + Number(stat.size) > 256 * 1024 * 1024)
    throw Error('Input exceeds the bounded workspace size.');
  return { file, stat, size: Number(stat.size), identity: fileIdentity(stat) };
}
function inputIndex(projectDir, protectedPaths = []) {
  projectDir = fs.realpathSync(projectDir);
  const entries = {},
    diagnostics = [];
  let total = 0;
  for (const { name } of scanCandidates(projectDir, protectedPaths, diagnostics)) {
    try {
      const info = indexFile(projectDir, name, protectedPaths, total);
      entries[name] = hash(readBytes(info.file, 64 * 1024 * 1024));
      total += info.size;
    } catch (error) {
      if (diagnostics.length < 100) diagnostics.push(`Input omitted: ${name}: ${error.message}`);
    }
  }
  return entries;
}
function createInputIndexer() {
  const cache = new Map();
  let diagnostics = [],
    tail = Promise.resolve();
  async function scan(projectDir, protectedPaths) {
    projectDir = fs.realpathSync(projectDir);
    const entries = {},
      used = new Set(),
      notes = [];
    let total = 0,
      count = 0;
    for (const { name } of scanCandidates(projectDir, protectedPaths, notes)) {
      try {
        const info = indexFile(projectDir, name, protectedPaths, total);
        const cached = cache.get(info.file);
        let value = cached?.identity === info.identity ? cached.hash : null;
        if (!value) {
          const handle = await fs.promises.open(
            info.file,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
          );
          try {
            if (fileIdentity(await handle.stat({ bigint: true })) !== info.identity)
              throw Error('Input changed during indexing; inspect again.');
            const digest = crypto.createHash('sha256'),
              buffer = Buffer.alloc(65536);
            let read = 0,
              bytesRead;
            while (
              ({ bytesRead } = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, info.size - read + 1),
                read,
              )).bytesRead
            ) {
              read += bytesRead;
              if (read > info.size) throw Error('Input grew during indexing; inspect again.');
              digest.update(buffer.subarray(0, bytesRead));
            }
            if (
              read !== info.size ||
              fileIdentity(await handle.stat({ bigint: true })) !== info.identity ||
              fileIdentity(fs.statSync(info.file, { bigint: true })) !== info.identity
            )
              throw Error('Input changed during indexing; inspect again.');
            value = digest.digest('hex');
          } finally {
            await handle.close();
          }
          cache.set(info.file, { identity: info.identity, hash: value });
        }
        entries[name] = value;
        used.add(info.file);
        total += info.size;
      } catch (error) {
        if (notes.length < 100) notes.push(`Input omitted: ${name}: ${error.message}`);
      }
      if (++count % 128 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    for (const file of cache.keys()) if (!used.has(file)) cache.delete(file);
    diagnostics = notes;
    return entries;
  }
  return {
    index(projectDir, protectedPaths = []) {
      const result = tail.then(() => scan(projectDir, protectedPaths));
      tail = result.catch(() => {});
      return result;
    },
    get diagnostics() {
      return [...diagnostics];
    },
  };
}
function manifest(projectDir, protectedPaths = []) {
  const file = projectFile(projectDir, 'harness.tasks.json', protectedPaths);
  if (!fs.existsSync(file)) return { schemaVersion: '1', tasks: {} };
  return ProjectTaskManifestSchema.parse(JSON.parse(readBytes(file).toString('utf8')));
}
function applyFiles(projectDir, changes, protectedPaths = []) {
  // Validate the entire batch and all preconditions before the first write.
  const plans = changes.map(change => {
    const file = projectFile(projectDir, change.path, protectedPaths);
    const before = fs.existsSync(file) ? readBytes(file) : null;
    if ((before === null ? null : hash(before)) !== change.expectedSha256)
      throw Error('File precondition is stale: ' + change.path);
    if (change.content === null && before === null) throw Error('Cannot delete a missing file.');
    // Invalid JSON is never a legitimate state for a .json project file;
    // reject it here so a model slip cannot corrupt the workspace on disk.
    if (change.content !== null && change.path.toLowerCase().endsWith('.json')) {
      try {
        JSON.parse(change.content);
      } catch (error) {
        throw Error('Invalid JSON content for ' + change.path + ': ' + error.message);
      }
    }
    return {
      ...change,
      file,
      before,
      beforeMode: before === null ? 0o600 : fs.statSync(file).mode & 0o777,
    };
  });
  const applied = [],
    createdDirectories = [];
  try {
    for (const plan of plans) {
      projectFile(projectDir, plan.path, protectedPaths);
      const current = fs.existsSync(plan.file) ? readBytes(plan.file) : null;
      if ((current === null ? null : hash(current)) !== plan.expectedSha256)
        throw Error('File changed before applying the batch: ' + plan.path);
      if (plan.content === null) fs.unlinkSync(plan.file);
      else {
        const missing = [];
        for (
          let parent = path.dirname(plan.file);
          !fs.existsSync(parent);
          parent = path.dirname(parent)
        )
          missing.unshift(parent);
        for (const parent of missing) {
          fs.mkdirSync(parent);
          createdDirectories.push(parent);
        }
        // Stage complete bytes before replacing an existing file. A partial
        // write/disk error must never truncate the original source.
        const temporary = path.join(
          path.dirname(plan.file),
          '.harness-edit-' + crypto.randomUUID(),
        );
        const fd = fs.openSync(temporary, 'wx', plan.beforeMode);
        let opened = true;
        try {
          fs.writeFileSync(fd, plan.content, 'utf8');
          if (process.platform !== 'win32') fs.fchmodSync(fd, plan.beforeMode);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          opened = false;
          projectFile(projectDir, plan.path, protectedPaths);
          if (plan.before !== null && hash(fs.readFileSync(plan.file)) !== plan.expectedSha256)
            throw Error('File changed before writing: ' + plan.path);
          if (plan.before === null) fs.linkSync(temporary, plan.file);
          else fs.renameSync(temporary, plan.file);
          applied.push(plan);
        } finally {
          if (opened) fs.closeSync(fd);
          fs.rmSync(temporary, { force: true });
        }
      }
      if (plan.content === null) applied.push(plan);
    }
  } catch (error) {
    for (const plan of applied.reverse()) {
      const file = projectFile(projectDir, plan.path, protectedPaths);
      const current = fs.existsSync(file) ? readBytes(file) : null;
      const expected = plan.content === null ? null : hash(Buffer.from(plan.content));
      if ((current === null ? null : hash(current)) !== expected) continue;
      if (plan.before === null) fs.unlinkSync(file);
      else fs.writeFileSync(file, plan.before, { mode: plan.beforeMode });
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        fs.rmdirSync(directory);
      } catch {}
    }
    throw error;
  }
  return plans.map(plan => ({
    path: plan.path,
    beforeSha256: plan.expectedSha256,
    sha256: plan.content === null ? null : hash(Buffer.from(plan.content)),
  }));
}
function runDirectory(projectDir, actionId) {
  const parent = path.join(projectDir, '.harness-runs');
  const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw Error('Invalid runtime output directory.');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = path.join(parent, actionId);
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
module.exports = {
  hash,
  projectFile,
  inputIndex,
  createInputIndexer,
  applyFiles,
  manifest,
  runDirectory,
  readBytes,
};
