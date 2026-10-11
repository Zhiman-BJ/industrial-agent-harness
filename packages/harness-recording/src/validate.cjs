'use strict';

// Bundle validator (#104). Deterministic checks over a recording directory:
// manifest shape, event stream ordering, and asset integrity. Every rejection
// carries a stable code so loaders and tests can branch on it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  SCHEMA_VERSION,
  BUNDLE_FILES,
  KNOWN_EVENT_TYPES,
  INCOMPLETE_REASONS,
  OUTCOMES,
  REDACTION_REVIEW_STATUSES,
  DEFAULT_LIMITS,
  isTerminalEvent,
  isSafeRelativePath,
  isIsoString,
  uuidLike,
} = require('./manifest.cjs');

function fail(code, detail) {
  return { code, detail };
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    errors.push(fail('manifest:not-object', 'recording.json must contain a JSON object'));
    return errors;
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    errors.push(
      fail(
        'manifest:schema-version',
        `unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)}; this loader supports ${SCHEMA_VERSION} only`,
      ),
    );
  if (!uuidLike(manifest.recordingId))
    errors.push(fail('manifest:recording-id', 'recordingId missing or malformed'));
  if (!isIsoString(manifest.createdAt))
    errors.push(fail('manifest:created-at', 'createdAt must be an ISO timestamp'));

  const status = manifest.status;
  if (!['recording', 'complete', 'incomplete'].includes(status))
    errors.push(fail('manifest:status', `unknown status ${JSON.stringify(status)}`));
  if (status === 'incomplete' && !INCOMPLETE_REASONS.has(manifest.incompleteReason))
    errors.push(
      fail(
        'manifest:incomplete-reason',
        `status incomplete requires a known reason, got ${JSON.stringify(manifest.incompleteReason)}`,
      ),
    );

  if (!OUTCOMES.has(manifest.outcome))
    errors.push(fail('manifest:outcome', `unknown outcome ${JSON.stringify(manifest.outcome)}`));

  const chat = manifest.chat;
  if (!chat || !uuidLike(chat.chatId))
    errors.push(fail('manifest:chat', 'chat.chatId missing or malformed'));

  const events = manifest.events;
  if (!events || events.file !== BUNDLE_FILES.events)
    errors.push(fail('manifest:events-file', `events.file must be "${BUNDLE_FILES.events}"`));

  if (!Array.isArray(manifest.assets))
    errors.push(fail('manifest:assets', 'assets must be an array'));
  else {
    manifest.assets.forEach((asset, index) => {
      const where = `assets[${index}]`;
      if (!uuidLike(asset?.id)) errors.push(fail('asset:id', `${where}: id missing or malformed`));
      if (!['artifact-snapshot', 'image', 'viewer-companion'].includes(asset?.type))
        errors.push(
          fail('asset:type', `${where}: unknown asset type ${JSON.stringify(asset?.type)}`),
        );
      if (!isSafeRelativePath(asset?.relativePath))
        errors.push(
          fail(
            'asset:path',
            `${where}: relativePath must stay inside the bundle (no absolute, .., or \\)`,
          ),
        );
      if (!Number.isInteger(asset?.bytes) || asset.bytes < 0)
        errors.push(fail('asset:bytes', `${where}: bytes must be a non-negative integer`));
      if (!/^[0-9a-f]{64}$/.test(asset?.sha256 || ''))
        errors.push(fail('asset:sha256', `${where}: sha256 must be a lowercase hex digest`));
      if (!['present', 'missing'].includes(asset?.status))
        errors.push(fail('asset:status', `${where}: status must be present or missing`));
    });
    const ids = new Set();
    for (const asset of manifest.assets) {
      if (ids.has(asset.id)) errors.push(fail('asset:dup-id', `duplicate asset id ${asset.id}`));
      ids.add(asset.id);
    }
  }

  const redaction = manifest.redaction;
  if (!redaction || !REDACTION_REVIEW_STATUSES.has(redaction.reviewed))
    errors.push(fail('manifest:redaction', 'redaction.reviewed must be a known review status'));
  else if (redaction.reviewed !== 'unreviewed' && !redaction.applied)
    errors.push(
      fail(
        'manifest:redaction',
        'a reviewed demo bundle must record applied redaction before approval',
      ),
    );

  if (manifest.limits) {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = manifest.limits[key];
      if (value !== undefined && (!Number.isInteger(value) || value <= 0))
        errors.push(fail('manifest:limits', `limits.${key} must be a positive integer`));
    }
  }
  return errors;
}

// Validate an events.jsonl text. Checks are ordered so the first structural
// problem is reported before ordering problems that would otherwise cascade.
function validateEventStream(text, { maxEventBytes = DEFAULT_LIMITS.maxEventBytes } = {}) {
  const errors = [];
  let expectedSeq = 1;
  let lastRelMs = 0;
  let count = 0;
  let sawTerminal = false;
  let lastOutcome = null;
  if (text.length === 0) {
    errors.push(fail('events:empty', 'event stream is empty'));
    return { errors, count, sawTerminal, lastOutcome };
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] !== '')
    errors.push(
      fail('events:truncated', 'event stream does not end with a newline (truncated write)'),
    );
  for (let index = 0; index < lines.length - (lines[lines.length - 1] === '' ? 1 : 0); index++) {
    const line = lines[index];
    const where = `line ${index + 1}`;
    if (Buffer.byteLength(line, 'utf8') > maxEventBytes) {
      errors.push(fail('events:oversize', `${where}: exceeds maxEventBytes`));
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      errors.push(fail('events:corrupt-json', `${where}: not valid JSON`));
      continue;
    }
    count++;
    if (record.seq !== expectedSeq)
      errors.push(
        fail(
          'events:seq',
          `${where}: expected seq ${expectedSeq}, got ${JSON.stringify(record.seq)}`,
        ),
      );
    else expectedSeq++;
    if (!Number.isFinite(record.relMs) || record.relMs < 0)
      errors.push(fail('events:rel-ms', `${where}: relMs must be a finite non-negative number`));
    else if (record.relMs < lastRelMs)
      errors.push(
        fail('events:time-regression', `${where}: relMs ${record.relMs} < previous ${lastRelMs}`),
      );
    else lastRelMs = record.relMs;
    if (!isIsoString(record.at))
      errors.push(fail('events:at', `${where}: at must be an ISO timestamp`));
    const origin = record.origin;
    if (!origin || !uuidLike(origin.chatId) || !uuidLike(origin.turnId))
      errors.push(fail('events:origin', `${where}: origin.chatId/turnId missing or malformed`));
    const type = record.event?.type;
    if (!KNOWN_EVENT_TYPES.includes(type))
      errors.push(
        fail('events:unknown-type', `${where}: unknown event type ${JSON.stringify(type)}`),
      );
    if (isTerminalEvent(record.event)) {
      sawTerminal = true;
      lastOutcome =
        record.event.type === 'error'
          ? 'error'
          : record.event.result?.status === 'cancelled'
            ? 'cancelled'
            : 'success';
    }
  }
  return { errors, count, sawTerminal, lastOutcome };
}

// Full bundle check: manifest + stream cross-consistency + asset integrity.
function validateBundle(directory) {
  const errors = [];
  const manifestPath = path.join(directory, BUNDLE_FILES.manifest);
  let manifest = null;
  let text = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return [
      fail('bundle:unreadable-manifest', `cannot read ${BUNDLE_FILES.manifest}: ${error.message}`),
    ];
  }
  errors.push(...validateManifest(manifest));
  try {
    text = fs.readFileSync(
      path.join(directory, manifest?.events?.file || BUNDLE_FILES.events),
      'utf8',
    );
  } catch (error) {
    return [
      ...errors,
      fail('bundle:unreadable-events', `cannot read event stream: ${error.message}`),
    ];
  }
  const stream = validateEventStream(text, manifest?.limits);
  errors.push(...stream.errors);

  if (
    manifest?.events &&
    Number.isInteger(manifest.events.count) &&
    manifest.events.count !== stream.count
  )
    errors.push(
      fail(
        'bundle:count-mismatch',
        `manifest claims ${manifest.events.count} events, stream has ${stream.count}`,
      ),
    );

  if (manifest?.status === 'complete' && !stream.sawTerminal)
    errors.push(
      fail('bundle:complete-without-terminal', 'status complete requires a done or error event'),
    );

  for (const asset of manifest?.assets || []) {
    if (asset.status === 'missing') continue;
    const assetPath = path.join(directory, asset.relativePath);
    let stat = null;
    try {
      stat = fs.statSync(assetPath);
      // A symlinked segment could redirect outside the bundle, but comparing
      // realpath against resolve would also fire for a legitimately symlinked
      // bundle root (macOS /var -> /private/var). Check each path segment
      // under the bundle itself with lstat instead.
      let segment = path.resolve(directory);
      for (const part of asset.relativePath.split('/')) {
        segment = path.join(segment, part);
        if (fs.lstatSync(segment).isSymbolicLink()) {
          errors.push(fail('asset:symlink', `asset ${asset.id}: symbolic links are not allowed`));
          break;
        }
      }
    } catch {
      errors.push(fail('asset:absent', `asset ${asset.id}: marked present but file is missing`));
      continue;
    }
    if (stat.size !== asset.bytes)
      errors.push(
        fail('asset:size', `asset ${asset.id}: size ${stat.size} != manifest ${asset.bytes}`),
      );
    const digest = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
    if (digest !== asset.sha256)
      errors.push(fail('asset:hash', `asset ${asset.id}: sha256 mismatch`));
  }
  return errors;
}

module.exports = { validateManifest, validateEventStream, validateBundle };
