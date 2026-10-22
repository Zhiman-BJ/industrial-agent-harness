const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAgentBoundary } = require('../../scripts/assert-agent-boundary.cjs');
const { isRejectedToolResult } = require('../integration/fixtures/domain-mcp-model.cjs');

test('release fixture distinguishes a policy diagnostic from actual denied or rejected tools', () => {
  assert.equal(
    isRejectedToolResult({
      content: JSON.stringify({
        actionStatus: 'completed',
        diagnostics: ['agent_docker_access: intentionally_denied'],
      }),
    }),
    false,
  );
  assert.equal(
    isRejectedToolResult({
      content: JSON.stringify({
        actionStatus: 'completed',
        diagnostics: [JSON.stringify({ agent_docker_access: 'intentionally_denied' })],
      }),
    }),
    false,
  );
  for (const content of [
    'The tool call is rejected by the user',
    'Permission denied',
    'Tool execution rejected',
    { error: 'Access denied' },
    { error: 'permission_denied' },
    { error: 'scope_denied' },
    { error: 'intentionally_denied' },
    { permission_denied: true },
    { denied: true },
  ])
    assert.equal(isRejectedToolResult({ content }), true);
});

test('release fixture parses Kimi timing-wrapped MCP diagnostics without hiding real rejection', () => {
  const result = {
    actionStatus: 'completed',
    diagnostics: [JSON.stringify({ ready: true, agent_docker_access: 'intentionally_denied' })],
  };
  const wrapped = value => `Wall time: 0.846 seconds\n${JSON.stringify(value)}`;
  assert.equal(isRejectedToolResult({ content: wrapped(result) }), false);
  assert.equal(isRejectedToolResult({ content: [{ type: 'text', text: wrapped(result) }] }), false);
  for (const value of [
    { ...result, error: 'Permission denied' },
    { ...result, actionStatus: 'rejected' },
    { ...result, diagnostics: [...result.diagnostics, 'Tool execution rejected'] },
    { error: 'intentionally_denied' },
    { denied: true },
  ])
    assert.equal(isRejectedToolResult({ content: wrapped(value) }), true);
  for (const content of [
    'Wall time: 0.846 seconds\nPermission denied',
    `Permission denied\n${wrapped(result)}`,
    `${wrapped(result)}\nTool execution rejected`,
    'Wall time: 0.846 seconds\n{"error":"denied"',
  ])
    assert.equal(isRejectedToolResult({ content }), true);
});

test('release boundary checks require truthful isolation and platform/socket semantics', () => {
  const plain = {
    mechanism: 'current-user',
    osIsolation: false,
    projectWritable: true,
    unixSocketsFiltered: false,
  };
  const seatbelt = { ...plain, mechanism: 'seatbelt', osIsolation: true };
  const bwrap = { ...plain, mechanism: 'bubblewrap', osIsolation: true, unixSocketsFiltered: true };
  assertAgentBoundary(plain, { platform: 'win32' });
  assertAgentBoundary(
    { mechanism: 'current-user', osIsolation: false, projectWritable: true },
    { platform: 'win32' },
  );
  assertAgentBoundary(plain, { platform: 'linux' });
  assertAgentBoundary(seatbelt, { platform: 'darwin' });
  assertAgentBoundary(bwrap, { platform: 'linux', arch: 'x64' });
  assert.throws(() => assertAgentBoundary({ ...plain, osIsolation: true }, { platform: 'win32' }));
  assert.throws(() => assertAgentBoundary(bwrap, { platform: 'win32' }));
  assert.throws(() =>
    assertAgentBoundary(
      { ...bwrap, unixSocketsFiltered: false },
      { platform: 'linux', arch: 'arm64' },
    ),
  );
  assert.throws(() =>
    assertAgentBoundary({ ...seatbelt, projectWritable: false }, { platform: 'darwin' }),
  );
});
