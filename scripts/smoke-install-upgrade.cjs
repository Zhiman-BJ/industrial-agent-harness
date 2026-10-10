#!/usr/bin/env node
// Actual packaged-app replacement on one isolated profile; not a signed Core OTA gate.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { startModel } = require('../tests/integration/fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);
const appName = 'Industrial Agent Harness.app';
const GiB = 1024 ** 3;

function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (
      [
        '--plan',
        '--prepare',
        '--upgrade',
        '--capture-existing',
        '--recheck-final',
        '--update-pack',
      ].includes(key)
    )
      args[key.slice(2)] = true;
    else if (['--old-app', '--new-dmg', '--evidence', '--archive'].includes(key)) {
      assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for ${key}`);
      args[key.slice(2)] = path.resolve(argv[++i]);
    } else throw Error(`Unknown argument: ${key}`);
  }
  assert.ok(
    args['old-app'] && args.evidence,
    'Pass --old-app and --evidence; --plan is read-only.',
  );
  assert.ok(
    [args.prepare, args.upgrade, args['capture-existing'], args['recheck-final']].filter(Boolean)
      .length <= 1,
    'Choose one execution stage; omit stage flags for the complete preparation and upgrade flow.',
  );
  assert.ok(
    args.plan || args.prepare || args['capture-existing'] || args['new-dmg'],
    'Pass the exact candidate --new-dmg.',
  );
  assert.ok(
    !args['update-pack'] || args['recheck-final'],
    '--update-pack requires --recheck-final.',
  );
  return args;
}
function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function writeJson(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n');
}
function filesUnder(directory, include = () => true, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (!include(relative)) return [];
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected evidence symlink: ${file}`);
    return entry.isDirectory()
      ? filesUnder(file, include, relative)
      : entry.isFile()
        ? [relative]
        : [];
  });
}
function snapshotDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const tables = {};
    for (const { name } of database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      const rows = database.prepare(`SELECT * FROM ${quoted}`).all();
      // Persist hashes only, never configuration secrets or chat text in the report.
      const rowHashes = rows.map(row => hash(JSON.stringify(row))).sort();
      tables[name] = { count: rows.length, sha256: hash(JSON.stringify(rowHashes)), rowHashes };
    }
    return tables;
  } finally {
    database.close();
  }
}
async function snapshotEvidence(directory) {
  const files = {};
  const add = async (relative, category, database = false) => {
    const file = path.join(directory, relative);
    assert.ok(fs.statSync(file).isFile(), `Missing ${category}: ${relative}`);
    files[relative] = {
      category,
      size: fs.statSync(file).size,
      sha256: await fileHash(file),
      ...(database ? { tables: snapshotDatabase(file) } : {}),
    };
  };
  await add('profile/workspace/projects.json', 'project-binding');
  for (const file of filesUnder(path.join(directory, 'profile/model')))
    await add(path.join('profile/model', file), 'model-configuration');
  assert.ok(files['profile/model/model-profile.json'], 'Model configuration must exist.');
  assert.ok(
    files['profile/model/api-key.bin'],
    'The isolated controlled-model credential must exist.',
  );
  await add('profile/chats/chats.sqlite', 'chat', true);
  assert.equal(files['profile/chats/chats.sqlite'].tables.chats.count, 1);
  assert.equal(files['profile/chats/chats.sqlite'].tables.turns.count, 2);
  assert.ok(files['profile/chats/chats.sqlite'].tables.chat_events.count > 0);
  for (const file of filesUnder(
    path.join(directory, 'profile/chats/sessions'),
    relative =>
      !relative
        .split(path.sep)
        .some(part =>
          ['cache', 'logs', 'workspace', '.index-cache', '.index-dirty'].includes(part),
        ),
  )) {
    // Kimi transcript and persisted session identity, excluding server tokens and caches.
    // Its workspace symlink targets the project already hashed independently below.
    if (
      /(?:harness-native-session\.json|session_index\.jsonl|workspaces\.json|wire\.jsonl|state\.json)$/.test(
        file,
      )
    )
      await add(path.join('profile/chats/sessions', file), 'native-chat-session');
  }
  assert.ok(
    Object.entries(files).some(([name]) => name.endsWith('/wire.jsonl')),
    'Native chat transcript must exist.',
  );
  const stateFiles = filesUnder(path.join(directory, 'profile/state'));
  const databases = stateFiles.filter(file => file.endsWith('.sqlite'));
  assert.equal(databases.length, 1, 'Exactly one project Runtime database is expected.');
  for (const file of stateFiles) {
    if (file.endsWith('.sqlite') || file.startsWith('objects/'))
      await add(
        path.join('profile/state', file),
        file.endsWith('.sqlite') ? 'canonical-evidence' : 'artifact-object',
        file.endsWith('.sqlite'),
      );
  }
  const database = new DatabaseSync(path.join(directory, 'profile/state', databases[0]), {
    readOnly: true,
  });
  let recordCounts;
  try {
    recordCounts = Object.fromEntries(
      database
        .prepare('SELECT kind, COUNT(*) AS count FROM core_records GROUP BY kind')
        .all()
        .map(row => [row.kind, row.count]),
    );
    assert.equal(recordCounts.action, 2);
    assert.equal(recordCounts.verification, 2);
    assert.ok(recordCounts.artifact >= 2 && recordCounts.checkpoint >= 1);
    const records = kind =>
      database
        .prepare('SELECT json FROM core_records WHERE kind=?')
        .all(kind)
        .map(row => JSON.parse(row.json));
    const actions = records('action');
    assert.deepEqual(actions.map(action => action.toolId).sort(), [
      'cad.freecad.build',
      'cad.freecad.edit',
    ]);
    assert.ok(
      actions.every(
        action => action.status === 'completed' && action.verification.status === 'passed',
      ),
    );
    assert.ok(records('verification').every(result => result.status === 'passed'));
  } finally {
    database.close();
  }
  for (const file of filesUnder(path.join(directory, 'project')))
    await add(path.join('project', file), 'project-artifact');
  assert.equal(Object.keys(files).filter(file => /\/model\.FCStd$/.test(file)).length, 2);
  return { capturedAt: new Date().toISOString(), recordCounts, files };
}
function compareSnapshots(before, after) {
  const changedDatabaseFiles = [];
  const changes = [];
  for (const [file, prior] of Object.entries(before.files)) {
    const current = after.files[file];
    if (!current) {
      changes.push(`Missing: ${file}`);
      continue;
    }
    if (prior.tables) {
      // SQLite pages may legitimately change while opening/checkpointing a DB.
      // Every original logical record must survive byte-for-byte, as must artifacts.
      for (const [table, data] of Object.entries(prior.tables)) {
        const currentHashes = new Set(current.tables?.[table]?.rowHashes || []);
        if (data.rowHashes.some(value => !currentHashes.has(value)))
          changes.push(`Changed or missing persisted records: ${file}:${table}`);
      }
      if (prior.sha256 !== current.sha256) changedDatabaseFiles.push(file);
    } else if (prior.sha256 !== current.sha256 || prior.size !== current.size)
      changes.push(`Changed persisted file: ${file}`);
  }
  return {
    preserved: changes.length === 0,
    changes,
    checkedFiles: Object.keys(before.files).length,
    byteIdenticalFiles: Object.entries(before.files).filter(
      ([file, prior]) => after.files[file]?.sha256 === prior.sha256,
    ).length,
    changedDatabaseFiles,
    databasePolicy: 'Retain every original row hash; also report physical SQLite file hashes.',
  };
}
async function appIdentity(directory) {
  const plist = path.join(directory, 'Contents/Info.plist');
  const read = async key =>
    (await execute('/usr/libexec/PlistBuddy', ['-c', `Print:${key}`, plist])).stdout.trim();
  return {
    version: await read('CFBundleShortVersionString'),
    build: await read('CFBundleVersion'),
    bundleId: await read('CFBundleIdentifier'),
    plistSha256: await fileHash(plist),
    asarSha256: await fileHash(path.join(directory, 'Contents/Resources/app.asar')),
  };
}
async function withMountedDmg(dmg, use) {
  const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-upgrade-')));
  let attached = false;
  try {
    await execute('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      dmg,
    ]);
    attached = true;
    return await use(path.join(mount, appName));
  } finally {
    if (attached) await execute('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmdirSync(mount);
  }
}
async function controlledModel() {
  const recipe = {
    parameters: { L: 40, W: 20, T: 5, R: 2 },
    features: [
      { id: 'Plate', op: 'sketch_pad', profile: 'rectangle', length: 'L', width: 'W', height: 'T' },
      { id: 'Drilled', op: 'hole', base: 'Plate', radius: 'R', height: 'T', origin: [10, 10, 0] },
    ],
    result: 'Drilled',
  };
  return startModel({
    success: 'CAD_INSTALL_TASK_OK',
    calls: body => {
      const text = JSON.stringify(body.messages);
      const state = [...text.matchAll(/expectedStateId=([a-f0-9-]{36})/g)].at(-1)?.[1];
      assert.ok(state, 'Packaged Kimi must receive an observed Runtime state.');
      const file = text.match(/cad-output\/[a-f0-9-]{36}\/model.FCStd/)?.[0];
      return text.includes('CAD_INSTALL_EDIT')
        ? [
            null,
            null,
            { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.edit' } },
            {
              name: 'industrial_action_call',
              arguments: {
                toolId: 'cad.freecad.edit',
                expectedStateId: state,
                inputsJson: JSON.stringify({
                  file,
                  changes: { parameters: { W: 30, R: 3 } },
                  expect: { bounds: [40, 30, 5], volume: 6000 - 45 * Math.PI, solids: 1 },
                }),
              },
            },
          ]
        : [
            { name: 'industrial_tool_describe', arguments: { toolId: 'cad.freecad.build' } },
            {
              name: 'industrial_action_call',
              arguments: {
                toolId: 'cad.freecad.build',
                expectedStateId: state,
                inputs: {
                  recipe,
                  expect: { bounds: [40, 20, 5], volume: 4000 - 20 * Math.PI, solids: 1 },
                },
              },
            },
          ];
    },
  });
}
async function launch(application, args, evidence, env, log, timeout) {
  try {
    const result = await execute(
      path.join(application, 'Contents/MacOS/Industrial Agent Harness'),
      args,
      {
        cwd: evidence,
        env,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    fs.writeFileSync(path.join(evidence, log), result.stdout + result.stderr);
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, log),
      [error.message, error.stdout, error.stderr].filter(Boolean).join('\n'),
    );
    throw error;
  }
}
function applicationEnvironment(evidence, endpoint = '', archive = '') {
  return {
    ...process.env,
    INDUSTRIAL_HARNESS_FREECAD_CMD: '',
    KIMI_EXECUTABLE: '',
    INDUSTRIAL_HARNESS_PACK_STORE: path.join(evidence, 'packs'),
    INDUSTRIAL_HARNESS_PACK_FEED_FILE: '',
    INDUSTRIAL_HARNESS_PACK_CATALOG_URL: '',
    INDUSTRIAL_HARNESS_PACK_KEYS_FILE: '',
    HARNESS_RUNTIME_ARCHIVES: '',
    HARNESS_CAD_INSTALL_ARCHIVE: archive,
    HARNESS_CAD_INSTALL_MODEL_ENDPOINT: endpoint,
    HARNESS_CAD_INSTALL_REPORT_DIR: evidence,
  };
}
async function prepareOld(args, evidence, application) {
  const oldIdentity = await appIdentity(args['old-app']);
  assert.equal(oldIdentity.version, '1.0.0');
  writeJson(evidence, 'old-application.json', oldIdentity);
  fs.mkdirSync(path.dirname(application));
  await execute('/usr/bin/ditto', [args['old-app'], application]);
  assert.deepEqual(await appIdentity(application), oldIdentity);
  const model = await controlledModel();
  try {
    const env = applicationEnvironment(evidence, model.endpoint, args.archive || '');
    process.stdout.write(
      'Preparing genuine old 1.0.0 app with isolated CAD tasks and controlled model.\n',
    );
    await launch(
      application,
      ['--cad-install-selftest'],
      evidence,
      env,
      'old-application.log',
      25 * 60 * 1000,
    );
    const acceptance = JSON.parse(fs.readFileSync(path.join(evidence, 'acceptance.json'), 'utf8'));
    assert.equal(acceptance.packaged, true);
    assert.equal(acceptance.actions.length, 2);
    assert.equal(acceptance.verifications.length, 2);
    assert.ok(acceptance.verifications.every(item => item.status === 'passed'));
    assert.equal(acceptance.repaired, true);
    assert.ok(model.requests.length >= 6);
    writeJson(evidence, 'before-upgrade.json', await snapshotEvidence(evidence));
    fs.renameSync(
      path.join(evidence, 'acceptance.json'),
      path.join(evidence, 'old-acceptance.json'),
    );
    writeJson(evidence, 'preparation.json', {
      completed: true,
      oldIdentity,
      oldFullCadAcceptance: true,
      oldRepairExercised: true,
      model: { controlled: true, requests: model.requests.length, realUserApi: false },
    });
    process.stdout.write(`Old app preparation passed; ready for --upgrade: ${evidence}\n`);
  } finally {
    model.close();
  }
}
// A legacy screenshot failure can occur after both verified tasks. This captures
// only a migration-data baseline, explicitly not a passing full CAD/repair gate.
async function captureExistingOld(evidence, application) {
  const readJson = name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));
  assert.ok(
    !fs.existsSync(path.join(evidence, 'preparation.json')),
    'Preparation was already captured.',
  );
  assert.ok(
    !fs.existsSync(path.join(evidence, 'acceptance.json')),
    'Use the complete preparation flow when full acceptance exists.',
  );
  const failure = fs.readFileSync(path.join(evidence, 'old-application.log'), 'utf8');
  assert.ok(
    failure.includes('Error: UnknownVizError'),
    'This recovery is limited to the observed legacy screenshot failure.',
  );
  const oldIdentity = readJson('old-application.json');
  assert.equal(oldIdentity.version, '1.0.0');
  assert.deepEqual(await appIdentity(application), oldIdentity);
  const modelProfile = readJson('profile/model/model-profile.json');
  assert.equal(modelProfile.model, 'controlled-cad-install');
  assert.match(modelProfile.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  // Snapshot validates both completed actions and independent passed verifications.
  await snapshotEvidence(evidence);
  if (!fs.existsSync(path.join(evidence, 'old-restart.json'))) {
    await launch(
      application,
      ['--cad-install-selftest', '--cad-install-restart'],
      evidence,
      applicationEnvironment(evidence),
      'old-restart.log',
      90000,
    );
    fs.renameSync(path.join(evidence, 'restart.json'), path.join(evidence, 'old-restart.json'));
  }
  assert.deepEqual(readJson('old-restart.json'), {
    ready: true,
    projectRestored: true,
    actions: 2,
  });
  writeJson(evidence, 'before-upgrade.json', await snapshotEvidence(evidence));
  writeJson(evidence, 'preparation.json', {
    completed: true,
    oldIdentity,
    oldFullCadAcceptance: false,
    oldRepairExercised: false,
    legacyFailure:
      'UnknownVizError after the two verified CAD tasks; full Viewer/repair acceptance did not complete.',
    oldRestart: readJson('old-restart.json'),
    model: {
      controlled: true,
      requests: null,
      actualRequestCountNotRetained: true,
      realUserApi: false,
    },
    qualification:
      'Migration baseline only: two real tasks, passed canonical verification and old-app restart. The original failure log is retained; no acceptance.json was created.',
  });
  process.stdout.write(
    `Old app migration baseline captured; legacy full CAD acceptance remains failed: ${evidence}\n`,
  );
}
async function upgrade(args, evidence, application) {
  const readJson = name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));
  const preparation = readJson('preparation.json');
  assert.equal(preparation.completed, true);
  assert.ok(
    !fs.existsSync(path.join(evidence, 'upgrade.json')),
    'This evidence already contains an upgrade result.',
  );
  assert.deepEqual(await appIdentity(application), preparation.oldIdentity);
  const before = readJson('before-upgrade.json');
  const unchanged = compareSnapshots(before, await snapshotEvidence(evidence));
  assert.ok(unchanged.preserved, unchanged.changes.join('\n'));
  const nextIdentity = await withMountedDmg(args['new-dmg'], appIdentity);
  assert.equal(nextIdentity.version, '1.0.1-beta.1');
  assert.equal(nextIdentity.bundleId, preparation.oldIdentity.bundleId);
  assert.notEqual(nextIdentity.asarSha256, preparation.oldIdentity.asarSha256);
  writeJson(evidence, 'new-application.json', {
    ...nextIdentity,
    dmgSha256: await fileHash(args['new-dmg']),
  });
  process.stdout.write(
    'Replacing app at the same path; profile, packs and project remain in place.\n',
  );
  await withMountedDmg(args['new-dmg'], async source => {
    assert.deepEqual(await appIdentity(source), nextIdentity);
    // Only the script-owned app copy is removed; the original old app remains intact.
    fs.rmSync(application, { recursive: true });
    await execute('/usr/bin/ditto', [source, application]);
  });
  assert.deepEqual(await appIdentity(application), nextIdentity);
  await launch(
    application,
    ['--cad-install-selftest', '--cad-install-restart', '--cad-install-upgrade'],
    evidence,
    applicationEnvironment(evidence),
    'new-application.log',
    120000,
  );
  const restart = readJson('restart.json');
  assert.deepEqual(restart, { ready: true, projectRestored: true, actions: 2 });
  const packUpgrade = readJson('pack-upgrade.json');
  assert.equal(packUpgrade.fromVersion, '1.1.4-pack.4');
  assert.equal(packUpgrade.toVersion, '1.1.4-pack.8');
  assert.equal(packUpgrade.nativeRuntimeReused, true);
  assert.equal(packUpgrade.modelConfigurationLoaded, true);
  assert.equal(packUpgrade.loadedChat.turns, 2);
  assert.equal(packUpgrade.verifiedActions, 2);
  const after = await snapshotEvidence(evidence);
  writeJson(evidence, 'after-upgrade.json', after);
  const preservation = compareSnapshots(before, after);
  writeJson(evidence, 'upgrade.json', {
    passed: preservation.preserved,
    oldIdentity: preparation.oldIdentity,
    newIdentity: nextIdentity,
    sameApplicationPath: application,
    sameProfile: path.join(evidence, 'profile'),
    samePackStore: path.join(evidence, 'packs'),
    restart,
    packUpgrade,
    preservation,
    model: preparation.model,
    oldFullCadAcceptance: preparation.oldFullCadAcceptance,
    oldRepairExercised: preparation.oldRepairExercised,
    legacyPreparationFailure: preparation.legacyFailure || null,
    qualification:
      'Packaged app replacement and bundled CAD Pack upgrade only; signed/notarized public Core OTA was not exercised.',
  });
  assert.ok(preservation.preserved, preservation.changes.join('\n'));
  process.stdout.write(
    `Old → new packaged app replacement and data preservation passed: ${evidence}\n`,
  );
}
// Later builds keep their own identity/evidence. An explicit --update-pack checks
// the new .6 -> .7 transition without overwriting the original .4 -> .6 reports.
async function recheckFinal(args, evidence, application) {
  const updating = Boolean(args['update-pack']);
  const prefix = updating ? 'next-pack-upgrade' : 'final-restart';
  const readJson = name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));
  assert.ok(
    !fs.existsSync(path.join(evidence, `${prefix}.json`)),
    'Recheck evidence already exists.',
  );
  const original = readJson(updating ? 'final-restart.json' : 'upgrade.json');
  assert.equal(original.passed, true);
  const previousIdentity = updating ? original.finalIdentity : original.newIdentity;
  assert.deepEqual(await appIdentity(application), previousIdentity);
  const originalAfter = readJson(updating ? 'after-final-restart.json' : 'after-upgrade.json');
  const before = await snapshotEvidence(evidence);
  const baseline = compareSnapshots(originalAfter, before);
  assert.ok(baseline.preserved, baseline.changes.join('\n'));
  writeJson(evidence, `before-${prefix}.json`, before);
  const finalIdentity = await withMountedDmg(args['new-dmg'], appIdentity);
  assert.equal(finalIdentity.version, '1.0.1-beta.1');
  assert.equal(finalIdentity.bundleId, previousIdentity.bundleId);
  const dmgSha256 = await fileHash(args['new-dmg']);
  writeJson(evidence, updating ? 'next-pack-application.json' : 'final-application.json', {
    ...finalIdentity,
    dmgSha256,
  });
  await withMountedDmg(args['new-dmg'], async source => {
    assert.deepEqual(await appIdentity(source), finalIdentity);
    fs.rmSync(application, { recursive: true });
    await execute('/usr/bin/ditto', [source, application]);
  });
  assert.deepEqual(await appIdentity(application), finalIdentity);
  const originalRestart = updating ? null : fs.readFileSync(path.join(evidence, 'restart.json'));
  // Older packaged entries use one report filename. Continuation entries write
  // separate files; ordinary rechecks preserve the prior bytes explicitly.
  if (originalRestart)
    fs.writeFileSync(path.join(evidence, 'original-upgrade-restart.json'), originalRestart);
  let restarted;
  try {
    await launch(
      application,
      [
        '--cad-install-selftest',
        '--cad-install-restart',
        ...(updating ? ['--cad-install-upgrade', '--cad-install-continuation'] : []),
      ],
      evidence,
      applicationEnvironment(evidence),
      `${prefix}.log`,
      120000,
    );
    restarted = readJson(updating ? 'restart-continuation.json' : 'restart.json');
    writeJson(evidence, `${prefix}-result.json`, restarted);
  } finally {
    if (originalRestart) fs.writeFileSync(path.join(evidence, 'restart.json'), originalRestart);
  }
  assert.deepEqual(restarted, { ready: true, projectRestored: true, actions: 2 });
  let packUpgrade;
  if (updating) {
    packUpgrade = readJson('pack-upgrade-continuation.json');
    assert.equal(packUpgrade.fromVersion, '1.1.4-pack.6');
    assert.equal(packUpgrade.toVersion, '1.1.4-pack.8');
    assert.equal(packUpgrade.nativeRuntimeReused, true);
    assert.equal(packUpgrade.modelConfigurationLoaded, true);
    assert.equal(packUpgrade.loadedChat.turns, 2);
    assert.equal(packUpgrade.verifiedActions, 2);
  }
  const after = await snapshotEvidence(evidence);
  writeJson(evidence, `after-${prefix}.json`, after);
  const preservation = compareSnapshots(before, after);
  writeJson(evidence, `${prefix}.json`, {
    passed: preservation.preserved,
    finalIdentity,
    dmgSha256,
    sourceUpgradeDmgSha256: updating
      ? original.dmgSha256
      : readJson('new-application.json').dmgSha256,
    sameApplicationPath: application,
    sameProfile: path.join(evidence, 'profile'),
    samePackStore: path.join(evidence, 'packs'),
    restarted,
    preservation,
    packUpdatePerformed: updating,
    ...(packUpgrade ? { packUpgrade } : {}),
    qualification: updating
      ? 'Subsequent .6-to-.7 CAD Pack upgrade with native runtime reuse and preserved data. Original app/Pack migrations remain attributed to their original DMGs. No signed Core OTA claim.'
      : 'Final build restart with its previously upgraded Pack and existing data. The original migration remains attributed to its original DMG. No signed Core OTA claim.',
  });
  assert.ok(preservation.preserved, preservation.changes.join('\n'));
  process.stdout.write(`${prefix} passed with preserved data: ${evidence}\n`);
}
async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv);
  assert.ok(
    process.platform === 'darwin' && process.arch === 'arm64',
    'This gate requires Apple Silicon.',
  );
  if (args.upgrade || args['capture-existing'] || args['recheck-final'])
    assert.ok(
      fs.statSync(args.evidence).isDirectory(),
      'Upgrade requires completed --prepare evidence.',
    );
  else
    assert.ok(
      !fs.existsSync(args.evidence),
      'Use a fresh evidence directory; existing evidence is never modified.',
    );
  args['old-app'] = fs.realpathSync(args['old-app']);
  assert.ok(!args.evidence.startsWith(args['old-app'] + path.sep));
  if (args['new-dmg']) assert.ok(fs.statSync(args['new-dmg']).isFile());
  if (args.archive) assert.ok(fs.statSync(args.archive).isFile());
  let parent = path.dirname(args.evidence);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const space = fs.statfsSync(parent);
  // Budget old + new app, official archive and concurrent repair staging; the
  // production legacy runtime installer performs its own actual disk preflight.
  const plan = {
    kind: 'isolated-packaged-app-replacement',
    stage: args['recheck-final']
      ? args['update-pack']
        ? 'next-pack-upgrade'
        : 'recheck-final'
      : args.prepare
        ? 'prepare'
        : args.upgrade
          ? 'upgrade'
          : args['capture-existing']
            ? 'capture-existing'
            : 'complete',
    oldApp: args['old-app'],
    newDmg: args['new-dmg'] || null,
    evidence: args.evidence,
    oldVersion: '1.0.0',
    newVersion: '1.0.1-beta.1',
    availableBytes: space.bavail * space.bsize,
    minimumFreeBytes:
      (args['capture-existing'] ? 0.1 : args.upgrade || args['recheck-final'] ? 2 : 8) * GiB,
    expectedMinutes:
      '5–25 for preparation (official archive cache supplied); download time is additional',
    scope:
      'Real CAD migration baseline, app replacement, old data loading and bundled CAD metadata upgrade with native reuse. Legacy full Viewer/repair acceptance is reported separately. No signed Core OTA claim.',
  };
  if (args.plan) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  assert.ok(
    plan.availableBytes >= plan.minimumFreeBytes,
    `Keep at least ${plan.minimumFreeBytes / GiB} GiB free for this stage.`,
  );
  if (!args.upgrade && !args['capture-existing'] && !args['recheck-final'])
    fs.mkdirSync(args.evidence, { recursive: true });
  const evidence = fs.realpathSync(args.evidence);
  writeJson(
    evidence,
    args['recheck-final']
      ? args['update-pack']
        ? 'next-pack-upgrade-plan.json'
        : 'final-restart-plan.json'
      : args.upgrade
        ? 'upgrade-plan.json'
        : args['capture-existing']
          ? 'capture-plan.json'
          : 'plan.json',
    plan,
  );
  const application = path.join(evidence, 'application', appName);
  try {
    if (args['recheck-final']) await recheckFinal(args, evidence, application);
    else if (args['capture-existing']) await captureExistingOld(evidence, application);
    else {
      if (!args.upgrade) await prepareOld(args, evidence, application);
      if (!args.prepare) await upgrade(args, evidence, application);
    }
  } catch (error) {
    fs.writeFileSync(
      path.join(
        evidence,
        args['recheck-final']
          ? args['update-pack']
            ? 'next-pack-upgrade-failure.log'
            : 'final-restart-failure.log'
          : args.upgrade
            ? 'upgrade-failure.log'
            : args['capture-existing']
              ? 'capture-failure.log'
              : 'failure.log',
      ),
      error.stack + '\n',
    );
    throw error;
  }
}
module.exports = { argumentsFor, snapshotEvidence, compareSnapshots, snapshotDatabase };
if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
