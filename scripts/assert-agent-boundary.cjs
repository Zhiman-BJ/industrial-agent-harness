const assert = require('node:assert/strict');

// Verify the reported production launcher boundary without requiring the old
// current-user-only mode. A fallback may never claim OS or socket isolation.
function assertAgentBoundary(boundary, { platform = process.platform, arch = process.arch } = {}) {
  assert.ok(boundary, 'The production launcher must report its execution boundary.');
  const isolated = platform === 'darwin' ? 'seatbelt' : platform === 'linux' ? 'bubblewrap' : null;
  assert.ok(
    boundary.mechanism === 'current-user' || (isolated && boundary.mechanism === isolated),
    `Unexpected ${platform} execution mechanism: ${boundary.mechanism}`,
  );
  assert.equal(boundary.osIsolation, boundary.mechanism !== 'current-user');
  assert.equal(boundary.projectWritable, true);
  if (boundary.mechanism === 'bubblewrap' && ['x64', 'arm64'].includes(arch))
    assert.equal(boundary.unixSocketsFiltered, true);
  if (boundary.mechanism === 'current-user')
    assert.equal(boundary.unixSocketsFiltered ?? false, false);
}

module.exports = { assertAgentBoundary };
