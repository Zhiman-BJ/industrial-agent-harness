// Shared expectation for the execution-boundary event that a real CLI or
// KimiSession launch reports on the current host: the launch is OS-isolated
// when the platform offers a verified primitive (Seatbelt on macOS,
// bubblewrap on Linux) and falls back to the plain current-user launcher
// otherwise. projectWritable is true under both models — the workspace-write
// boundary keeps the engineering project writable either way.
const { detectIsolation } = require('../../../packages/agent-kimi/src/agent-isolation.cjs');

function hostBoundary() {
  const layer = detectIsolation(process.platform, process.env);
  return layer
    ? { mechanism: layer.mechanism, osIsolation: true }
    : { mechanism: 'current-user', osIsolation: false };
}

// Accepts either a JSONL row (row.event) or a bare session event.
function boundaryMatches(row) {
  const event = row?.event ?? row;
  const expected = hostBoundary();
  return (
    event?.type === 'execution-boundary' &&
    event.mechanism === expected.mechanism &&
    event.osIsolation === expected.osIsolation &&
    event.projectWritable === true
  );
}

module.exports = { hostBoundary, boundaryMatches };
