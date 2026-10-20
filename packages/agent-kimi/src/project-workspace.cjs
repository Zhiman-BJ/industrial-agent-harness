const fs = require('node:fs');
const path = require('node:path');

// Keep instruction discovery and skill parsing in Kimi. Its writable session
// workspace is not the engineering project, so map project inputs explicitly.
function prepareProjectWorkspace(directory, projectDir, platform = process.platform) {
  if (!projectDir) return [];
  if (platform === 'win32') return prepareWindowsProjectWorkspace(directory, projectDir);
  const project = fs.realpathSync(projectDir);
  const workspace = path.join(directory, 'workspace');
  const existingWorkspace = fs.lstatSync(workspace, { throwIfNoEntry: false });
  if (existingWorkspace && !existingWorkspace.isDirectory())
    throw Error(`Project mappings require a session workspace directory: ${workspace}`);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const brand of ['.kimi-code', '.kimi', '.claude', '.codex', '.agents']) {
    const source =
      brand === '.kimi-code' && !fs.existsSync(path.join(project, brand, 'skills'))
        ? path.join(project, '.kimi', 'skills')
        : path.join(project, brand, 'skills');
    const parent = path.join(workspace, brand);
    // Never follow a workspace-controlled parent link while writing mappings.
    const existing = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory())
      throw Error(`Project skill mapping requires a session directory: ${parent}`);
    const target = path.join(parent, 'skills');
    fs.rmSync(target, { recursive: true, force: true });
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) continue;
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.symlinkSync(source, target, 'junction');
  }
  for (const relative of ['AGENTS.md', 'agents.md', '.kimi/AGENTS.md', '.kimi-code/AGENTS.md'])
    fs.rmSync(path.join(workspace, relative), { force: true });
  const rootInstructions = ['AGENTS.md', 'agents.md'].find(name =>
    fs.statSync(path.join(project, name), { throwIfNoEntry: false })?.isFile(),
  );
  for (const relative of [rootInstructions, '.kimi/AGENTS.md'].filter(Boolean)) {
    const source = path.join(project, relative);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.symlinkSync(source, target, 'file');
  }
  const instructions = path.join(project, '.kimi-code/AGENTS.md');
  const legacyInstructions = path.join(project, '.kimi/AGENTS.md');
  const source = fs.existsSync(instructions) ? instructions : legacyInstructions;
  if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    const target = path.join(workspace, '.kimi-code/AGENTS.md');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.symlinkSync(source, target, 'file');
  }
  return ['.skill', '.skills', '.claude/skills', '.codex/skills']
    .map(name => path.join(project, name))
    .filter(root => fs.statSync(root, { throwIfNoEntry: false })?.isDirectory());
}

// Keep Windows discovery inputs bounded and independent of symlink privileges.
// This session snapshot is not an OS boundary: the Agent can access the project
// with the current user's permissions.
const WINDOWS_INPUT_LIMITS = {
  file: 1024 * 1024,
  bytes: 16 * 1024 * 1024,
  entries: 2048,
  depth: 16,
};
const BRANDS = ['.kimi-code', '.kimi', '.claude', '.codex', '.agents'];

function checkWindowsName(name) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*]/.test(name) ||
    Array.from(name).some(character => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw Error(`Unsupported Windows project input name: ${name}`);
}

function inputStat(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    checkWindowsName(parts[index]);
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw Error(`Project input links are not permitted: ${current}`);
    if (index !== parts.length - 1 && !stat.isDirectory()) return undefined;
    if (index === parts.length - 1) return stat;
  }
}

function prepareWindowsProjectWorkspace(directory, projectDir) {
  const project = fs.realpathSync(projectDir);
  const workspace = path.join(directory, 'workspace');
  const budget = { bytes: 0, entries: 0 };
  const mappings = [];
  const sourceStat = relative => inputStat(project, relative);
  const snapshot = (source, target, directoryOnly = false) => {
    const stat = sourceStat(source);
    if (!stat || (directoryOnly ? !stat.isDirectory() : !stat.isFile())) return;
    const entries = [];
    function collect(relative, destination, depth) {
      if (depth > WINDOWS_INPUT_LIMITS.depth)
        throw Error('Project inputs exceed the depth limit (16).');
      const current = sourceStat(relative);
      if (!current) throw Error(`Project input changed during preparation: ${relative}`);
      if (++budget.entries > WINDOWS_INPUT_LIMITS.entries)
        throw Error('Project inputs exceed the entry limit (2048).');
      if (current.isDirectory()) {
        entries.push({ target: destination });
        const names = fs.readdirSync(path.join(project, relative)).sort();
        const seen = new Set();
        for (const name of names) {
          checkWindowsName(name);
          const key = name.toLowerCase();
          if (seen.has(key))
            throw Error(`Case-colliding Windows project input: ${relative}/${name}`);
          seen.add(key);
          collect(`${relative}/${name}`, path.join(destination, name), depth + 1);
        }
      } else if (current.isFile()) {
        if (current.size > WINDOWS_INPUT_LIMITS.file)
          throw Error(`Project input exceeds the file limit (1 MiB): ${relative}`);
        const fd = fs.openSync(
          path.join(project, relative),
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        let content;
        try {
          const opened = fs.fstatSync(fd);
          if (
            !opened.isFile() ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino ||
            opened.size > WINDOWS_INPUT_LIMITS.file
          )
            throw Error(`Project input changed during preparation: ${relative}`);
          const buffer = Buffer.alloc(Math.min(opened.size + 1, WINDOWS_INPUT_LIMITS.file + 1));
          let size = 0;
          while (size < buffer.length) {
            const read = fs.readSync(fd, buffer, size, buffer.length - size, size);
            if (!read) break;
            size += read;
          }
          if (size !== opened.size)
            throw Error(`Project input changed during preparation: ${relative}`);
          content = buffer.subarray(0, size);
        } finally {
          fs.closeSync(fd);
        }
        budget.bytes += content.length;
        if (content.length > WINDOWS_INPUT_LIMITS.file || budget.bytes > WINDOWS_INPUT_LIMITS.bytes)
          throw Error('Project inputs exceed the byte limit (1 MiB/file, 16 MiB total).');
        entries.push({ target: destination, content });
      } else throw Error(`Project inputs require regular files or directories: ${relative}`);
    }
    collect(source, path.join(workspace, target), 0);
    mappings.push(...entries);
  };

  for (const brand of BRANDS) {
    const native = `${brand}/skills`;
    const source = brand === '.kimi-code' && !sourceStat(native) ? '.kimi/skills' : native;
    snapshot(source, native, true);
  }
  const rootInstructions = ['AGENTS.md', 'agents.md'].find(name => sourceStat(name)?.isFile());
  if (rootInstructions) snapshot(rootInstructions, rootInstructions);
  snapshot('.kimi/AGENTS.md', '.kimi/AGENTS.md');
  snapshot(
    sourceStat('.kimi-code/AGENTS.md') ? '.kimi-code/AGENTS.md' : '.kimi/AGENTS.md',
    '.kimi-code/AGENTS.md',
  );
  for (const relative of ['.skill', '.skills']) snapshot(relative, relative, true);

  const managed = [
    ...BRANDS.map(brand => `${brand}/skills`),
    '.skill',
    '.skills',
    'AGENTS.md',
    'agents.md',
    '.kimi/AGENTS.md',
    '.kimi-code/AGENTS.md',
  ];
  // Validate every destination before removing anything, including stale inputs.
  // A malformed late input must not leave a partially refreshed session.
  const session = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (session && (!session.isDirectory() || session.isSymbolicLink()))
    throw Error(`Project snapshots require a session directory: ${directory}`);
  for (const relative of ['workspace', ...BRANDS.map(brand => `workspace/${brand}`)]) {
    const stat = inputStat(directory, relative);
    if (stat && !stat.isDirectory())
      throw Error(`Project snapshots require a session directory: ${relative}`);
  }
  let destinationEntries = 0;
  function inspectDestination(relative, depth = 0) {
    const stat = inputStat(workspace, relative);
    if (!stat) return;
    if (++destinationEntries > WINDOWS_INPUT_LIMITS.entries || depth > WINDOWS_INPUT_LIMITS.depth)
      throw Error('Existing project inputs exceed snapshot limits.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(workspace, relative))) {
        checkWindowsName(name);
        inspectDestination(`${relative}/${name}`, depth + 1);
      }
    } else if (!stat.isFile()) throw Error(`Project snapshots require regular files: ${relative}`);
  }
  for (const relative of managed) inspectDestination(relative);

  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const relative of managed)
    fs.rmSync(path.join(workspace, relative), { recursive: true, force: true });
  for (const entry of mappings) {
    if (!entry.content) fs.mkdirSync(entry.target, { recursive: true, mode: 0o700 });
    else {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
      // Never write through an old hard link into project-owned source content.
      fs.rmSync(entry.target, { force: true });
      fs.writeFileSync(entry.target, entry.content, { mode: 0o600, flag: 'wx' });
    }
  }
  return ['.skill', '.skills', '.claude/skills', '.codex/skills']
    .map(relative => path.join(workspace, relative))
    .filter(root => fs.statSync(root, { throwIfNoEntry: false })?.isDirectory());
}

module.exports = { prepareProjectWorkspace };
