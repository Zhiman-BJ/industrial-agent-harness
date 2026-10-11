'use strict';

// Bundle description for replay UI (#105): explicit status, outcome, and
// gaps so the interface can always say "录制回放" and surface missing
// material honestly instead of hiding or repairing it.

function describeBundle(bundle) {
  const manifest = bundle?.manifest;
  if (!manifest) throw Error('describeBundle requires a loaded bundle');
  return {
    kind: 'recording-replay',
    recordingId: manifest.recordingId,
    status: manifest.status,
    outcome: manifest.outcome,
    interruptedUnmarked: manifest.interruptedUnmarked === true,
    isDemo: manifest.redaction?.applied === true,
    reviewStatus: manifest.redaction?.reviewed ?? 'unreviewed',
    events: bundle.events.length,
    turns: [...new Set(bundle.events.map(record => record.origin?.turnId).filter(Boolean))],
    initialTurns: manifest.chat?.initialSnapshot?.turns ?? [],
    gaps: {
      missingAssets: bundle.missingAssets ?? [],
      warnings: bundle.warnings ?? [],
      incomplete: manifest.status === 'incomplete',
      incompleteReason: manifest.status === 'incomplete' ? manifest.incompleteReason : null,
    },
    assets: (manifest.assets ?? []).map(asset => ({
      id: asset.id,
      type: asset.type,
      status: asset.status,
    })),
  };
}

module.exports = { describeBundle };
