'use strict';

// Source-time to display-time mapping (#105): preserves event order and
// relative pacing while compressing long idle gaps (e.g. a 3-minute wait for
// a native tool run) down to a fixed display cap so demos stay watchable.

const DEFAULT_COMPRESSION = { thresholdMs: 5000, capMs: 1500 };

function normalizeCompression(compression = {}) {
  const merged = { ...DEFAULT_COMPRESSION, ...compression };
  for (const key of ['thresholdMs', 'capMs']) {
    const value = merged[key];
    // Infinity is a valid threshold (disables compression entirely).
    if (!(value > 0)) throw Error(`compression.${key} must be a positive number`);
  }
  if (!Number.isFinite(merged.capMs))
    throw Error(
      'compression.capMs must be finite (use an Infinite thresholdMs to disable compression)',
    );
  if (merged.capMs > merged.thresholdMs)
    throw Error('compression.capMs must not exceed thresholdMs (compression only shrinks waits)');
  return merged;
}

// Build the mapping once per recording. Points keep both clocks so the UI can
// show original timestamps while playing at compressed pace. The lead-in
// before the first event is a gap like any other: it compresses under the
// same threshold/cap rule and stays raw when compression is off — a raw view
// must never silently drop recorded time.
function buildTimeline(records, compression) {
  const { thresholdMs, capMs } = normalizeCompression(compression);
  const points = [];
  let displayMs = 0;
  let previousSourceMs = 0;
  for (let index = 0; index < records.length; index++) {
    const sourceMs = records[index].relMs;
    const gap = Math.max(0, sourceMs - previousSourceMs);
    displayMs += gap > thresholdMs ? capMs : gap;
    previousSourceMs = sourceMs;
    points.push({ seq: records[index].seq, index, sourceMs, displayMs });
  }
  return {
    compression: { thresholdMs, capMs },
    points,
    durationMs: points.length ? points[points.length - 1].displayMs : 0,
    // How many records are revealed at a display time.
    positionAt(displayTime) {
      // Upper bound preserves all equal-timestamp events while avoiding a
      // scan from zero on every playback tick and source-clock lookup.
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (points[middle].displayMs <= displayTime) low = middle + 1;
        else high = middle;
      }
      return low;
    },
    // Original (source) time of the newest revealed record; 0 when none.
    sourceAt(displayTime) {
      const position = this.positionAt(displayTime);
      return position === 0 ? 0 : points[position - 1].sourceMs;
    },
    displayAt(position) {
      if (position <= 0) return 0;
      return points[Math.min(position, points.length) - 1].displayMs;
    },
  };
}

module.exports = { buildTimeline, DEFAULT_COMPRESSION };
