#!/usr/bin/env node
// Machine validator for architecture/editions.json (#101). It enforces the
// internal/OSS product boundary recorded in the manifest: schema health,
// whole-repo classification coverage, edition dependency direction with a
// shrink-only legacy reference ledger for not-yet-isolated internal modules,
// required tests, and an explicit release gate used by the #106 exporter.
const fs = require('node:fs');
const path = require('node:path');

const schemaVersion = 1;
const editions = new Set(['public', 'internal']);
const decisionStates = new Set(['decided', 'pending']);
const isolationStates = new Set(['planned', 'enforced']);
const codeExtension = /\.(?:cjs|mjs|js|jsx|ts|tsx)$/;
const suffixes = [
  '',
  '.cjs',
  '.mjs',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '/index.cjs',
  '/index.js',
  '/index.ts',
  '/index.tsx',
];
const skipped = new Set([
  '.git',
  'node_modules',
  'dist',
  'outputs',
  '.venv',
  '.venv-klayout',
  '__pycache__',
  '.DS_Store',
]);
const workspacePackage = /^@industrial-agent-harness\/([a-z0-9-]+)(?:\/(.+))?$/;

function safeRelative(file) {
  return (
    typeof file === 'string' &&
    file !== '' &&
    !path.isAbsolute(file) &&
    !file.includes('\\') &&
    file.split('/').every(part => part && part !== '.' && part !== '..')
  );
}

function walk(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (skipped.has(entry.name)) return [];
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return walk(root, file);
    return entry.isFile() ? [file] : [];
  });
}

function validateSchema(manifest) {
  const failures = [];
  const fail = message => failures.push(message);
  if (!manifest || typeof manifest !== 'object') return ['Manifest must be a JSON object.'];
  if (manifest.schemaVersion !== schemaVersion)
    fail(`Unsupported schemaVersion: ${manifest.schemaVersion}.`);
  for (const field of ['manifestId', 'recordedAt', 'basisSourceRef', 'policyRevision'])
    if (typeof manifest[field] !== 'string' || !manifest[field])
      fail(`Manifest field missing or empty: ${field}.`);
  const release = manifest.release;
  if (!release || typeof release !== 'object') fail('Manifest release block missing.');
  else
    for (const field of ['externalRepoName', 'externalRepoUrl', 'externalDefaultBranch', 'license'])
      if (typeof release[field] !== 'string') fail(`Release field must be a string: ${field}.`);
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0)
    fail('Manifest entries must be a non-empty array.');
  const ids = new Set();
  const pathOwners = new Map();
  for (const entry of manifest.entries || []) {
    if (!entry || typeof entry !== 'object') {
      fail('Entry must be an object.');
      continue;
    }
    if (typeof entry.id !== 'string' || !entry.id) fail('Entry id missing.');
    else if (ids.has(entry.id)) fail(`Duplicate entry id: ${entry.id}.`);
    else ids.add(entry.id);
    if (!editions.has(entry.edition))
      fail(`Entry ${entry.id}: edition must be public or internal.`);
    if (typeof entry.dependencyClass !== 'string' || !entry.dependencyClass)
      fail(`Entry ${entry.id}: dependencyClass missing.`);
    if (!decisionStates.has(entry.decisionStatus))
      fail(`Entry ${entry.id}: decisionStatus must be decided or pending.`);
    if (!Array.isArray(entry.paths) || entry.paths.length === 0)
      fail(`Entry ${entry.id}: paths must be a non-empty array.`);
    else
      for (const file of entry.paths) {
        if (!safeRelative(file)) fail(`Entry ${entry.id}: unsafe path: ${String(file)}.`);
        if (pathOwners.has(file))
          fail(`Path claimed by two entries (${pathOwners.get(file)}, ${entry.id}): ${file}.`);
        else pathOwners.set(file, entry.id);
      }
    if (entry.entry !== undefined && !safeRelative(entry.entry))
      fail(`Entry ${entry.id}: unsafe entry path.`);
    if (entry.edition === 'public') {
      if (typeof entry.publicStatementSource !== 'string' || !entry.publicStatementSource)
        fail(`Entry ${entry.id}: public entries require publicStatementSource.`);
      if (entry.isolation) fail(`Entry ${entry.id}: public entries cannot declare isolation.`);
    } else {
      const isolation = entry.isolation;
      if (!isolation || typeof isolation !== 'object')
        fail(`Entry ${entry.id}: internal entries require isolation.`);
      else {
        if (!isolationStates.has(isolation.status))
          fail(`Entry ${entry.id}: isolation.status must be planned or enforced.`);
        if (!Number.isInteger(isolation.legacyReferences) || isolation.legacyReferences < 0)
          fail(`Entry ${entry.id}: isolation.legacyReferences must be a non-negative integer.`);
        if (isolation.status === 'enforced' && isolation.legacyReferences !== 0)
          fail(`Entry ${entry.id}: enforced isolation must record zero legacyReferences.`);
      }
    }
    if (entry.requiredTests !== undefined) {
      if (
        !Array.isArray(entry.requiredTests) ||
        entry.requiredTests.some(file => !safeRelative(file))
      )
        fail(`Entry ${entry.id}: requiredTests must be an array of safe paths.`);
    }
  }
  return failures;
}

// Longest declared path wins, so a file-level internal entry overrides its
// public package prefix.
function resolveEntry(manifest, file) {
  let best = null;
  for (const entry of manifest.entries)
    for (const prefix of entry.paths)
      if (
        (file === prefix || file.startsWith(`${prefix}/`)) &&
        (!best || prefix.length > best.prefix.length)
      )
        best = { entry, prefix };
  return best?.entry || null;
}

function importsOf(source) {
  return [
    ...source.matchAll(/(?:\b(?:require|import)\s*\(\s*|\bfrom\s+|\bimport\s+)['"]([^'"]+)['"]/g),
  ].map(match => match[1]);
}

function resolveImport(root, fromFile, spec) {
  const exists = file =>
    fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile();
  const candidates = [];
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    for (const suffix of suffixes) candidates.push(base + suffix);
  } else {
    const match = workspacePackage.exec(spec);
    if (!match) return null;
    const [, name, subpath] = match;
    const packageRoot = `packages/${name}`;
    if (subpath) {
      const base = `${packageRoot}/${subpath}`;
      for (const suffix of suffixes) candidates.push(base + suffix);
    } else {
      const manifestFile = path.join(root, packageRoot, 'package.json');
      if (fs.existsSync(manifestFile)) {
        const main = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).main;
        if (main) candidates.push(`${packageRoot}/${main}`);
      }
      candidates.push(`${packageRoot}/src/index.cjs`);
    }
  }
  return candidates.find(exists) || null;
}

function inspect(root, manifest, { gate = 'dev' } = {}) {
  const failures = [];
  const fail = message => failures.push(message);
  for (const message of validateSchema(manifest)) fail(`Schema: ${message}`);
  if (failures.length) return { ok: false, failures, gate };

  const absolute = file => path.join(root, file);
  for (const entry of manifest.entries) {
    for (const file of entry.paths)
      if (!entry.pathsMayBeAbsent && !fs.existsSync(absolute(file)))
        fail(`Entry ${entry.id}: declared path does not exist: ${file}.`);
    if (entry.entry && !fs.existsSync(absolute(entry.entry)))
      fail(`Entry ${entry.id}: entry point missing: ${entry.entry}.`);
    for (const test of entry.requiredTests || [])
      if (!fs.existsSync(absolute(test)))
        fail(`Entry ${entry.id}: required test missing: ${test}.`);
  }

  for (const entry of manifest.entries.filter(item => item.edition === 'public')) {
    const [file, anchor] = entry.publicStatementSource.split('#');
    if (!fs.existsSync(absolute(file))) {
      fail(`Entry ${entry.id}: publicStatementSource file missing: ${file}.`);
      continue;
    }
    const owner = resolveEntry(manifest, file);
    if (!owner || owner.edition !== 'public')
      fail(`Entry ${entry.id}: publicStatementSource must point at a public path: ${file}.`);
    if (anchor) {
      const content = fs.readFileSync(absolute(file), 'utf8');
      if (!content.toLowerCase().includes(anchor.toLowerCase()))
        fail(`Entry ${entry.id}: publicStatementSource anchor not found in ${file}: ${anchor}.`);
    }
  }

  const files = walk(root);
  const unclassified = files.filter(file => !resolveEntry(manifest, file));
  for (const file of unclassified.slice(0, 20)) fail(`Unclassified repository path: ${file}.`);
  if (unclassified.length > 20) fail(`...and ${unclassified.length - 20} more unclassified paths.`);

  const references = new Map(manifest.entries.map(entry => [entry.id, []]));
  for (const file of files) {
    if (!codeExtension.test(file)) continue;
    const source = resolveEntry(manifest, file);
    if (!source || source.edition !== 'public') continue;
    const content = fs.readFileSync(absolute(file), 'utf8');
    for (const spec of importsOf(content)) {
      const target = resolveImport(root, file, spec);
      if (!target) continue;
      const destination = resolveEntry(manifest, target);
      if (!destination) {
        fail(`Public file imports an unclassified path: ${file} -> ${spec}.`);
        continue;
      }
      if (destination.edition === 'internal')
        references.get(destination.id).push({ from: file, spec, target });
    }
  }
  for (const entry of manifest.entries.filter(item => item.edition === 'internal')) {
    const found = references.get(entry.id) || [];
    if (entry.isolation.status === 'enforced') {
      for (const reference of found)
        fail(
          `Public file imports enforced-internal ${entry.id}: ${reference.from} -> ${reference.spec}.`,
        );
    } else if (found.length > entry.isolation.legacyReferences)
      fail(
        `Entry ${entry.id}: legacy reference budget exceeded (${found.length} > ${entry.isolation.legacyReferences}); ` +
          'isolation references may only shrink until #102 completes.',
      );
  }

  if (gate === 'release') {
    const blockers = [];
    const release = manifest.release;
    if (!release.externalRepoName)
      blockers.push('release.externalRepoName is empty (external repository name undecided).');
    if (!release.externalRepoUrl) blockers.push('release.externalRepoUrl is empty.');
    if (!release.externalDefaultBranch) blockers.push('release.externalDefaultBranch is empty.');
    if (!release.license || release.license === 'pending')
      blockers.push('release.license is pending.');
    for (const entry of manifest.entries.filter(item => item.decisionStatus === 'pending'))
      blockers.push(`Entry ${entry.id} decisionStatus is pending.`);
    for (const entry of manifest.entries.filter(
      item => item.edition === 'internal' && item.isolation.status === 'planned',
    ))
      if ((references.get(entry.id) || []).length > 0)
        blockers.push(
          `Entry ${entry.id} is planned-internal with live public references; #102 isolation incomplete.`,
        );
    for (const blocker of blockers) fail(`Release gate: ${blocker}`);
    return { ok: failures.length === 0, failures, gate, blockers };
  }
  return { ok: failures.length === 0, failures, gate, references };
}

function main(argv) {
  let root = process.cwd(),
    manifestFile,
    gate = 'dev';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--manifest') manifestFile = path.resolve(argv[++i]);
    else if (argv[i] === '--gate') gate = argv[++i];
    else
      throw Error(
        'Usage: check-editions-manifest [--root DIR] [--manifest FILE] [--gate dev|release]',
      );
  }
  if (!['dev', 'release'].includes(gate)) throw Error(`Unknown gate: ${gate}`);
  const manifest = JSON.parse(
    fs.readFileSync(manifestFile || path.join(root, 'architecture/editions.json'), 'utf8'),
  );
  const report = inspect(root, manifest, { gate });
  process.stdout.write(
    JSON.stringify(report, (key, value) => (key === 'references' ? undefined : value), 2) + '\n',
  );
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { inspect, validateSchema, resolveEntry, resolveImport, walk, schemaVersion };
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
