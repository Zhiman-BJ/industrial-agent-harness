'use strict';

// Demo-copy export (#104): turns an original recording bundle into a
// portable, desensitized demo bundle. The original directory is opened
// read-only and never modified; the demo copy is a separate directory whose
// text is redacted and whose assets are included only after explicit human
// approval (unreviewed assets stay out and surface as explicit gaps).
// The exported bundle must itself pass validation before export finishes.

const fs = require('node:fs');
const path = require('node:path');

const { BUNDLE_FILES } = require('./manifest.cjs');
const { loadBundle } = require('./loader.cjs');
const { validateBundle } = require('./validate.cjs');
const { compileRules, redactEvent, RULES_VERSION } = require('./redact.cjs');

function ensureSafeTarget(sourceDirectory, targetDirectory) {
  if (path.resolve(sourceDirectory) === path.resolve(targetDirectory))
    throw Error('demo export target must differ from the source bundle');
  if (fs.existsSync(targetDirectory)) {
    const entries = fs.readdirSync(targetDirectory);
    const allowed = new Set([BUNDLE_FILES.manifest, BUNDLE_FILES.events, BUNDLE_FILES.assetsDir]);
    for (const entry of entries)
      if (!allowed.has(entry)) throw Error(`refusing to overwrite non-bundle directory: ${entry}`);
  }
}

function exportDemoBundle(sourceDirectory, targetDirectory, options = {}) {
  const {
    literals = [],
    approvedAssets = [], // asset ids a human has cleared for the demo copy
    displayName = null,
  } = options;

  const bundle = loadBundle(sourceDirectory);
  const rules = compileRules({ literals });

  ensureSafeTarget(sourceDirectory, targetDirectory);
  fs.rmSync(targetDirectory, { recursive: true, force: true });
  fs.mkdirSync(path.join(targetDirectory, BUNDLE_FILES.assetsDir), {
    recursive: true,
    mode: 0o700,
  });

  const approved = new Set(approvedAssets);
  const eventsPath = path.join(targetDirectory, BUNDLE_FILES.events);
  const lines = [];
  for (const record of bundle.events) {
    // Redaction never reorders events or invents timing; the record skeleton
    // (seq/at/origin) is preserved so replay keeps its anchors.
    lines.push(
      JSON.stringify({
        ...record,
        event: redactEvent(record.event, rules),
      }),
    );
  }
  fs.writeFileSync(eventsPath, lines.join('\n') + (lines.length ? '\n' : ''));

  const manifest = {
    ...bundle.manifest,
    recordingId: `${bundle.manifest.recordingId}-demo`,
    status: bundle.manifest.status,
    outcome: bundle.manifest.outcome,
    events: { ...bundle.manifest.events, count: lines.length },
    chat: {
      ...bundle.manifest.chat,
      displayName: displayName ?? bundle.manifest.chat?.displayName ?? null,
    },
    assets: [],
    redaction: {
      applied: true,
      mode: 'demo',
      rulesVersion: RULES_VERSION,
      literalsCount: literals.length,
      reviewed: 'unreviewed',
      reviewNote: null,
      reviewedAt: null,
    },
    sourceRecording: { recordingId: bundle.manifest.recordingId, redactedFrom: 'original-bundle' },
  };

  for (const asset of bundle.manifest.assets || []) {
    if (!approved.has(asset.id)) {
      manifest.assets.push({
        ...asset,
        status: 'missing',
        note: 'not human-cleared for the demo copy',
      });
      continue;
    }
    const source = path.join(sourceDirectory, asset.relativePath);
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(targetDirectory, asset.relativePath), bytes);
    manifest.assets.push({ ...asset, status: 'present', note: 'human-cleared; bytes unmodified' });
  }

  const manifestPath = path.join(targetDirectory, BUNDLE_FILES.manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const errors = validateBundle(targetDirectory);
  if (errors.length > 0) {
    throw Error(
      `demo bundle failed validation after export: ${errors.map(error => error.code).join(', ')}`,
    );
  }
  return {
    recordingId: manifest.recordingId,
    directory: targetDirectory,
    events: lines.length,
    assetsIncluded: manifest.assets.filter(asset => asset.status === 'present').length,
    assetsExcluded: manifest.assets.filter(asset => asset.status === 'missing').length,
    reviewStatus: manifest.redaction.reviewed,
  };
}

// Record a human review verdict on an exported demo bundle. Only the demo
// manifest is touched; original bundles never carry review state.
function markDemoReview(directory, { status, note = null }) {
  const manifestPath = path.join(directory, BUNDLE_FILES.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.redaction?.applied)
    throw Error('review status applies to demo copies only (redaction not applied)');
  if (!['unreviewed', 'approved', 'changes-requested'].includes(status))
    throw Error(`unknown review status: ${status}`);
  manifest.redaction.reviewed = status;
  manifest.redaction.reviewNote = note;
  manifest.redaction.reviewedAt = new Date().toISOString();
  const temp = `${manifestPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temp, manifestPath);
  const errors = validateBundle(directory);
  if (errors.length > 0)
    throw Error(
      `demo bundle failed validation after review: ${errors.map(error => error.code).join(', ')}`,
    );
  return manifest.redaction;
}

module.exports = { exportDemoBundle, markDemoReview };
