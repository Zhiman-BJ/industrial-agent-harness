'use strict';

// Recorder core (#104). Observes presentation events from TaskService.onEvent
// and seals them into a portable bundle directory. The recorder is a pure
// observer: it must never throw into the live task path, never re-execute
// tasks, and never mutate project evidence — recorder failures seal the
// bundle as incomplete instead.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  BUNDLE_FILES,
  createManifest,
  isTerminalEvent,
  outcomeFromTerminal,
} = require('./manifest.cjs');

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, filePath);
}

function slug(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function createRecorder({
  directory,
  chatId,
  projectId = null,
  displayName = null,
  recordingId = slug('rec'),
  limits = {},
  now = () => new Date().toISOString(),
  initialTurns = [],
}) {
  if (typeof directory !== 'string' || directory.length === 0)
    throw Error('recorder requires an output directory');
  if (typeof chatId !== 'string' || chatId.length === 0) throw Error('recorder requires a chatId');

  const state = {
    phase: 'idle', // idle -> recording -> sealed
    manifest: null,
    seq: 0,
    startedAtMs: null,
    eventsPath: null,
    bytesWritten: 0,
    ignoredForeign: 0,
    terminal: null,
    sealedAs: null,
  };

  function ensureRecording() {
    if (state.phase === 'idle') throw Error('recorder has not started');
    if (state.phase === 'sealed') return false;
    return true;
  }

  function seal(status, incompleteReason) {
    if (state.phase !== 'recording') return state.sealedAs;
    state.manifest.status = status;
    if (status === 'incomplete') state.manifest.incompleteReason = incompleteReason || 'unknown';
    state.manifest.completedAt = now();
    if (state.terminal) state.manifest.outcome = outcomeFromTerminal(state.terminal);
    else if (status === 'complete') state.manifest.outcome = 'unknown';
    state.manifest.durationMs = state.startedAtMs
      ? Date.parse(state.manifest.completedAt) - state.startedAtMs
      : null;
    writeJsonAtomic(path.join(directory, BUNDLE_FILES.manifest), state.manifest);
    state.phase = 'sealed';
    state.sealedAs = { status, incompleteReason: incompleteReason || null };
    return state.sealedAs;
  }

  function handleRecorderError(error, reason) {
    // Recording faults must not interrupt the live task (issue #104): contain
    // them, seal what exists as incomplete, and stop observing.
    try {
      seal('incomplete', reason);
    } catch {
      state.phase = 'sealed';
      state.sealedAs = { status: 'incomplete', incompleteReason: reason, unsaved: true };
    }
    state.lastError = error;
    return false;
  }

  function start() {
    if (state.phase !== 'idle') throw Error('recorder already started');
    const startedAt = now();
    fs.mkdirSync(path.join(directory, BUNDLE_FILES.assetsDir), { recursive: true, mode: 0o700 });
    state.manifest = createManifest({
      recordingId,
      chatId,
      projectId,
      displayName,
      startedAt,
      limits,
    });
    if (initialTurns.length > 0) {
      state.manifest.chat.initialSnapshot = {
        included: true,
        turns: initialTurns.map(turn => ({
          turnId: turn.turnId,
          startedAt: turn.startedAt ?? null,
          summary: turn.summary ?? null,
        })),
        note: 'Turns listed here happened before recording start; their event ordering was not recorded.',
      };
    }
    state.startedAtMs = Date.parse(startedAt);
    state.eventsPath = path.join(directory, BUNDLE_FILES.events);
    fs.writeFileSync(state.eventsPath, '');
    writeJsonAtomic(path.join(directory, BUNDLE_FILES.manifest), state.manifest);
    state.phase = 'recording';
    return { recordingId, directory };
  }

  // Feed one (displayed event, metadata) pair as delivered by
  // TaskService.onEvent. Returns true when appended to this bundle.
  function record(event, metadata) {
    if (!ensureRecording()) return false;
    try {
      if (metadata?.chatId !== chatId) {
        // Background tasks on other chats must never leak into this bundle.
        state.ignoredForeign++;
        return false;
      }
      const at = now();
      const line = JSON.stringify({
        seq: state.seq + 1,
        at,
        relMs: Math.max(0, Date.parse(at) - state.startedAtMs),
        origin: {
          chatId: metadata.chatId,
          projectId: metadata.projectId ?? null,
          turnId: metadata.turnId,
          eventRevision: metadata.eventRevision ?? null,
        },
        event,
      });
      if (Buffer.byteLength(line, 'utf8') > state.manifest.limits.maxEventBytes) {
        // Oversize single events are skipped explicitly rather than silently
        // truncating the stream; the skip is visible in the manifest.
        state.manifest.skippedOversize = (state.manifest.skippedOversize || 0) + 1;
        return false;
      }
      if (state.seq + 1 > state.manifest.limits.maxEvents) {
        seal('incomplete', 'cap-exceeded');
        return false;
      }
      fs.appendFileSync(state.eventsPath, line + '\n');
      state.seq++;
      state.bytesWritten += Buffer.byteLength(line + '\n', 'utf8');
      state.manifest.events.count = state.seq;
      state.manifest.events.firstSeq = 1;
      state.manifest.events.lastSeq = state.seq;
      if (state.bytesWritten + totalAssetBytes() > state.manifest.limits.maxTotalBytes) {
        seal('incomplete', 'cap-exceeded');
        return false;
      }
      if (isTerminalEvent(event)) state.terminal = event;
      return true;
    } catch (error) {
      if (error.code === 'ENOSPC') return handleRecorderError(error, 'disk-full');
      return handleRecorderError(error, 'recorder-error');
    }
  }

  function totalAssetBytes() {
    return state.manifest.assets.reduce((sum, asset) => sum + (asset.bytes || 0), 0);
  }

  // Register a viewer/artifact snapshot into the bundle. The caller supplies
  // the bytes; the recorder hashes, stores, and indexes them. Asset capture
  // failures degrade to a manifest "missing" entry, never a recording abort.
  function noteAsset({
    id,
    type,
    bytes,
    filename,
    mediaType = 'application/octet-stream',
    source = null,
  }) {
    if (!ensureRecording()) return false;
    try {
      const relativePath = path.posix.join(BUNDLE_FILES.assetsDir, filename);
      const destination = path.join(directory, relativePath);
      fs.writeFileSync(destination, bytes);
      const stat = fs.statSync(destination);
      state.manifest.assets.push({
        id,
        type,
        relativePath,
        mediaType,
        bytes: stat.size,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        status: 'present',
        source: source
          ? {
              artifactId: source.artifactId ?? null,
              actionId: source.actionId ?? null,
              originalPath: source.originalPath ?? null,
            }
          : null,
      });
      if (totalAssetBytes() > state.manifest.limits.maxAssetsBytes) {
        seal('incomplete', 'cap-exceeded');
      }
      return true;
    } catch (error) {
      if (state.manifest) {
        state.manifest.assets.push({
          id,
          type,
          relativePath: path.posix.join(BUNDLE_FILES.assetsDir, filename || 'unnamed'),
          mediaType,
          bytes: bytes?.length ?? 0,
          sha256: crypto
            .createHash('sha256')
            .update(bytes || Buffer.alloc(0))
            .digest('hex'),
          status: 'missing',
          source: null,
        });
      }
      state.lastError = error;
      return false;
    }
  }

  // Explicit stop by the user or the end of the recorded conversation.
  function stop() {
    if (state.phase !== 'recording') return state.sealedAs;
    if (state.terminal) return seal('complete');
    return seal('incomplete', 'stopped-before-completion');
  }

  // App shutdown / page reload: seal whatever exists as interrupted.
  function dispose(reason = 'app-shutdown') {
    if (state.phase !== 'recording') return state.sealedAs;
    return seal('incomplete', reason);
  }

  function stats() {
    return {
      phase: state.phase,
      recorded: state.seq,
      ignoredForeign: state.ignoredForeign,
      bytesWritten: state.bytesWritten,
      sealedAs: state.sealedAs,
      lastError: state.lastError ? String(state.lastError?.message || state.lastError) : null,
    };
  }

  return { start, record, noteAsset, stop, dispose, stats };
}

module.exports = { createRecorder };
