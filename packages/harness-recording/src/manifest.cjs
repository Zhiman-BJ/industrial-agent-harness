'use strict';

const path = require('node:path');

// RecordingManifest schema (#104): a versioned, portable description of one
// recorded chat. The bundle is a plain directory — recording.json plus
// events.jsonl plus assets/ — so it can be copied between machines without
// the original project. The recorder observes presentation events only and
// never re-executes tasks to fill gaps (PD-070).

const SCHEMA_VERSION = 1;

const BUNDLE_FILES = {
  manifest: 'recording.json',
  events: 'events.jsonl',
  assetsDir: 'assets',
};

// Display event vocabulary mirrored from packages/viewer-builtin/src/api.ts
// (AgentEvent union). The validator rejects unknown types so a newer bundle
// fails loudly instead of replaying half-understood content.
const KNOWN_EVENT_TYPES = [
  'results-changed',
  'results-ready',
  'user-images',
  'input-images',
  'context-reset',
  'diagnostic-log',
  'background-state',
  'subagent-state',
  'text',
  'thinking',
  'approval',
  'approval-resolved',
  'question',
  'question-resolved',
  'tool',
  'tool-result',
  'todo',
  'status',
  'compaction',
  'context-metrics',
  'step',
  'done',
  'error',
  'execution-boundary',
  'resources-filtered',
  'industrial-result',
];

const TERMINAL_EVENT_TYPES = new Set(['done', 'error']);

const INCOMPLETE_REASONS = new Set([
  'recorder-error',
  'cap-exceeded',
  'app-shutdown',
  'disk-full',
  'stopped-before-completion',
  'unknown',
]);

const OUTCOMES = new Set(['success', 'error', 'cancelled', 'background', 'unknown']);

const REDACTION_REVIEW_STATUSES = new Set(['unreviewed', 'approved', 'changes-requested']);

const DEFAULT_LIMITS = {
  maxEvents: 50000,
  maxEventBytes: 512 * 1024,
  maxAssetsBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

function isIsoString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function uuidLike(value) {
  return typeof value === 'string' && /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,127}$/.test(value);
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (path.isAbsolute(value)) return false;
  // Bundle paths are POSIX-relative by contract: a Windows drive prefix or a
  // backslash is drive-relative on win32 and can escape the bundle root via
  // path.resolve, so reject both regardless of the validating platform.
  if (value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}

function createManifest({ recordingId, chatId, projectId, displayName, startedAt, limits }) {
  if (!uuidLike(recordingId)) throw Error('recordingId must be a short slug');
  if (!uuidLike(chatId)) throw Error('chatId must be a short slug');
  if (projectId !== undefined && projectId !== null && !uuidLike(projectId))
    throw Error('projectId must be a short slug when present');
  if (!isIsoString(startedAt)) throw Error('startedAt must be an ISO timestamp');
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    recordingId,
    createdAt: startedAt,
    source: {
      kind: 'chat-recording',
      capturedVia: 'taskservice-presentation-events',
    },
    chat: {
      chatId,
      projectId: projectId ?? null,
      displayName: displayName ?? null,
      initialSnapshot: {
        included: false,
        turns: [],
        note: 'Turns before recording start are summarized here; their ordering was not recorded.',
      },
    },
    status: 'recording',
    outcome: 'unknown',
    events: { file: BUNDLE_FILES.events, count: 0, firstSeq: null, lastSeq: null },
    assets: [],
    limits: { ...DEFAULT_LIMITS, ...(limits || {}) },
    redaction: {
      applied: false,
      mode: 'original',
      rulesVersion: null,
      reviewed: 'unreviewed',
      reviewNote: null,
    },
  };
  return manifest;
}

function isTerminalEvent(event) {
  return TERMINAL_EVENT_TYPES.has(event?.type);
}

function outcomeFromTerminal(event) {
  if (event?.type === 'error') return 'error';
  const status = event?.result?.status;
  if (status === 'cancelled') return 'cancelled';
  if (status === 'background') return 'background';
  return 'success';
}

module.exports = {
  SCHEMA_VERSION,
  BUNDLE_FILES,
  KNOWN_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  INCOMPLETE_REASONS,
  OUTCOMES,
  REDACTION_REVIEW_STATUSES,
  DEFAULT_LIMITS,
  createManifest,
  isTerminalEvent,
  outcomeFromTerminal,
  isSafeRelativePath,
  isIsoString,
  uuidLike,
};
