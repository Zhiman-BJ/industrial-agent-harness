'use strict';

// Bundle loader (#104, read side for #105). Reads a recording directory with
// no access to the original project or chat store, validates it strictly,
// and exposes the event stream. This module is offline and read-only: it
// never calls a model, tool, or runtime, and treats gaps as gaps.

const fs = require('node:fs');
const path = require('node:path');

const { BUNDLE_FILES, KNOWN_EVENT_TYPES, isTerminalEvent } = require('./manifest.cjs');
const { validateManifest, validateEventStream } = require('./validate.cjs');

class RecordingError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

function readManifest(directory) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(directory, BUNDLE_FILES.manifest), 'utf8'));
  } catch (error) {
    throw new RecordingError('bundle:unreadable-manifest', error.message);
  }
  const errors = validateManifest(manifest);
  if (errors.length > 0)
    throw new RecordingError(errors[0].code, `${errors[0].code}: ${errors[0].detail}`);
  return manifest;
}

// A crashed recorder leaves status "recording" behind. Appends are line-atomic
// in practice only up to the last full write, so exactly two damage classes
// are tolerated for such bundles: a torn final line and a stale event count.
// Everything else (disorder, unknown events, hash mismatch) stays fatal.
function parseInterruptedStream(text, manifest) {
  const warnings = [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    warnings.push('events:truncated: dropped a torn final line after a crash');
    lines.pop();
  }
  const events = [];
  let expectedSeq = 1;
  let lastRelMs = 0;
  let terminal = null;
  for (const line of lines) {
    if (line === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new RecordingError(
        'events:corrupt-json',
        'corrupt JSON before the final line of an interrupted bundle',
      );
    }
    if (record.seq !== expectedSeq)
      throw new RecordingError(
        'events:seq',
        `expected seq ${expectedSeq}, got ${JSON.stringify(record.seq)}`,
      );
    expectedSeq++;
    if (record.relMs < lastRelMs)
      throw new RecordingError(
        'events:time-regression',
        `relMs ${record.relMs} < previous ${lastRelMs}`,
      );
    lastRelMs = record.relMs;
    if (!KNOWN_EVENT_TYPES.includes(record.event?.type))
      throw new RecordingError(
        'events:unknown-type',
        `unknown event type ${JSON.stringify(record.event?.type)}`,
      );
    if (isTerminalEvent(record.event)) terminal = record.event;
    events.push(record);
  }
  if (manifest.events.count !== events.length)
    warnings.push(
      `bundle:count-mismatch: manifest claimed ${manifest.events.count} events, ${events.length} survived the interruption`,
    );
  return { events, warnings, terminal };
}

function loadBundle(directory) {
  const manifest = readManifest(directory);
  let text;
  try {
    text = fs.readFileSync(path.join(directory, manifest.events.file), 'utf8');
  } catch (error) {
    throw new RecordingError('bundle:unreadable-events', error.message);
  }

  if (manifest.status === 'recording') {
    const { events, warnings, terminal } = parseInterruptedStream(text, manifest);
    const interrupted = {
      ...manifest,
      status: 'incomplete',
      incompleteReason: 'app-shutdown',
      interruptedUnmarked: true,
      outcome: terminal
        ? terminal.type === 'error'
          ? 'error'
          : terminal.result?.status === 'cancelled'
            ? 'cancelled'
            : 'success'
        : 'unknown',
    };
    return {
      manifest: interrupted,
      events,
      warnings,
      missingAssets: (manifest.assets || [])
        .filter(asset => asset.status === 'missing')
        .map(asset => asset.id),
    };
  }

  const stream = validateEventStream(text, manifest.limits);
  if (stream.errors.length > 0)
    throw new RecordingError(
      stream.errors[0].code,
      `${stream.errors[0].code}: ${stream.errors[0].detail}`,
    );
  if (manifest.status === 'complete' && !stream.sawTerminal)
    throw new RecordingError(
      'bundle:complete-without-terminal',
      'status complete requires a done or error event',
    );
  if (manifest.events.count !== stream.count)
    throw new RecordingError(
      'bundle:count-mismatch',
      `manifest claims ${manifest.events.count} events, stream has ${stream.count}`,
    );

  return {
    manifest,
    events: parseStrict(text),
    warnings: [],
    missingAssets: (manifest.assets || [])
      .filter(asset => asset.status === 'missing')
      .map(asset => asset.id),
  };
}

function parseStrict(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    events.push(JSON.parse(line));
  }
  return events;
}

// Iterate events for large bundles; validation happens up front so the
// iterator only yields well-formed records.
function streamEvents(directory, onRecord) {
  const bundle = loadBundle(directory);
  for (const record of bundle.events) onRecord(record, bundle.manifest);
  return bundle;
}

module.exports = { loadBundle, streamEvents, RecordingError };
